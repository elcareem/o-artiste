/**
 * Booking lifecycle and state machine — docs/01-DATA-MODEL.md §4, issue #15.
 *
 * THE CONFIGURATION SNAPSHOT IS THE POINT OF THIS MODULE.
 *
 * #7 and #8 store commission and cancellation tiers as versioned records, but
 * versioning achieves nothing if payout math reads the current live value at
 * payout time. The snapshot frozen here is what guarantees the terms a client
 * acknowledged and an artist accepted are the terms that execute — however the
 * configuration changes afterwards.
 *
 * Every later calculation (#26 release, #27 client cancellation, #28 artist
 * cancellation) reads `commissionRateBpsSnapshot` and
 * `cancellationTiersSnapshot` from the booking. None of them may resolve live
 * config.
 */

const crypto = require('node:crypto');

const prisma = require('../lib/prisma');
const { AppError } = require('../lib/errors');
const { resolveCommissionRate } = require('./commissionService');
const { resolveTierSet } = require('./cancellationTierService');
const { MIN_TRANSACTION_KOBO, MAX_TRANSACTION_KOBO } = require('../lib/escrowpay');
const { formatNairaForMessage } = require('../lib/money');

/**
 * The allowed-transition map — docs/01 §4.
 *
 * Explicit rather than inferred. An illegal transition throws: on a
 * money-bearing state machine, a transition that should be impossible arriving
 * anyway means an assumption is wrong, and continuing past that point is how an
 * unrecoverable state gets written.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  PENDING_PAYMENT: ['FUNDED_HELD', 'CANCELLED'],
  FUNDED_HELD: ['CHECKED_IN', 'AWAITING_CONFIRMATION', 'CANCELLED', 'REFUNDED', 'DISPUTED'],
  CHECKED_IN: ['AWAITING_CONFIRMATION', 'RELEASED', 'DISPUTED'],
  AWAITING_CONFIRMATION: ['RELEASED', 'REFUNDED', 'DISPUTED'],
  DISPUTED: ['RESOLVED'],
  RELEASED: [],
  REFUNDED: [],
  CANCELLED: [],
  RESOLVED: [],
});

const TERMINAL_STATES = Object.freeze(
  Object.keys(ALLOWED_TRANSITIONS).filter((s) => ALLOWED_TRANSITIONS[s].length === 0)
);

/** Whether a transition is permitted, without performing it. */
function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Validates a transition, throwing on an illegal one.
 *
 * Named separately from the database write so #24's confirmation matrix can
 * check a transition before deciding, and so the rule is testable without a
 * booking row.
 */
function assertTransition(from, to) {
  if (!(from in ALLOWED_TRANSITIONS)) {
    throw new AppError(500, `Unknown booking state: ${from}.`);
  }
  if (!canTransition(from, to)) {
    const allowed = ALLOWED_TRANSITIONS[from];
    throw new AppError(
      409,
      allowed.length === 0
        ? `This booking is already ${from.toLowerCase().replace(/_/g, ' ')} and cannot change.`
        : `A booking cannot go from ${from} to ${to}.`
    );
  }
}

/**
 * Performs a guarded transition.
 *
 * The state is re-read and checked **inside the transaction**, so two
 * concurrent requests cannot both pass the guard against a stale value — the
 * check and the write are atomic together, not merely adjacent.
 */
async function transition({ bookingId, to, client = prisma, data = {} }) {
  const run = async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new AppError(404, 'Booking not found.');

    assertTransition(booking.state, to);

    return tx.booking.update({
      where: { id: bookingId },
      data: { state: to, ...data },
    });
  };

  // If a transaction client was passed in, join it rather than nesting.
  return client === prisma ? prisma.$transaction(run) : run(client);
}

/**
 * A self-generated escrow reference.
 *
 * Ours rather than the provider's, so a create call that times out or returns
 * ambiguously can be retried with the same reference instead of risking two
 * escrows for one booking (docs/03 §3). It is also the provider's required
 * `Idempotency-Key`, which #17 established.
 */
function generateEscrowReference() {
  return `bk_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Creates a booking with the configuration frozen onto it.
 */
async function createBooking({ clientUserId, artistId, amountKobo, eventDate, eventEndAt, eventLocation }) {
  const amount = validateAmount(amountKobo);
  const { start, end } = validateEventWindow(eventDate, eventEndAt);

  const clientUser = await prisma.user.findUnique({
    where: { id: clientUserId },
    include: { client: true },
  });
  if (!clientUser?.client) throw new AppError(403, 'Only clients can create bookings.');

  assertCanTransact(clientUser, 'client');

  const artist = await prisma.artist.findUnique({
    where: { id: artistId },
    include: { user: true },
  });
  if (!artist) throw new AppError(404, 'Artist not found.');

  assertCanTransact(artist.user, 'artist');

  if (!artist.profileComplete) {
    throw new AppError(409, 'This artist is not taking bookings yet.');
  }

  // Resolved ONCE, here, and frozen. Read at creation time so the snapshot is
  // what was in force at the moment the booking was made.
  const [commission, tierSet] = await Promise.all([resolveCommissionRate(), resolveTierSet()]);

  return prisma.booking.create({
    data: {
      clientId: clientUser.client.id,
      artistId: artist.id,
      amountKobo: amount,
      eventDate: start,
      eventEndAt: end,
      eventLocation: eventLocation ?? null,
      state: 'PENDING_PAYMENT',
      escrowReference: generateEscrowReference(),

      // THE SNAPSHOT. Copied by value, never referenced by version id — a
      // pointer would require reconstructing what applied; a copy is what
      // applied (docs/07 §4).
      commissionRateBpsSnapshot: commission.rateBasisPoints,
      cancellationTiersSnapshot: tierSet.tiers.map((t) => ({
        minDaysBefore: t.minDaysBefore,
        maxDaysBefore: t.maxDaysBefore,
        clientRefundBps: t.clientRefundBps,
        artistCompensationBps: t.artistCompensationBps,
      })),
    },
  });
}

/**
 * Both parties must be verified and in good standing.
 *
 * Verification is required on both sides because money flows out to the client
 * on refunds as well as to the artist on payouts — an unverified client is a
 * refund with no confirmed recipient (docs/02 §6).
 */
function assertCanTransact(user, role) {
  if (user.accountStanding === 'SUSPENDED' || user.accountStanding === 'REMOVED') {
    throw new AppError(
      403,
      role === 'client'
        ? 'Your account is suspended, so you cannot create bookings. Contact support if you think this is a mistake.'
        : 'This artist is not currently available for bookings.'
    );
  }

  if (user.verificationStatus !== 'VERIFIED') {
    throw new AppError(
      403,
      role === 'client'
        ? 'Verify your identity before creating a booking.'
        : 'This artist has not completed verification yet.'
    );
  }
}

function validateAmount(amountKobo) {
  if (typeof amountKobo !== 'number' || !Number.isInteger(amountKobo)) {
    throw new AppError(400, 'Enter the amount as a whole number of kobo.');
  }
  if (amountKobo < MIN_TRANSACTION_KOBO || amountKobo > MAX_TRANSACTION_KOBO) {
    throw new AppError(
      400,
      `A booking must be between ${formatNairaForMessage(MIN_TRANSACTION_KOBO)} and ` +
        `${formatNairaForMessage(MAX_TRANSACTION_KOBO)}. ` +
        'Amounts outside that range cannot be processed by our payment partner.'
    );
  }
  return amountKobo;
}

function validateEventWindow(eventDate, eventEndAt) {
  const start = new Date(eventDate);
  if (Number.isNaN(start.getTime())) {
    throw new AppError(400, 'Enter a valid event date.');
  }

  // A booking for an event that has already happened cannot be honoured, and
  // every downstream timer — check-in window, auto-release — would fire in the
  // past.
  if (start.getTime() <= Date.now()) {
    throw new AppError(400, 'The event date must be in the future.');
  }

  const end = eventEndAt ? new Date(eventEndAt) : new Date(start.getTime() + 3 * 60 * 60 * 1000);
  if (Number.isNaN(end.getTime())) {
    throw new AppError(400, 'Enter a valid event end time.');
  }
  if (end.getTime() <= start.getTime()) {
    throw new AppError(400, 'The event must end after it starts.');
  }

  return { start, end };
}

module.exports = {
  createBooking,
  transition,
  assertTransition,
  canTransition,
  generateEscrowReference,
  ALLOWED_TRANSITIONS,
  TERMINAL_STATES,
};
