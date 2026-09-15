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

const prisma = require('../lib/prisma');
const { AppError } = require('../lib/errors');
const escrowpay = require('../lib/escrowpay');
const { assertAcknowledged } = require('./acknowledgementService');
const { assertCanTransact } = require('./bookingService');
const { moneyInFee } = require('./feeService');

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
async function createEscrowForBooking({ bookingId, clientUserId }) {
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
function fundingInstructionFor(booking, session, activated) {
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

/**
 * Re-reads the funding instruction for an escrow that already exists.
 *
 * If the provider cannot be reached the booking details are still returned,
 * with `bankTransfer: null` — a status page that shows the amount and the state
 * is more useful than an error page, and #21 renders the missing-account case
 * explicitly rather than pretending it has one.
 */
async function withCheckoutSession(booking) {
  try {
    const session = await escrowpay.createCheckoutSession({
      transactionId: booking.escrowId,
      reference: `${booking.escrowReference}_checkout`,
    });
    return fundingInstructionFor(booking, session);
  } catch (err) {
    console.error(`[escrow] could not re-read funding session for ${booking.id}: ${err.message}`);
    return fundingInstructionFor(booking);
  }
}

module.exports = { createEscrowForBooking, fundingInstructionFor };
