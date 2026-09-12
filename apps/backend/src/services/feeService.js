/**
 * Fee computation — docs/05-CANCELLATIONS-AND-FEES.md.
 *
 * EVERY money number in this system originates here, so it is deliberately
 * PURE: no database, no network, no clock. Its behaviour is fully verifiable in
 * unit tests rather than only observable through integration, and #26 and #27
 * call it rather than reimplementing any of it.
 *
 * All inputs and outputs are integer kobo. No floats reach any calculation.
 *
 * THE TWO ROUNDING RULES (docs/05 §4), applied everywhere without exception:
 *
 *   R1 — Percentage computations FLOOR:
 *        floor((base * bps) / 10000), in integer arithmetic.
 *
 *   R2 — The residual party absorbs the remainder:
 *        the LAST share in any split is `total − sum(previous shares)`, never
 *        computed from its own basis points. The parts then sum to the total by
 *        construction rather than by luck.
 *
 * Without R2, flooring both sides of a 7000/3000 split can lose a kobo. Over
 * thousands of bookings a silently discarded kobo is a ledger that does not
 * reconcile — and #19 asserts that every booking sums to exactly zero.
 */

const BPS_DENOMINATOR = 10000;

// --- EscrowPay money-in: 1.5% + ₦100, capped at ₦2,000 up to ₦250,000;
//     0.8% uncapped above. docs/05 §1.
const MONEY_IN_THRESHOLD_KOBO = 25000000; // ₦250,000
const MONEY_IN_LOW_BPS = 150; // 1.5%
const MONEY_IN_FLAT_KOBO = 10000; // ₦100
const MONEY_IN_CAP_KOBO = 200000; // ₦2,000
const MONEY_IN_HIGH_BPS = 80; // 0.8%

// --- EscrowPay money-out: ₦40 up to ₦50,000; ₦70 above.
const MONEY_OUT_THRESHOLD_KOBO = 5000000; // ₦50,000
const MONEY_OUT_LOW_KOBO = 4000; // ₦40
const MONEY_OUT_HIGH_KOBO = 7000; // ₦70

/**
 * Whether a refund leg to the client incurs the money-out fee.
 *
 * OPEN ITEM — docs/00 §11. EscrowPay has not confirmed it. Implemented as a
 * flag defaulting to CHARGED, which is the conservative assumption: if we
 * assume it is free and it is not, every refund is short by ₦40–₦70 and the
 * platform silently absorbs it.
 */
const REFUND_INCURS_MONEY_OUT_DEFAULT = true;

/** R1. The only place a percentage is applied. */
function applyBps(baseKobo, bps) {
  assertInteger(baseKobo, 'baseKobo');
  assertInteger(bps, 'bps');
  // Integer arithmetic throughout — no float division, no Math.round, no
  // toFixed. `Math.floor` on an already-integer quotient is belt and braces.
  return Math.floor((baseKobo * bps) / BPS_DENOMINATOR);
}

/** EscrowPay's fee for money coming in. */
function moneyInFee(amountKobo) {
  assertInteger(amountKobo, 'amountKobo');

  if (amountKobo > MONEY_IN_THRESHOLD_KOBO) {
    // Uncapped above the threshold.
    return applyBps(amountKobo, MONEY_IN_HIGH_BPS);
  }

  const uncapped = applyBps(amountKobo, MONEY_IN_LOW_BPS) + MONEY_IN_FLAT_KOBO;
  return Math.min(uncapped, MONEY_IN_CAP_KOBO);
}

/** EscrowPay's fee for money going out. */
function moneyOutFee(payoutKobo) {
  assertInteger(payoutKobo, 'payoutKobo');
  return payoutKobo > MONEY_OUT_THRESHOLD_KOBO ? MONEY_OUT_HIGH_KOBO : MONEY_OUT_LOW_KOBO;
}

/**
 * A completed booking: the artist bears commission and both escrow fees.
 *
 * Order matters. Commission is taken from the booking total (the artist's gross
 * share on a completion), then escrow fees. The artist is the residual party,
 * so their net is computed by subtraction — R2 — which makes the parts sum to
 * the total by construction.
 */
function computeCompletion({ amountKobo, commissionBps }) {
  assertInteger(amountKobo, 'amountKobo');
  assertInteger(commissionBps, 'commissionBps');

  const moneyIn = moneyInFee(amountKobo);
  const commission = applyBps(amountKobo, commissionBps);

  // The money-out fee depends on the payout size, which depends on the fee —
  // so it is computed against the amount remaining before it is deducted.
  const beforeMoneyOut = amountKobo - moneyIn - commission;
  const moneyOut = moneyOutFee(beforeMoneyOut);

  // R2: the artist absorbs the remainder.
  const artistNet = amountKobo - moneyIn - commission - moneyOut;

  return {
    amountKobo,
    commissionKobo: commission,
    moneyInFeeKobo: moneyIn,
    moneyOutFeeKobo: moneyOut,
    artistNetKobo: artistNet,
    feeBearer: 'ARTIST',
    parts: [
      { party: 'PLATFORM', kobo: commission },
      { party: 'PROVIDER', kobo: moneyIn },
      { party: 'PROVIDER', kobo: moneyOut },
      { party: 'ARTIST', kobo: artistNet },
    ],
  };
}

/**
 * A client-initiated cancellation — docs/05 §6.
 *
 * The CLIENT bears all escrow fees: they are the at-fault party. The artist's
 * compensation is untouched by fees — they have already lost a date they cannot
 * refill, and deducting a flat processing cost from a reduced compensation
 * payment would penalise them twice for someone else's decision. Only the
 * snapshot commission applies to their share.
 *
 * The refund FLOORS AT ZERO and is never negative. Fees can exceed a small
 * refund; the shortfall is not recovered from anyone, because building
 * collection logic for a sub-₦2,000 gap costs more than the gap. It must be
 * shown before the client commits (#30), not discovered afterwards.
 */
function computeClientCancellation({
  amountKobo,
  commissionBps,
  clientRefundBps,
  artistCompensationBps,
  refundIncursMoneyOut = REFUND_INCURS_MONEY_OUT_DEFAULT,
}) {
  assertInteger(amountKobo, 'amountKobo');
  assertBpsPairSums(clientRefundBps, artistCompensationBps);

  // R1 on the client's share; R2 gives the artist the remainder, so the two
  // shares sum to the booking total exactly. Computing both from their own bps
  // is precisely what loses a kobo.
  const clientShare = applyBps(amountKobo, clientRefundBps);
  const artistShare = amountKobo - clientShare;

  const moneyIn = moneyInFee(amountKobo);
  const moneyOut = refundIncursMoneyOut && clientShare > 0 ? moneyOutFee(clientShare) : 0;
  const escrowFees = moneyIn + moneyOut;

  // The client bears the fees, floored at zero.
  const refundBeforeFloor = clientShare - escrowFees;
  const clientRefund = Math.max(0, refundBeforeFloor);
  const unrecoveredShortfall = Math.max(0, -refundBeforeFloor);

  // The artist's compensation is reduced only by commission.
  const commission = applyBps(artistShare, commissionBps);
  const artistCompensation = artistShare - commission;

  return {
    amountKobo,
    clientShareKobo: clientShare,
    artistShareKobo: artistShare,
    moneyInFeeKobo: moneyIn,
    moneyOutFeeKobo: moneyOut,
    escrowFeesKobo: escrowFees,
    clientRefundKobo: clientRefund,
    /** Absorbed by the platform, never chased. Shown to nobody as a debt. */
    unrecoveredShortfallKobo: unrecoveredShortfall,
    commissionKobo: commission,
    artistCompensationKobo: artistCompensation,
    feeBearer: 'CLIENT',
  };
}

/**
 * An artist-initiated cancellation — docs/05 §7.
 *
 * The client receives 100%, with ZERO fee exposure. They did nothing wrong, and
 * passing them any cost for the artist's decision would undermine the guarantee
 * the platform is built on.
 *
 * That leaves the fees with nobody to deduct from: the client's payment is the
 * only money in the transaction and all of it is going back. The platform
 * fronts them and records a FeeLiability against the artist, settled against
 * their next payout (#26) or written off.
 */
function computeArtistCancellation({
  amountKobo,
  refundIncursMoneyOut = REFUND_INCURS_MONEY_OUT_DEFAULT,
}) {
  assertInteger(amountKobo, 'amountKobo');

  const moneyIn = moneyInFee(amountKobo);
  const moneyOut = refundIncursMoneyOut ? moneyOutFee(amountKobo) : 0;

  return {
    amountKobo,
    // The full amount. Not "the amount minus fees".
    clientRefundKobo: amountKobo,
    moneyInFeeKobo: moneyIn,
    moneyOutFeeKobo: moneyOut,
    /** Fronted by the platform now, recovered from the artist later. */
    feeLiabilityKobo: moneyIn + moneyOut,
    artistCompensationKobo: 0,
    commissionKobo: 0,
    feeBearer: 'ARTIST',
  };
}

/**
 * Settles outstanding fee liabilities against a payout — #26.
 *
 * Netted off before disbursing, because a release is the only moment an artist
 * has money in the system to settle against. Floors at zero: a liability larger
 * than the payout leaves a remainder outstanding rather than a negative payout.
 */
function applyFeeLiabilities({ payoutKobo, liabilitiesKobo }) {
  assertInteger(payoutKobo, 'payoutKobo');
  assertInteger(liabilitiesKobo, 'liabilitiesKobo');

  const settled = Math.min(payoutKobo, liabilitiesKobo);
  return {
    payoutKobo: payoutKobo - settled,
    settledKobo: settled,
    remainingLiabilityKobo: liabilitiesKobo - settled,
  };
}

function assertInteger(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer number of kobo, received: ${String(value)}`);
  }
}

function assertBpsPairSums(a, b) {
  assertInteger(a, 'clientRefundBps');
  assertInteger(b, 'artistCompensationBps');
  if (a + b !== BPS_DENOMINATOR) {
    throw new RangeError(
      `A cancellation split must sum to ${BPS_DENOMINATOR} basis points, received ${a} + ${b} = ${a + b}.`
    );
  }
}

module.exports = {
  applyBps,
  moneyInFee,
  moneyOutFee,
  computeCompletion,
  computeClientCancellation,
  computeArtistCancellation,
  applyFeeLiabilities,
  BPS_DENOMINATOR,
  MONEY_IN_THRESHOLD_KOBO,
  MONEY_IN_CAP_KOBO,
  MONEY_OUT_THRESHOLD_KOBO,
  MONEY_OUT_LOW_KOBO,
  MONEY_OUT_HIGH_KOBO,
  REFUND_INCURS_MONEY_OUT_DEFAULT,
};
