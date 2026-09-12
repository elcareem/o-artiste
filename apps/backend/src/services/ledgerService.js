/**
 * The append-only financial ledger — docs/01-DATA-MODEL.md §5, issue #19.
 *
 * Booking state tells you where a booking ended up. The ledger tells you how
 * the money got there, which is the question a client, an artist or a regulator
 * actually asks months later.
 *
 * THREE PROPERTIES MAKE IT EVIDENCE RATHER THAN A LOG:
 *
 * 1. APPEND-ONLY. There is no update and no delete path, here or anywhere else
 *    — `npm run check:rules` greps the whole backend for one. A ledger you can
 *    edit is not evidence of anything.
 *
 * 2. WRITTEN IN THE SAME TRANSACTION as the state change they accompany. This
 *    is enforced structurally, not by convention: `record` REFUSES the base
 *    Prisma client and accepts only an interactive transaction client. A
 *    reviewer cannot forget the rule, because forgetting it throws.
 *
 * 3. SIGNED FROM THE PARTY'S PERSPECTIVE, so a settled booking sums to exactly
 *    zero. That single invariant is the widest-catching financial check in the
 *    system — it fails if a fee is double-counted, a share is dropped, or a
 *    rounding residual goes to the wrong side.
 *
 * The figures are never passed in. Every composite recorder calls
 * `feeService` itself, from the booking's own frozen snapshot, so ledger
 * entries cannot drift from the arithmetic the rest of the system uses. The
 * fee service is pure, so computing twice and moving money once is free.
 */

const prisma = require('../lib/prisma');
const { AppError } = require('../lib/errors');
const {
  computeCompletion,
  computeClientCancellation,
  computeArtistCancellation,
} = require('./feeService');

/**
 * Appends one entry. The single write path — every other function here funnels
 * through it, and nothing outside this module may call `prisma.ledgerEntry`.
 *
 * `tx` MUST be an interactive transaction client. An entry written outside the
 * transaction that carries its state change is exactly the reconciliation
 * failure the ledger exists to make impossible: it survives a rollback that
 * discards the state change, or is lost by a rollback that keeps it.
 */
async function record(tx, { bookingId, entryType, party, amountKobo, description, offsetsEntryId }) {
  assertTransactionClient(tx);

  if (!bookingId) throw new AppError(500, 'A ledger entry must reference a booking.');
  if (!Number.isInteger(amountKobo)) {
    throw new TypeError(`Ledger amountKobo must be an integer of kobo, received: ${String(amountKobo)}`);
  }
  if (amountKobo === 0) {
    // An entry that moves nothing records nothing. Composite recorders drop
    // zero-value legs before reaching here (a 0 bps commission, a waived fee),
    // so arriving with a zero means a caller computed something wrong.
    throw new AppError(500, `A ledger entry cannot be for zero kobo (${entryType}/${party}).`);
  }

  return tx.ledgerEntry.create({
    data: { bookingId, entryType, party, amountKobo, description, offsetsEntryId },
  });
}

/**
 * The Prisma interactive transaction client omits `$transaction`, `$connect`
 * and friends; the base client has them. That difference is what lets us tell a
 * real transaction from the singleton without asking the caller to assert it.
 */
function assertTransactionClient(tx) {
  if (!tx || typeof tx.ledgerEntry?.create !== 'function') {
    throw new AppError(500, 'Ledger writes require a Prisma client.');
  }
  if (typeof tx.$transaction === 'function') {
    throw new AppError(
      500,
      'Ledger entries must be written inside the transaction that carries their state change (docs/01 §5). ' +
        'Pass the transaction client from prisma.$transaction, not the base client.'
    );
  }
}

/** Writes a list of legs, skipping those that move nothing. */
async function appendAll(tx, bookingId, legs) {
  const written = [];
  for (const leg of legs) {
    if (leg.amountKobo === 0) continue;
    written.push(await record(tx, { bookingId, ...leg }));
  }
  return written;
}

// ── Composite recorders — one per money movement ─────────────────────────────

/**
 * Funding — the client's money arrives and sits in escrow (#20's
 * `escrow.funded`).
 *
 * The client parts with the booking amount PLUS the provider's money-in fee,
 * which the provider charges the payer at funding and never places in escrow
 * (docs/05 §1). Both facts are recorded: the full outflow against the client,
 * and the fee against the provider who received it.
 *
 * After this leg the ledger sums to −amountKobo, which is correct and
 * meaningful — that is the money sitting in escrow, not yet distributed.
 */
async function recordFunding(tx, booking) {
  const { clientPaysKobo, moneyInFeeKobo } = completionFor(booking);

  return appendAll(tx, booking.id, [
    {
      entryType: 'FUNDED',
      party: 'CLIENT',
      amountKobo: -clientPaysKobo,
      description: 'Client funded escrow, including the provider money-in fee',
    },
    {
      entryType: 'ESCROW_FEE_IN',
      party: 'PROVIDER',
      amountKobo: moneyInFeeKobo,
      description: 'Provider money-in fee, charged to the payer at funding',
    },
  ]);
}

/**
 * Release on completion (#26) — the escrow is distributed.
 *
 * The payout fee is written as a PAIR, platform out and provider in, because it
 * moves value between two parties who are both already on the ledger. Netting
 * it into the commission line would balance just as well and would hide what
 * the platform's take actually was before costs.
 */
async function recordRelease(tx, booking) {
  const { commissionKobo, moneyOutFeeKobo, artistNetKobo } = completionFor(booking);

  return appendAll(tx, booking.id, [
    {
      entryType: 'COMMISSION',
      party: 'PLATFORM',
      amountKobo: commissionKobo,
      description: `Platform commission at ${booking.commissionRateBpsSnapshot} bps (snapshot)`,
    },
    {
      entryType: 'ESCROW_FEE_OUT',
      party: 'PLATFORM',
      amountKobo: -moneyOutFeeKobo,
      description: 'Provider payout fee, borne by the platform',
    },
    {
      entryType: 'ESCROW_FEE_OUT',
      party: 'PROVIDER',
      amountKobo: moneyOutFeeKobo,
      description: 'Provider payout fee, received by the provider',
    },
    {
      entryType: 'RELEASED',
      party: 'ARTIST',
      amountKobo: artistNetKobo,
      description: 'Released to the artist on completion',
    },
  ]);
}

/**
 * Client-initiated cancellation (#27) — the escrow splits by the snapshot tier.
 *
 * The money-in fee the client paid at funding is NOT reversed: it is consumed,
 * and the client bearing it is part of what it means for the cancellation to be
 * theirs (docs/05 §6). So it needs no entry here — the negative written at
 * funding already stands, and the provider's credit stands opposite it.
 */
async function recordClientCancellation(tx, booking, tier) {
  const c = computeClientCancellation({
    amountKobo: booking.amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
    clientRefundBps: tier.clientRefundBps,
    artistCompensationBps: tier.artistCompensationBps,
  });

  return appendAll(tx, booking.id, [
    {
      entryType: 'REFUNDED',
      party: 'CLIENT',
      amountKobo: c.clientRefundKobo,
      description: `Refund at ${tier.clientRefundBps} bps (snapshot tier)`,
    },
    {
      entryType: 'ARTIST_COMPENSATION',
      party: 'ARTIST',
      amountKobo: c.artistCompensationKobo,
      description: 'Artist compensation for a client cancellation, net of commission',
    },
    {
      entryType: 'COMMISSION',
      party: 'PLATFORM',
      amountKobo: c.commissionKobo,
      description: `Platform commission on the artist's share at ${booking.commissionRateBpsSnapshot} bps`,
    },
    {
      entryType: 'ESCROW_FEE_OUT',
      party: 'PLATFORM',
      amountKobo: -c.moneyOutFeeKobo,
      description: 'Provider payout fee on the refund leg, borne by the platform',
    },
    {
      entryType: 'ESCROW_FEE_OUT',
      party: 'PROVIDER',
      amountKobo: c.moneyOutFeeKobo,
      description: 'Provider payout fee on the refund leg',
    },
  ]);
}

/**
 * Artist-initiated cancellation (#28) — the client is made whole and the
 * platform fronts the fees.
 *
 * ZERO FEE EXPOSURE FOR THE CLIENT MEANS ZERO. They get the escrow back AND the
 * money-in fee they paid at funding, so the reimbursement is written as a pair:
 * a credit to the client reversing their funding-time cost, and the matching
 * debit against the platform that actually pays it.
 *
 * The liability against the artist is likewise a balanced pair, so it does not
 * disturb reconciliation — which is right, because an accrued debt has moved no
 * money yet. It moves at `recordFeeLiabilitySettlement`, on whichever later
 * booking pays it off.
 */
async function recordArtistCancellation(tx, booking) {
  const c = computeArtistCancellation({ amountKobo: booking.amountKobo });

  return appendAll(tx, booking.id, [
    {
      entryType: 'REFUNDED',
      party: 'CLIENT',
      amountKobo: c.clientRefundKobo,
      description: 'Full refund for an artist cancellation',
    },
    {
      entryType: 'ESCROW_FEE_IN',
      party: 'CLIENT',
      amountKobo: c.clientFeeReimbursementKobo,
      description: 'Money-in fee reimbursed to the client — zero fee exposure',
    },
    {
      entryType: 'ESCROW_FEE_IN',
      party: 'PLATFORM',
      amountKobo: -c.clientFeeReimbursementKobo,
      description: 'Money-in fee reimbursement fronted by the platform',
    },
    {
      entryType: 'ESCROW_FEE_OUT',
      party: 'PLATFORM',
      amountKobo: -c.moneyOutFeeKobo,
      description: 'Provider payout fee on the refund leg, fronted by the platform',
    },
    {
      entryType: 'ESCROW_FEE_OUT',
      party: 'PROVIDER',
      amountKobo: c.moneyOutFeeKobo,
      description: 'Provider payout fee on the refund leg',
    },
    {
      entryType: 'FEE_LIABILITY_ACCRUED',
      party: 'ARTIST',
      amountKobo: -c.feeLiabilityKobo,
      description: 'Fee liability accrued against the artist for their cancellation',
    },
    {
      entryType: 'FEE_LIABILITY_ACCRUED',
      party: 'PLATFORM',
      amountKobo: c.feeLiabilityKobo,
      description: 'Fee liability receivable, fronted by the platform',
    },
  ]);
}

/**
 * Settlement of an outstanding fee liability against a payout (#26).
 *
 * Recorded on the booking whose payout settles it, not on the booking that
 * accrued it — that booking's money movement is finished, and the ledger
 * records what happened where it happened. Both sides of the pair are written,
 * so each booking still reconciles to zero on its own.
 */
async function recordFeeLiabilitySettlement(tx, bookingId, settledKobo) {
  return appendAll(tx, bookingId, [
    {
      entryType: 'FEE_LIABILITY_SETTLED',
      party: 'ARTIST',
      amountKobo: -settledKobo,
      description: 'Outstanding fee liability netted off this payout',
    },
    {
      entryType: 'FEE_LIABILITY_SETTLED',
      party: 'PLATFORM',
      amountKobo: settledKobo,
      description: 'Fee liability recovered from the artist',
    },
  ]);
}

/**
 * Reverses an entry by writing its exact negation — never by editing it.
 *
 * The original stays visible, because the sequence (charged, then reversed, and
 * why) is the record that matters. A reversal alone leaves the booking out of
 * balance by design: it is the caller's job to write the corrected entries, and
 * `reconcile` failing in between is the ledger reporting an incomplete
 * correction rather than hiding one.
 */
async function recordCorrection(tx, { offsetsEntryId, reason }) {
  assertTransactionClient(tx);

  if (!reason) throw new AppError(500, 'A correction must state its reason.');

  const original = await tx.ledgerEntry.findUnique({ where: { id: offsetsEntryId } });
  if (!original) throw new AppError(404, 'The entry being corrected does not exist.');
  if (original.entryType === 'CORRECTION') {
    throw new AppError(409, 'A correction cannot itself be corrected. Offset the original entry.');
  }

  const already = await tx.ledgerEntry.findFirst({ where: { offsetsEntryId } });
  if (already) throw new AppError(409, 'That entry has already been corrected.');

  return record(tx, {
    bookingId: original.bookingId,
    entryType: 'CORRECTION',
    party: original.party,
    amountKobo: -original.amountKobo,
    description: `Reverses ${original.entryType} — ${reason}`,
    offsetsEntryId,
  });
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Sums a booking's entries and reports whether it balances.
 *
 * Reads through the base client by default: reconciliation is a query, not a
 * money movement, and #40's e2e script calls it outside any transaction.
 */
async function reconcile(bookingId, client = prisma) {
  const entries = await client.ledgerEntry.findMany({
    where: { bookingId },
    orderBy: { createdAt: 'asc' },
  });

  const byParty = { CLIENT: 0, ARTIST: 0, PLATFORM: 0, PROVIDER: 0 };
  let sumKobo = 0;
  for (const e of entries) {
    byParty[e.party] += e.amountKobo;
    sumKobo += e.amountKobo;
  }

  return { bookingId, entryCount: entries.length, sumKobo, balanced: sumKobo === 0, byParty, entries };
}

/**
 * Throws unless the booking balances — for callers that must not proceed past
 * an unbalanced ledger.
 */
async function assertBalanced(bookingId, client = prisma) {
  const result = await reconcile(bookingId, client);
  if (!result.balanced) {
    throw new AppError(
      500,
      `Ledger for booking ${bookingId} does not reconcile: sums to ${result.sumKobo} kobo, expected 0.`
    );
  }
  return result;
}

/** The completion arithmetic, from the booking's own frozen snapshot. */
function completionFor(booking) {
  return computeCompletion({
    amountKobo: booking.amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
  });
}

module.exports = {
  record,
  recordFunding,
  recordRelease,
  recordClientCancellation,
  recordArtistCancellation,
  recordFeeLiabilitySettlement,
  recordCorrection,
  reconcile,
  assertBalanced,
};
