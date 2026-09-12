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
 * A completed booking.
 *
 * FEE BEARERS FOLLOW THE PROVIDER'S LIVE CONFIGURATION, not our original spec.
 * Read from `GET /fees/configuration` on the test book:
 *
 *   escrow_service (money-in)  payer: "payer"     timing: "at_funding"
 *   payout         (money-out) payer: "business"  timing: "at_payout"
 *
 * So the CLIENT pays the money-in fee **on top of** the booking amount when
 * funding, and the PLATFORM absorbs the payout fee. Neither is deducted from
 * the escrow, which holds exactly the booking amount.
 *
 * `docs/05` originally had the artist bearing both, deducted on completion.
 * That was written from the published fee schedule before the sandbox existed
 * and is wrong about the bearers — the provider was already behaving this way.
 * Changed by decision after the conflict was found at #18 rather than adjusted
 * silently; see `docs/05` §1.
 *
 * The artist is still the residual party (R2): their net is computed by
 * subtraction so the parts reconcile by construction.
 */
function computeCompletion({ amountKobo, commissionBps }) {
  assertInteger(amountKobo, 'amountKobo');
  assertInteger(commissionBps, 'commissionBps');

  // Charged to the client at funding, in addition to the amount. It never
  // enters escrow, so it is never ours to deduct.
  const moneyIn = moneyInFee(amountKobo);
  const clientPays = amountKobo + moneyIn;

  const commission = applyBps(amountKobo, commissionBps);

  // R2: the artist takes what remains of the escrow after commission.
  const artistNet = amountKobo - commission;

  // Borne by us, at payout. It reduces the platform's take rather than the
  // artist's payment.
  const moneyOut = moneyOutFee(artistNet);
  const platformNet = commission - moneyOut;

  return {
    amountKobo,
    /** What the client actually transfers — amount PLUS the money-in fee. */
    clientPaysKobo: clientPays,
    commissionKobo: commission,
    moneyInFeeKobo: moneyIn,
    moneyOutFeeKobo: moneyOut,
    artistNetKobo: artistNet,
    platformNetKobo: platformNet,
    moneyInBearer: 'CLIENT',
    moneyOutBearer: 'PLATFORM',
    commissionBearer: 'ARTIST',
    /**
     * Reconciles against what the CLIENT PAYS, not against the booking amount,
     * because the money-in fee is part of the client's outflow but never part
     * of the escrow.
     */
    parts: [
      { party: 'ARTIST', kobo: artistNet },
      { party: 'PLATFORM', kobo: platformNet },
      { party: 'PROVIDER', kobo: moneyIn + moneyOut },
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

  // The client already paid the money-in fee at funding, on top of the amount.
  // It is consumed and not refundable — which is itself the client bearing the
  // cost of their own cancellation, as docs/05 §6 intends.
  const moneyIn = moneyInFee(amountKobo);

  // The refund leg's payout fee falls on the platform under the provider's
  // configuration, so it does not reduce what the client receives.
  const moneyOut = refundIncursMoneyOut && clientShare > 0 ? moneyOutFee(clientShare) : 0;

  // The refund is the client's share of the escrow, undiminished. The floor
  // remains because a future tier set could still produce a zero share.
  const clientRefund = Math.max(0, clientShare);
  const unrecoveredShortfall = 0;

  // The artist's compensation is reduced only by commission.
  const commission = applyBps(artistShare, commissionBps);
  const artistCompensation = artistShare - commission;

  return {
    amountKobo,
    clientShareKobo: clientShare,
    artistShareKobo: artistShare,
    moneyInFeeKobo: moneyIn,
    moneyOutFeeKobo: moneyOut,
    /** Sunk at funding, borne by the client, not recoverable. */
    clientSunkFeeKobo: moneyIn,
    clientRefundKobo: clientRefund,
    unrecoveredShortfallKobo: unrecoveredShortfall,
    commissionKobo: commission,
    artistCompensationKobo: artistCompensation,
    moneyInBearer: 'CLIENT',
    moneyOutBearer: 'PLATFORM',
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
    // The escrow returns in full, and the client is additionally reimbursed the
    // money-in fee they paid at funding. ZERO fee exposure means zero: they did
    // nothing wrong, and passing them any cost for the artist's decision would
    // undermine the guarantee the platform is built on.
    clientRefundKobo: amountKobo,
    clientFeeReimbursementKobo: moneyIn,
    clientTotalReturnedKobo: amountKobo + moneyIn,
    moneyInFeeKobo: moneyIn,
    moneyOutFeeKobo: moneyOut,
    /**
     * Fronted by the platform now, recovered from the artist later. Covers the
     * money-in fee reimbursed to the client plus the payout fee on the refund
     * leg — the artist's decision, so the artist's cost.
     */
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
