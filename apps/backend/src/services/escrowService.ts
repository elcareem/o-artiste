/**
 * THE ONLY MODULE PERMITTED TO MOVE MONEY — docs/03-ESCROW-FLOW.md §5.
 *
 * Only this module may issue release or refund instructions to the provider.
 * No route handler, job or other service may call `lib/escrowpay.js`'s
 * money-moving methods directly, and `npm run check:rules` enforces it by grep.
 *
 * The constraint exists so that every money movement passes through one
 * auditable path. With three or four callers, verifying that all of them write
 * ledger entries, settle liabilities and read the snapshot correctly becomes a
 * code-review problem rather than a structural guarantee.
 *
 * #18 covers escrow creation and funding. Release and refund arrive at #26,
 * #27 and #28, in this same module.
 */

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const escrowpay = require('../lib/escrowpay.ts');
const { assertAcknowledged } = require('./acknowledgementService.ts');
const { assertCanTransact, assertTransition, transition } = require('./bookingService.ts');
const {
  moneyInFee,
  computeCompletion,
  computeClientCancellation,
  computeArtistCancellation,
  applyFeeLiabilities,
} = require('./feeService.ts');
const { applicableTier, daysBeforeEvent } = require('./cancellationService.ts');
const strikeService = require('./strikeService.ts');
const ledger = require('./ledgerService.ts');
const { recordAudit } = require('../lib/audit.ts');

/**
 * Creates the escrow for a booking and returns the bank transfer instruction.
 *
 * Three provider calls, in order:
 *   1. `POST /transactions`                    → draft
 *   2. `POST /transactions/{id}/activate`      → pending_funding
 *   3. `POST /transactions/{id}/checkout-sessions` → the funding instruction
 *
 * Each carries our `escrowReference` as the `Idempotency-Key`, so any of them
 * can be retried after a timeout without creating a second escrow.
 *
 * ON FAILURE THE BOOKING STAYS IN `PENDING_PAYMENT` WITH NO ESCROW ID
 * PERSISTED. A half-created booking is worse than a failed one: the client can
 * simply try again, and a retry reuses the same reference, so the provider
 * returns the original transaction rather than opening another.
 */
async function createEscrowForBooking({
  bookingId,
  clientUserId,
}: {
  bookingId: string;
  clientUserId: string;
}): Promise<FundingInstruction> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      client: { include: { user: true } },
      artist: { include: { user: true } },
    },
  });

  if (!booking || booking.client.userId !== clientUserId) {
    throw new AppError(404, 'Booking not found.');
  }

  // The disclosure gate from #16. Checked here as well as at the route, so a
  // future caller cannot reach escrow creation around it.
  await assertAcknowledged(booking.id);

  // RE-CHECKED AT FUNDING, not only at booking creation.
  //
  // Standing and verification are checked when the booking is made (#15), but
  // a booking can sit in PENDING_PAYMENT for days, and an artist can be
  // suspended or have their verification revoked in that window. Escrowing a
  // client's money to a beneficiary we have since suspended is the failure
  // #10's "an unverified artist cannot accept a booking" is really about — and
  // the booking-creation gate alone does not cover it.
  //
  // Refusing leaves the booking in PENDING_PAYMENT, which is right: the client
  // has not paid, and can cancel.
  assertCanTransact(booking.client.user, 'client');
  assertCanTransact(booking.artist.user, 'artist');

  if (booking.state !== 'PENDING_PAYMENT') {
    throw new AppError(409, 'This booking has already been paid for.');
  }

  // Idempotent at our level too: if the escrow already exists, return its
  // instruction rather than creating a second one.
  //
  // THE SESSION IS RE-FETCHED, NOT OMITTED. Bank transfer funding is
  // out-of-band: the client leaves to make the transfer and comes back, often
  // on another device, and the account number lives only on the checkout
  // session (see the masking note below). Returning the booking alone would
  // hand a returning client a funding page with nothing to pay into.
  //
  // The call carries the same `_checkout` idempotency key as the original, so
  // the provider returns THE SAME session rather than opening a second one with
  // a different destination account.
  if (booking.escrowId) {
    return withCheckoutSession(booking);
  }

  const payerPartyId = booking.client.user.escrowPartyId;
  const beneficiaryPartyId = booking.artist.user.escrowPartyId;

  if (!payerPartyId || !beneficiaryPartyId) {
    // Both sides verify at onboarding (#10), so this means an account that
    // predates verification or a data problem — not something a client can fix
    // by retrying.
    throw new AppError(
      409,
      !payerPartyId
        ? 'Verify your identity before paying for this booking.'
        : 'This artist cannot receive payments yet.'
    );
  }

  const reference = booking.escrowReference;

  // --- Provider calls. Nothing is persisted until all three succeed. -------
  const transaction = await escrowpay.createEscrow({
    reference,
    amountKobo: booking.amountKobo,
    payerPartyId,
    beneficiaryPartyId,
    description: `Booking ${booking.id}`,
    metadata: { bookingId: booking.id },
  });

  const activated = await escrowpay.activateEscrow({
    transactionId: transaction.id,
    version: transaction.version,
    reference: `${reference}_activate`,
  });

  const session = await escrowpay.createCheckoutSession({
    transactionId: transaction.id,
    reference: `${reference}_checkout`,
  });

  // --- Persist only now. -------------------------------------------------
  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: { escrowId: transaction.id },
  });

  return fundingInstructionFor(updated, session, activated);
}

/**
 * Shapes the funding instruction for the client portal.
 *
 * `amountToTransferKobo` is the amount the client must actually send, which is
 * the booking amount PLUS the provider's money-in fee — the provider charges it
 * to the payer at funding rather than deducting it from the escrow
 * (`docs/05` §1). Naming both figures separately is deliberate: #21 must show
 * the client what they are transferring and why it differs from the headline
 * price, rather than surprising them at their banking app.
 */
function fundingInstructionFor(
  booking: BookingRow,
  session?: CheckoutSession,
  activated?: ProviderTransaction
): FundingInstruction {
  const instructions = session?.payment_instructions;
  const feeKobo = moneyInFee(booking.amountKobo);

  return {
    bookingId: booking.id,
    escrowReference: booking.escrowReference,
    escrowId: booking.escrowId,
    state: booking.state,
    escrowState: activated?.status ?? null,

    bookingAmountKobo: booking.amountKobo,
    providerFeeKobo: feeKobo,
    amountToTransferKobo: instructions?.amount_minor ?? booking.amountKobo + feeKobo,

    // Bank transfer only. There is no card path in this system, and the
    // provider reports the same constraint from their side.
    channels: session?.allowed_channels ?? ['bank_transfer'],
    bankTransfer: instructions
      ? {
          accountNumber: instructions.account_number,
          accountName: instructions.account_name,
          bankCode: instructions.bank_code,
          provider: instructions.provider,
          expiresAt: instructions.expires_at,
        }
      : null,
  };
}

// ── Release — issue #26 ──────────────────────────────────────────────────────

/**
 * Releases a completed booking's funds to the artist.
 *
 * THE PROVIDER IS CALLED BEFORE ANYTHING IS RECORDED, and that order is
 * deliberate. The two failure modes are not equally bad:
 *
 *   Record first, then call  — a provider failure leaves a booking marked
 *     RELEASED with a ledger entry saying so and no money moved. The artist is
 *     not paid, the system believes they were, and nothing surfaces it until
 *     someone reconciles by hand.
 *
 *   Call first, then record  — a database failure leaves money moved and not
 *     yet recorded. A retry reuses the same idempotency key, so the provider
 *     returns the ORIGINAL release rather than paying twice, and the recording
 *     then succeeds. The failure is self-healing.
 *
 * Every figure comes from the booking's own frozen snapshot. None of this reads
 * live configuration — that is the whole point of #15's snapshot, and #26's
 * criterion about a booking created before a commission change depends on it.
 */
async function releaseBooking({
  bookingId,
  reason,
}: {
  bookingId: string;
  reason?: string;
}): Promise<ReleaseSummary> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { artist: { include: { user: true } } },
  });

  if (!booking) throw new AppError(404, 'Booking not found.');

  // Idempotent at our level: a booking already released returns what happened
  // rather than instructing a second release.
  if (booking.state === 'RELEASED') {
    return releaseSummaryFor(booking, { alreadyReleased: true });
  }

  // Checked before the provider call as well as inside the transaction below,
  // so an illegal release never reaches the provider in the first place.
  assertTransition(booking.state, 'RELEASED');

  if (!booking.escrowId) {
    throw new AppError(409, 'This booking was never funded, so there is nothing to release.');
  }
  if (!booking.artist.user.escrowPartyId) {
    throw new AppError(409, 'This artist cannot receive payments yet.');
  }

  // NOTE: account standing is deliberately NOT re-checked here, unlike at
  // funding. An artist suspended after performing has still performed, and
  // withholding money for an event that happened would be confiscation rather
  // than enforcement. Suspension governs future bookings; #33's strikes are the
  // mechanism for conduct.

  const completion = computeCompletion({
    amountKobo: booking.amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
  });

  const { liabilities, settledKobo } = await selectSettleableLiabilities({
    artistUserId: booking.artist.userId,
    payoutCeilingKobo: completion.artistNetKobo,
  });

  // feeService owns the arithmetic, including the floor — a liability larger
  // than the payout must never produce a negative disbursement.
  const settlement = applyFeeLiabilities({
    payoutKobo: completion.artistNetKobo,
    liabilitiesKobo: settledKobo,
  });

  // --- The irreversible step. ---------------------------------------------
  //
  // Only the artist's share leaves escrow. What remains is the platform's
  // commission, which is not the artist's money and must not be released to
  // them and clawed back.
  const release = await escrowpay.release({
    transactionId: booking.escrowId,
    reference: `${booking.escrowReference}_release`,
    amountKobo: settlement.payoutKobo,
    reason: reason ?? 'Event completed and confirmed by both parties',
  });

  // --- Recorded now, in ONE transaction with the state change. -------------
  const updated = await prisma.$transaction(async (tx: PrismaTx) => {
    const next = await transition({ bookingId: booking.id, to: 'RELEASED', client: tx });

    // Gross commission and the payout-fee pair, then the artist's full net.
    // The settlement below reduces the artist's position rather than being
    // netted into this figure, so the ledger shows what was earned AND what was
    // recovered instead of only the difference (docs/01 §5).
    await ledger.recordRelease(tx, booking);

    if (settlement.settledKobo > 0) {
      await ledger.recordFeeLiabilitySettlement(tx, booking.id, settlement.settledKobo);

      await tx.feeLiability.updateMany({
        where: { id: { in: liabilities.map((l) => l.id) } },
        data: {
          status: 'SETTLED',
          settledAgainstBookingId: booking.id,
          settledAt: new Date(),
        },
      });
    }

    return next;
  });

  // The pending auto-release is now moot. It would no-op anyway — it re-reads
  // the booking and stops on a settled state — so this is housekeeping, to keep
  // the queue a picture of what is actually outstanding.
  await require('../jobs/autoReleaseJob.ts').cancel(booking.id);

  // THE SECOND HALF OF THE MONEY-OUT LEG. `release` moved the escrow into OUR
  // wallet, because EscrowPay rejects automatic payout on this business. Until
  // this call the artist has not been paid.
  //
  // Deliberately AFTER the transaction and deliberately not thrown on: the
  // release has already happened and is recorded correctly, and turning a
  // payout problem into a failed release would roll back a movement that has
  // already left the escrow. A failure sets `payoutFailureReason` and leaves
  // `paidOutAt` null, which `payoutService.awaitingPayout` lists.
  const payout = await require('./payoutService.ts').payOut({
    bookingId: booking.id,
    amountKobo: settlement.payoutKobo,
    reason: `Payment for booking ${booking.id}`,
  });

  console.log(
    `[escrow] released ${settlement.payoutKobo} kobo to artist for booking ${booking.id}` +
      (settlement.settledKobo > 0 ? ` (${settlement.settledKobo} kobo of liability settled)` : '')
  );

  return releaseSummaryFor(updated, {
    completion,
    settlement,
    liabilities,
    providerReleaseId: release?.id ?? null,
    payout,
  });
}

/**
 * A client cancels — issue #27, docs/05 §5.
 *
 * THE ESCROW IS SPLIT, so there are two provider legs rather than one: the
 * client's tiered refund, and the artist's compensation for a date they can no
 * longer refill. Either can be zero — at seven days out the artist gets
 * nothing, and no tier gives the client nothing — and a zero leg is skipped
 * rather than sent as a zero-amount instruction.
 *
 * ORDER: THE ARTIST IS PAID FIRST. Both legs are retryable under stable
 * references, so a failure between them is recoverable either way. The order
 * matters for which party is left waiting on a retry, and the answer is the one
 * who did not choose this: the client asked to cancel and knows their money is
 * moving, while the artist is finding out that a booked date has evaporated.
 *
 * THE TIER COMES FROM THE BOOKING'S SNAPSHOT. A cancellation on a booking made
 * under an older table uses the older table — that is the whole point of #15.
 */
async function cancelByClient({
  bookingId,
  clientUserId,
  reason,
}: {
  bookingId: string;
  clientUserId: string;
  reason?: string;
}): Promise<CancellationSummary> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { client: true, artist: { include: { user: true } }, cancellation: true },
  });

  if (!booking) throw new AppError(404, 'Booking not found.');

  // 404, never 403 — confirming a booking exists is itself information.
  if (booking.client.userId !== clientUserId) throw new AppError(404, 'Booking not found.');

  if (booking.state === 'CANCELLED') {
    return cancellationSummaryFor(booking, { alreadyCancelled: true });
  }

  assertTransition(booking.state, 'CANCELLED');

  const { tier, daysBefore } = applicableTier(booking);

  // Never funded: nothing to split, nobody to pay. The booking is simply
  // withdrawn, and no tier applies to money that never moved.
  if (booking.state === 'PENDING_PAYMENT' || !booking.escrowId) {
    const withdrawn = await prisma.$transaction(async (tx: PrismaTx) => {
      const next = await transition({
        bookingId: booking.id,
        to: 'CANCELLED',
        client: tx,
        data: { cancelledAt: new Date() },
      });
      await recordCancellationRow(tx, booking, {
        tier,
        daysBefore,
        clientRefundKobo: 0,
        artistCompensationKobo: 0,
        escrowFeesKobo: 0,
      });
      return next;
    });

    return cancellationSummaryFor(withdrawn, { tier, daysBefore, unfunded: true });
  }

  const breakdown = computeClientCancellation({
    amountKobo: booking.amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
    clientRefundBps: tier.clientRefundBps,
    artistCompensationBps: tier.artistCompensationBps,
  });

  // --- The irreversible steps, in order. -----------------------------------
  if (breakdown.artistCompensationKobo > 0) {
    if (!booking.artist.user.escrowPartyId) {
      throw new AppError(409, 'This artist cannot receive payments yet.');
    }
    await escrowpay.release({
      transactionId: booking.escrowId,
      reference: `${booking.escrowReference}_cxl_artist`,
      amountKobo: breakdown.artistCompensationKobo,
      reason: reason
        ? `Client cancelled ${daysBefore} day(s) before the event: ${reason}`
        : `Client cancelled ${daysBefore} day(s) before the event`,
    });
  }

  if (breakdown.clientRefundKobo > 0) {
    await escrowpay.refund({
      transactionId: booking.escrowId,
      reference: `${booking.escrowReference}_cxl_client`,
      amountKobo: breakdown.clientRefundKobo,
      reason: `Cancellation refund at ${tier.clientRefundBps} bps`,
    });
  }

  // --- Recorded now, in ONE transaction with the state change. -------------
  const updated = await prisma.$transaction(async (tx: PrismaTx) => {
    const next = await transition({
      bookingId: booking.id,
      to: 'CANCELLED',
      client: tx,
      data: { cancelledAt: new Date() },
    });

    await ledger.recordClientCancellation(tx, booking, tier);

    await recordCancellationRow(tx, booking, {
      tier,
      daysBefore,
      clientRefundKobo: breakdown.clientRefundKobo,
      artistCompensationKobo: breakdown.artistCompensationKobo,
      escrowFeesKobo: breakdown.clientSunkFeeKobo + breakdown.moneyOutFeeKobo,
    });

    return next;
  });

  console.log(
    `[escrow] booking ${booking.id} cancelled by client ${daysBefore} day(s) out — ` +
      `${breakdown.clientRefundKobo} kobo refunded, ${breakdown.artistCompensationKobo} kobo to artist`
  );

  return cancellationSummaryFor(updated, { tier, daysBefore, breakdown });
}

/**
 * An artist cancels — issue #28, docs/05 §7.
 *
 * THIS CASE HAS A PROBLEM THE CLIENT CASE DOES NOT: the artist bears the fees
 * and has no money in escrow to deduct them from. The client's payment is the
 * only money in the transaction and all of it is going back to the client.
 *
 * Resolved with a `FeeLiability` — the platform fronts the cost and recovers it
 * from the artist's next payout (#26). If they never book again it is written
 * off, because pursuing a ₦2,000 debt through collections costs more than the
 * debt.
 *
 * THE CLIENT RECEIVES 100%, PLUS THE FEE THEY PAID AT FUNDING. Not a
 * fee-reduced amount. They did nothing wrong, and passing them any part of the
 * cost of the artist's decision would undermine the guarantee the platform
 * exists to make.
 *
 * Timing does not change the money here — unlike a client cancellation, where
 * the tier splits the escrow. It changes the CONDUCT consequence: seven days
 * out is a normal business event, and the day of the event is not (docs/06 §2).
 */
async function cancelByArtist({
  bookingId,
  artistUserId,
  reason,
}: {
  bookingId: string;
  artistUserId: string;
  reason?: string;
}): Promise<CancellationSummary> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { client: true, artist: true, cancellation: true },
  });

  if (!booking) throw new AppError(404, 'Booking not found.');
  if (booking.artist.userId !== artistUserId) throw new AppError(404, 'Booking not found.');

  if (booking.state === 'CANCELLED' || booking.state === 'REFUNDED') {
    return cancellationSummaryFor(booking, { alreadyCancelled: true });
  }

  assertTransition(booking.state, booking.escrowId ? 'REFUNDED' : 'CANCELLED');

  const daysBefore = daysBeforeEvent(booking.eventDate);
  if (daysBefore < 0) {
    throw new AppError(
      409,
      'This event has already taken place, so it cannot be cancelled. Confirm it or report a no-show instead.'
    );
  }

  // Never funded: no money moved, so no fees were incurred and there is nothing
  // to front. The conduct consequence still applies — the client has lost the
  // date either way.
  if (!booking.escrowId || booking.state === 'PENDING_PAYMENT') {
    const withdrawn = await prisma.$transaction(async (tx: PrismaTx) => {
      const next = await transition({
        bookingId: booking.id,
        to: 'CANCELLED',
        client: tx,
        data: { cancelledAt: new Date() },
      });

      await recordArtistCancellationRow(tx, booking, {
        daysBefore,
        clientRefundKobo: 0,
        escrowFeesKobo: 0,
      });

      await strikeService.accrueForCancellation(tx, {
        userId: artistUserId,
        by: 'ARTIST',
        daysBefore,
        bookingId: booking.id,
      });

      return next;
    });

    return cancellationSummaryFor(withdrawn, { daysBefore, unfunded: true });
  }

  const summary = await refundBooking({
    bookingId: booking.id,
    reason: reason
      ? `Artist cancelled ${daysBefore} day(s) before the event: ${reason}`
      : `Artist cancelled ${daysBefore} day(s) before the event`,

    // Everything that must be true if this refund happened, committed with it.
    alsoRecord: async (tx, { breakdown }) => {
      await recordArtistCancellationRow(tx, booking, {
        daysBefore,
        clientRefundKobo: breakdown.clientTotalReturnedKobo,
        escrowFeesKobo: breakdown.feeLiabilityKobo,
      });

      // Returns null seven or more days out, which is not an error: a week is
      // enough time for the client to rebook, so there is nothing to deter. The
      // fee liability is incurred regardless — the fees were still paid.
      await strikeService.accrueForCancellation(tx, {
        userId: artistUserId,
        by: 'ARTIST',
        daysBefore,
        bookingId: booking.id,
      });
    },
  });

  const cancelled = await prisma.booking.findUnique({ where: { id: booking.id } });

  console.log(
    `[escrow] booking ${booking.id} cancelled by artist ${daysBefore} day(s) out — ` +
      `${summary.clientTotalReturnedKobo} kobo returned, ${summary.feeLiabilityKobo} kobo accrued`
  );

  return {
    bookingId: booking.id,
    state: cancelled.state,
    alreadyCancelled: false,
    unfunded: false,
    daysBeforeEvent: daysBefore,
    // No tier: an artist cancellation returns everything whatever the timing.
    appliedTier: null,
    clientRefundKobo: summary.clientRefundKobo,
    artistCompensationKobo: 0,
    commissionKobo: 0,
    clientSunkFeeKobo: 0,
    moneyOutFeeKobo: null,
    clientFeeReimbursementKobo: summary.clientFeeReimbursementKobo,
    feeLiabilityKobo: summary.feeLiabilityKobo,
  };
}

/** The cancellation record for an artist-initiated one. */
function recordArtistCancellationRow(
  tx: PrismaTx,
  booking: BookingRow & { artist: ArtistRow },
  {
    daysBefore,
    clientRefundKobo,
    escrowFeesKobo,
  }: { daysBefore: number; clientRefundKobo: Kobo; escrowFeesKobo: Kobo }
) {
  return tx.cancellation.create({
    data: {
      bookingId: booking.id,
      initiatedBy: 'ARTIST',
      initiatedByUserId: booking.artist.userId,
      daysBeforeEvent: daysBefore,
      // No tier applies: the split is not timing-dependent when the artist is
      // at fault. Recorded as an empty object rather than a tier that was never
      // consulted, so the row cannot be misread later.
      appliedTier: {} as unknown as import('@prisma/client').Prisma.InputJsonValue,
      clientRefundKobo,
      artistCompensationKobo: 0,
      escrowFeesKobo,
      // docs/05 §7: the artist chose to cancel, so the artist carries the cost
      // — fronted by the platform and recovered at their next payout.
      feeBearer: 'ARTIST',
    },
  });
}

/**
 * Reclassifies a client cancellation as artist-fault — issue #29.
 *
 * NOT EVERY CLIENT CANCELLATION IS THE CLIENT'S FAULT. If the artist changed
 * terms after booking, misrepresented what they were providing, or disclosed
 * costs late, the client cancelling is a consequence of the artist's conduct.
 * Charging them a cancellation fee for it is precisely the situation the FCCPA
 * addresses, which gives consumers a right to a refund where a service is not
 * rendered on the agreed terms.
 *
 * THE REVERSAL IS WRITTEN AS OFFSETTING ENTRIES, NEVER AS EDITS. Each original
 * entry gets its exact negation, and the corrected position is then written
 * fresh. The originals stay visible because the sequence — charged, then
 * reversed, and why — is the record that matters if the decision is ever
 * questioned. An edited ledger can only say what someone last decided; this one
 * says what happened.
 *
 * WHERE THE MONEY COMES FROM. The escrow is empty: a client cancellation
 * disburses both legs. So the difference owed to the client is refunded from
 * `wallet_available` — the platform's own funds — and recovered from the artist
 * as a liability, exactly as #28 does. The artist is also holding compensation
 * they should not have received, and that is part of the same debt.
 */
async function reclassifyAsArtistFault({
  cancellationId,
  actorUserId,
  reason,
}: {
  cancellationId: string;
  actorUserId: string;
  reason: string;
}): Promise<ReclassificationSummary> {
  // Mandatory, and checked before anything else. A money movement without a
  // recorded justification is indefensible later (docs/07 §1).
  if (!reason || !String(reason).trim()) {
    throw new AppError(400, 'Record why this cancellation is being reclassified as artist-fault.');
  }

  const cancellation = await prisma.cancellation.findUnique({
    where: { id: cancellationId },
    include: { booking: { include: { artist: true, client: true } } },
  });

  if (!cancellation) throw new AppError(404, 'Cancellation not found.');

  if (cancellation.initiatedBy !== 'CLIENT') {
    throw new AppError(
      409,
      'Only a client cancellation can be reclassified as artist-fault. This one was already the artist’s.'
    );
  }

  if (cancellation.reclassifiedAsArtistFault) {
    throw new AppError(409, 'This cancellation has already been reclassified.');
  }

  const booking = cancellation.booking;
  const tier = cancellation.appliedTier as unknown as CancellationTierSnapshot;

  const original = computeClientCancellation({
    amountKobo: booking.amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
    clientRefundBps: tier.clientRefundBps,
    artistCompensationBps: tier.artistCompensationBps,
  });

  const corrected = computeArtistCancellation({ amountKobo: booking.amountKobo });

  // What the client should have received in total, less what they did.
  const additionalToClient = corrected.clientTotalReturnedKobo - original.clientRefundKobo;

  if (additionalToClient < 0) {
    // Only reachable from a tier that returned more than the booking total,
    // which #8 would not accept. Loud rather than silently refunding nothing.
    throw new AppError(
      500,
      `Reclassification would owe the client ${additionalToClient} kobo, which cannot be right.`
    );
  }

  // The artist keeps neither the compensation nor the cost of the fees.
  const clawbackKobo = original.artistCompensationKobo;
  const liabilityKobo = corrected.feeLiabilityKobo + clawbackKobo;

  // --- The irreversible step. ---------------------------------------------
  //
  // From the platform's wallet, not from escrow: a client cancellation has
  // already disbursed both legs, so there is nothing left in the transaction to
  // refund from. The reference is stable, so a retry after a timeout returns the
  // original refund rather than paying twice.
  if (additionalToClient > 0) {
    await escrowpay.refund({
      transactionId: booking.escrowId,
      reference: `${booking.escrowReference}_reclass`,
      amountKobo: additionalToClient,
      source: 'wallet_available',
      reason: `Reclassified as artist-fault: ${reason}`,
    });
  }

  const result = await prisma.$transaction(async (tx: PrismaTx) => {
    // 1. Reverse every entry of the original cancellation, exactly.
    const reversed = await ledger.reverseEntries(tx, {
      bookingId: booking.id,
      entryTypes: ['REFUNDED', 'ARTIST_COMPENSATION', 'COMMISSION', 'ESCROW_FEE_OUT'],
      reason: `Reclassified as artist-fault: ${reason}`,
    });

    // 2. Write the position as it should have been.
    await ledger.recordArtistCancellation(tx, booking);

    // 3. The artist is holding compensation they should not have. A balanced
    //    pair, like every other liability: no money moves on an accrual.
    if (clawbackKobo > 0) {
      await ledger.record(tx, {
        bookingId: booking.id,
        entryType: 'FEE_LIABILITY_ACCRUED',
        party: 'ARTIST',
        amountKobo: -clawbackKobo,
        description: 'Compensation recovered after reclassification as artist-fault',
      });
      await ledger.record(tx, {
        bookingId: booking.id,
        entryType: 'FEE_LIABILITY_ACCRUED',
        party: 'PLATFORM',
        amountKobo: clawbackKobo,
        description: 'Compensation receivable from the artist after reclassification',
      });
    }

    // 4. One liability row covering both halves of what the artist now owes.
    const liability =
      liabilityKobo > 0
        ? await tx.feeLiability.create({
            data: {
              artistUserId: booking.artist.userId,
              originBookingId: booking.id,
              amountKobo: liabilityKobo,
              status: 'OUTSTANDING',
            },
          })
        : null;

    // 5. The cancellation row records the decision, not a rewritten outcome.
    const updated = await tx.cancellation.update({
      where: { id: cancellation.id },
      data: {
        reclassifiedAsArtistFault: true,
        reclassifiedByUserId: actorUserId,
        reclassificationReason: String(reason).slice(0, 2000),
        reclassifiedAt: new Date(),
        feeBearer: 'ARTIST',
        clientRefundKobo: corrected.clientTotalReturnedKobo,
        artistCompensationKobo: 0,
        escrowFeesKobo: corrected.feeLiabilityKobo,
      },
    });

    // 6. The conduct consequence, as though the artist had cancelled.
    await strikeService.accrueForCancellation(tx, {
      userId: booking.artist.userId,
      by: 'ARTIST',
      daysBefore: cancellation.daysBeforeEvent,
      bookingId: booking.id,
    });

    await recordAudit(tx, {
      actorUserId,
      action: 'CANCELLATION_RECLASSIFIED_ARTIST_FAULT',
      entityType: 'Cancellation',
      entityId: cancellation.id,
      reason: String(reason).slice(0, 2000),
      before: {
        feeBearer: 'CLIENT',
        clientRefundKobo: original.clientRefundKobo,
        artistCompensationKobo: original.artistCompensationKobo,
      },
      after: {
        feeBearer: 'ARTIST',
        clientRefundKobo: corrected.clientTotalReturnedKobo,
        additionalToClientKobo: additionalToClient,
        liabilityKobo,
      },
    });

    return { updated, reversedCount: reversed.length, liability };
  });

  console.log(
    `[escrow] cancellation ${cancellation.id} reclassified as artist-fault — ` +
      `${additionalToClient} kobo more to the client, ${liabilityKobo} kobo owed by the artist`
  );

  return {
    cancellationId: cancellation.id,
    bookingId: booking.id,
    reclassifiedByUserId: actorUserId,
    reason: String(reason).slice(0, 2000),
    entriesReversed: result.reversedCount,
    additionalToClientKobo: additionalToClient,
    clientTotalReturnedKobo: corrected.clientTotalReturnedKobo,
    artistClawbackKobo: clawbackKobo,
    liabilityKobo,
  };
}

/**
 * Writes off an artist's outstanding liabilities.
 *
 * Pursuing a ₦2,000 debt through collections costs more than the debt, so a
 * liability against an account that will never transact again is written off
 * rather than carried indefinitely. The write-off is RECORDED, not deleted: the
 * platform bore that cost and the ledger has to keep saying so.
 *
 * #34 calls this on permanent removal; until then it is an admin action.
 */
async function writeOffLiabilities({
  artistUserId,
  reason,
  actorUserId,
}: {
  artistUserId: string;
  reason: string;
  actorUserId: string;
}): Promise<{ writtenOff: number; totalKobo: Kobo }> {
  if (!reason) throw new AppError(400, 'A write-off must record why.');

  return prisma.$transaction(async (tx: PrismaTx) => {
    const outstanding = await tx.feeLiability.findMany({
      where: { artistUserId, status: 'OUTSTANDING' },
    });

    if (outstanding.length === 0) return { writtenOff: 0, totalKobo: 0 };

    await tx.feeLiability.updateMany({
      where: { id: { in: outstanding.map((l: FeeLiabilityRow) => l.id) } },
      data: { status: 'WRITTEN_OFF', writtenOffAt: new Date(), writeOffReason: reason },
    });

    const totalKobo = outstanding.reduce(
      (sum: number, l: FeeLiabilityRow) => sum + l.amountKobo,
      0
    );

    await recordAudit(tx, {
      actorUserId,
      action: 'FEE_LIABILITIES_WRITTEN_OFF',
      entityType: 'User',
      entityId: artistUserId,
      reason,
      after: { count: outstanding.length, totalKobo },
    });

    return { writtenOff: outstanding.length, totalKobo };
  });
}

/**
 * The cancellation record.
 *
 * `appliedTier` is a COPY of the tier, not a pointer to a configuration
 * version. A pointer would let the meaning of a settled cancellation change
 * when someone edits a table, which is exactly what the snapshot exists to
 * prevent — and this row is the evidence if the split is ever questioned.
 */
function recordCancellationRow(
  tx: PrismaTx,
  booking: BookingRow & { client: ClientRow },
  {
    tier,
    daysBefore,
    clientRefundKobo,
    artistCompensationKobo,
    escrowFeesKobo,
  }: {
    tier: CancellationTierSnapshot;
    daysBefore: number;
    clientRefundKobo: Kobo;
    artistCompensationKobo: Kobo;
    escrowFeesKobo: Kobo;
  }
) {
  return tx.cancellation.create({
    data: {
      bookingId: booking.id,
      initiatedBy: 'CLIENT',
      initiatedByUserId: booking.client.userId,
      daysBeforeEvent: daysBefore,
      appliedTier: tier as unknown as import('@prisma/client').Prisma.InputJsonValue,
      clientRefundKobo,
      artistCompensationKobo,
      escrowFeesKobo,
      // docs/05 §6: the client chose to cancel, so the client carries the cost.
      feeBearer: 'CLIENT',
    },
  });
}

function cancellationSummaryFor(
  booking: BookingRow,
  {
    tier = null,
    daysBefore = null,
    breakdown = null,
    alreadyCancelled = false,
    unfunded = false,
  }: {
    tier?: CancellationTierSnapshot | null;
    daysBefore?: number | null;
    breakdown?: ClientCancellationBreakdown | null;
    alreadyCancelled?: boolean;
    unfunded?: boolean;
  } = {}
): CancellationSummary {
  return {
    bookingId: booking.id,
    state: booking.state,
    alreadyCancelled,
    unfunded,
    daysBeforeEvent: daysBefore,
    appliedTier: tier,
    clientRefundKobo: breakdown?.clientRefundKobo ?? (unfunded ? 0 : null),
    artistCompensationKobo: breakdown?.artistCompensationKobo ?? (unfunded ? 0 : null),
    commissionKobo: breakdown?.commissionKobo ?? (unfunded ? 0 : null),
    clientSunkFeeKobo: breakdown?.clientSunkFeeKobo ?? (unfunded ? 0 : null),
    moneyOutFeeKobo: breakdown?.moneyOutFeeKobo ?? (unfunded ? 0 : null),
  };
}

/**
 * Refunds the client in full, at the artist's cost — #24's uncontradicted
 * no-show, and the shape #28's artist-fault reclassification reuses.
 *
 * ZERO FEE EXPOSURE FOR THE CLIENT. They get the escrow back AND the money-in
 * fee they paid on top of it at funding. They did nothing wrong, and passing
 * them any part of the cost of the artist's absence would undermine the
 * guarantee the platform exists to make. The money-in reimbursement and the
 * payout fee on the refund leg are fronted by the platform now and recovered
 * from the artist later, as a `FeeLiability` (docs/05 §6).
 *
 * THE PROVIDER IS CALLED BEFORE ANYTHING IS RECORDED, for the same reason
 * `releaseBooking` does it: a database failure after a successful refund is
 * self-healing, because the reference is a stable idempotency key and a retry
 * returns the original refund. The reverse order leaves a client we believe we
 * have repaid holding nothing.
 */
async function refundBooking({
  bookingId,
  reason,
  alsoRecord,
}: {
  bookingId: string;
  reason?: string;
  /**
   * Extra rows to write INSIDE this function's transaction — #28's
   * `Cancellation` row and its strike.
   *
   * A hook rather than a second transaction, because the alternative is a
   * refund that succeeded with no record of why it happened: the money is
   * correct and irreversible, and the explanation is missing. Anything that
   * must be true if this refund happened has to commit with it.
   */
  alsoRecord?: (tx: PrismaTx, context: ArtistFaultRefundContext) => Promise<void>;
}): Promise<RefundSummary> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { client: true, artist: { include: { user: true } } },
  });

  if (!booking) throw new AppError(404, 'Booking not found.');

  // Idempotent at our level: an already-refunded booking reports what happened
  // rather than instructing a second refund.
  if (booking.state === 'REFUNDED') {
    return refundSummaryFor(booking, { alreadyRefunded: true });
  }

  // Checked before the provider call as well as inside the transaction, so an
  // illegal refund never reaches the provider at all.
  assertTransition(booking.state, 'REFUNDED');

  if (!booking.escrowId) {
    throw new AppError(409, 'This booking was never funded, so there is nothing to refund.');
  }

  const breakdown = computeArtistCancellation({ amountKobo: booking.amountKobo });

  // --- The irreversible step. ---------------------------------------------
  const refund = await escrowpay.refund({
    transactionId: booking.escrowId,
    reference: `${booking.escrowReference}_refund`,
    amountKobo: breakdown.clientRefundKobo,
    reason: reason ?? 'Artist did not perform',
  });

  // --- Recorded now, in ONE transaction with the state change. -------------
  const updated = await prisma.$transaction(async (tx: PrismaTx) => {
    const next = await transition({
      bookingId: booking.id,
      to: 'REFUNDED',
      client: tx,
      data: { refundedAt: new Date() },
    });

    await ledger.recordArtistCancellation(tx, booking);

    // The obligation is recorded as a row, not only as ledger entries: #26
    // settles it against the artist's next payout, and it needs something to
    // find and mark SETTLED.
    let liability: FeeLiabilityRow | null = null;
    if (breakdown.feeLiabilityKobo > 0) {
      liability = await tx.feeLiability.create({
        data: {
          artistUserId: booking.artist.userId,
          originBookingId: booking.id,
          amountKobo: breakdown.feeLiabilityKobo,
          status: 'OUTSTANDING',
        },
      });
    }

    if (alsoRecord) await alsoRecord(tx, { booking, breakdown, liability });

    return next;
  });

  await require('../jobs/autoReleaseJob.ts').cancel(booking.id);

  console.log(
    `[escrow] refunded ${breakdown.clientTotalReturnedKobo} kobo to client for booking ${booking.id}` +
      ` (${breakdown.feeLiabilityKobo} kobo accrued against the artist)`
  );

  return refundSummaryFor(updated, {
    breakdown,
    providerRefundId: refund?.id ?? null,
  });
}

function refundSummaryFor(
  booking: BookingRow,
  {
    breakdown = null,
    providerRefundId = null,
    alreadyRefunded = false,
  }: {
    breakdown?: ArtistCancellationBreakdown | null;
    providerRefundId?: string | null;
    alreadyRefunded?: boolean;
  } = {}
): RefundSummary {
  return {
    bookingId: booking.id,
    state: booking.state,
    alreadyRefunded,
    clientRefundKobo: breakdown?.clientRefundKobo ?? null,
    clientFeeReimbursementKobo: breakdown?.clientFeeReimbursementKobo ?? null,
    clientTotalReturnedKobo: breakdown?.clientTotalReturnedKobo ?? null,
    feeLiabilityKobo: breakdown?.feeLiabilityKobo ?? null,
    providerRefundId,
  };
}

/**
 * Outstanding liabilities that this payout can clear, oldest first.
 *
 * WHOLE LIABILITIES ONLY. `FeeLiability` has no partially-settled state — it is
 * OUTSTANDING, SETTLED or WRITTEN_OFF — so settling half of one would either
 * need a new state or a mutated amount, and mutating a recorded obligation is
 * the same mistake the ledger exists to avoid. A liability the payout cannot
 * cover in full stays outstanding for the next one.
 *
 * In practice these are ~₦2,070 against payouts of tens of thousands, so the
 * case is rare; it is handled explicitly rather than left to chance.
 */
async function selectSettleableLiabilities({
  artistUserId,
  payoutCeilingKobo,
}: {
  artistUserId: string;
  payoutCeilingKobo: Kobo;
}): Promise<{ liabilities: FeeLiabilityRow[]; settledKobo: Kobo }> {
  const outstanding = await prisma.feeLiability.findMany({
    where: { artistUserId, status: 'OUTSTANDING' },
    orderBy: { createdAt: 'asc' },
  });

  const liabilities = [];
  let settledKobo = 0;

  for (const liability of outstanding) {
    if (settledKobo + liability.amountKobo > payoutCeilingKobo) continue;
    liabilities.push(liability);
    settledKobo += liability.amountKobo;
  }

  return { liabilities, settledKobo };
}

function releaseSummaryFor(booking: BookingRow, extra: ReleaseSummaryExtra = {}): ReleaseSummary {
  const completion =
    extra.completion ??
    computeCompletion({
      amountKobo: booking.amountKobo,
      commissionBps: booking.commissionRateBpsSnapshot,
    });

  const settlement = extra.settlement ?? {
    payoutKobo: completion.artistNetKobo,
    settledKobo: 0,
    remainingLiabilityKobo: 0,
  };

  return {
    bookingId: booking.id,
    state: booking.state,
    amountKobo: booking.amountKobo,
    commissionRateBpsSnapshot: booking.commissionRateBpsSnapshot,

    commissionKobo: completion.commissionKobo,
    moneyOutFeeKobo: completion.moneyOutFeeKobo,
    /** What the artist earned before any liability is recovered. */
    artistNetKobo: completion.artistNetKobo,
    /** What actually left escrow to the artist. */
    artistPayoutKobo: settlement.payoutKobo,
    liabilitySettledKobo: settlement.settledKobo,
    liabilityRemainingKobo: settlement.remainingLiabilityKobo,
    platformNetKobo: completion.platformNetKobo,

    alreadyReleased: extra.alreadyReleased ?? false,

    // Whether the money actually reached the artist, as opposed to reaching our
    // wallet. Released-but-not-paid-out is a real state and must be visible.
    payoutId: extra.payout?.payoutId ?? booking.payoutId ?? null,
    paidOut: extra.payout?.paid ?? Boolean(booking.paidOutAt),
    payoutFailureReason: extra.payout?.detail ?? booking.payoutFailureReason ?? null,
    providerReleaseId: extra.providerReleaseId ?? null,
  };
}

/**
 * Re-reads the funding instruction for an escrow that already exists.
 *
 * If the provider cannot be reached the booking details are still returned,
 * with `bankTransfer: null` — a status page that shows the amount and the state
 * is more useful than an error page, and #21 renders the missing-account case
 * explicitly rather than pretending it has one.
 */
async function withCheckoutSession(booking: BookingRow): Promise<FundingInstruction> {
  try {
    const session = await escrowpay.createCheckoutSession({
      transactionId: booking.escrowId,
      reference: `${booking.escrowReference}_checkout`,
    });
    return fundingInstructionFor(booking, session);
  } catch (err) {
    console.error(
      `[escrow] could not re-read funding session for ${booking.id}: ${(err as Error).message}`
    );
    return fundingInstructionFor(booking);
  }
}

module.exports = {
  createEscrowForBooking,
  fundingInstructionFor,
  releaseBooking,
  refundBooking,
  cancelByClient,
  cancelByArtist,
  reclassifyAsArtistFault,
  writeOffLiabilities,
};
