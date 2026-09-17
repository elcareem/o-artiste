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

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const { resolveCommissionRate } = require('./commissionService.ts');
const { resolveTierSet, validateTierSet } = require('./cancellationTierService.ts');
const { MIN_TRANSACTION_KOBO, MAX_TRANSACTION_KOBO } = require('../lib/escrowpay.ts');
const { formatNairaForMessage } = require('../lib/money.ts');

/**
 * The allowed-transition map — docs/01 §4.
 *
 * Explicit rather than inferred. An illegal transition throws: on a
 * money-bearing state machine, a transition that should be impossible arriving
 * anyway means an assumption is wrong, and continuing past that point is how an
 * unrecoverable state gets written.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<BookingState, readonly BookingState[]>> = Object.freeze({
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

const TERMINAL_STATES: readonly BookingState[] = Object.freeze(
  (Object.keys(ALLOWED_TRANSITIONS) as BookingState[]).filter(
    (s) => ALLOWED_TRANSITIONS[s].length === 0
  )
);

/** Whether a transition is permitted, without performing it. */
function canTransition(from: BookingState, to: BookingState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Validates a transition, throwing on an illegal one.
 *
 * Named separately from the database write so #24's confirmation matrix can
 * check a transition before deciding, and so the rule is testable without a
 * booking row.
 */
function assertTransition(from: BookingState, to: BookingState): void {
  if (!(from in ALLOWED_TRANSITIONS)) {
    throw new AppError(500, `Unknown booking state: ${from}.`);
  }
  if (!canTransition(from, to)) {
    const allowed = ALLOWED_TRANSITIONS[from];
    throw new AppError(
      409,
      allowed.length === 0
        ? `This booking has already been ${WHERE_IT_IS[from]} and cannot change.`
        : `This booking is ${WHERE_IT_IS[from]}, so it cannot be ${WHAT_YOU_ASKED[to]}.`
    );
  }
}

/**
 * The states, as a person would say them.
 *
 * The raw name must never reach a user (docs/02 §2). `CHECKED_IN` tells a
 * client nothing; "checked in at the event" tells them why their cancellation
 * was refused. This was leaking through the generic branch of
 * `assertTransition` until #27's test asserted no enum name appears in an
 * error — every other message in the system had been written by hand, so the
 * one generated from the state machine was the one nobody had read.
 */
const WHERE_IT_IS: Record<BookingState, string> = Object.freeze({
  PENDING_PAYMENT: 'waiting for payment',
  FUNDED_HELD: 'paid for, with the money held',
  CHECKED_IN: 'checked in at the event',
  AWAITING_CONFIRMATION: 'waiting to be confirmed',
  DISPUTED: 'under dispute',
  RELEASED: 'paid out',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
  RESOLVED: 'settled by support',
});

/** The same set, phrased as the thing the caller was trying to do. */
const WHAT_YOU_ASKED: Record<BookingState, string> = Object.freeze({
  PENDING_PAYMENT: 'reopened for payment',
  FUNDED_HELD: 'funded',
  CHECKED_IN: 'checked into',
  AWAITING_CONFIRMATION: 'confirmed',
  DISPUTED: 'disputed',
  RELEASED: 'paid out',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
  RESOLVED: 'resolved',
});

/**
 * Performs a guarded transition.
 *
 * THE WRITE IS A COMPARE-AND-SWAP, and that is the whole substance of this
 * function. Re-reading inside the transaction is not enough on its own:
 * PostgreSQL's default READ COMMITTED lets two transactions both read
 * `AWAITING_CONFIRMATION`, both pass the guard, and then the second one's
 * `UPDATE` simply waits for the first to commit and succeeds anyway — setting
 * the state to a value it already holds, reporting success, and returning to a
 * caller that goes on to write a second full set of ledger entries.
 *
 * Found by #25's concurrency test: three simultaneous auto-release runs
 * produced two releases. The provider deduplicates on our idempotency key so
 * no real money moved twice, but the ledger would have recorded a payout that
 * never happened — and the ledger is the thing we reconcile against.
 *
 * So the update is conditioned on the state we just validated. Exactly one
 * writer can match it; the losers see zero rows affected and are told what the
 * booking became.
 */
async function transition({
  bookingId,
  to,
  client = prisma,
  data = {},
}: {
  bookingId: string;
  to: BookingState;
  client?: PrismaLike;
  data?: Partial<BookingRow>;
}): Promise<BookingRow> {
  const run = async (tx: PrismaTx): Promise<BookingRow> => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new AppError(404, 'Booking not found.');

    assertTransition(booking.state, to);

    const { count } = await tx.booking.updateMany({
      // `state` in the filter is what makes this a compare-and-swap. Without
      // it the guard above is advisory.
      where: { id: bookingId, state: booking.state },
      data: { state: to, ...data } as import('@prisma/client').Prisma.BookingUncheckedUpdateInput,
    });

    if (count === 0) {
      // Somebody else moved it between our read and our write. Re-read and let
      // the transition map explain, so the loser of a release race is told
      // "already paid out" rather than something about concurrency.
      const current = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!current) throw new AppError(404, 'Booking not found.');
      assertTransition(current.state, to);

      // The state changed but the transition is still legal from where it
      // landed. Retrying would be safe, but doing it silently here would hide a
      // race from the caller that needs to know about it.
      throw new AppError(
        409,
        'This booking changed while your request was in flight. Check its status and try again.'
      );
    }

    return (await tx.booking.findUnique({ where: { id: bookingId } })) as BookingRow;
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
function generateEscrowReference(): string {
  return `bk_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Creates a booking with the configuration frozen onto it.
 */
async function createBooking({
  clientUserId,
  artistId,
  amountKobo,
  eventDate,
  eventEndAt,
  eventLocation,
}: {
  clientUserId: string;
  artistId: string;
  amountKobo: Kobo;
  eventDate: Date | string;
  eventEndAt?: Date | string | null;
  eventLocation?: string | null;
}): Promise<BookingRow> {
  const amount = validateAmount(amountKobo);
  const { start, end } = validateEventWindow(eventDate, eventEndAt);

  const clientUser = await prisma.user.findUnique({
    where: { id: clientUserId },
    include: { client: true },
  });
  if (!clientUser?.client) throw new AppError(403, 'Only clients can create bookings.');

  assertCanTransact(clientUser, 'client');

  // A RESTRICTED client may still book — just not close to the date. The
  // restriction addresses the specific failure mode, last-minute cancellation,
  // without removing an otherwise usable customer (#34, docs/06 §5).
  require('./enforcementService.ts').assertWithinLeadTime(clientUser, eventDate);

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

  // THE SNAPSHOT IS VALIDATED BEFORE IT IS FROZEN, not only when it was saved.
  //
  // #8 makes an invalid set unsaveable, but that guards the write. This guards
  // the read: a set that has become partial — a version half-written, a row
  // removed by hand, a resolver returning less than it should — would snapshot
  // onto the booking and only fail at cancellation, with money already held and
  // no applicable rule. docs/05 §5 is explicit that there is no safe default
  // there: refunding everything harms the artist, refunding nothing is FCCPA
  // exposure.
  //
  // Failing here costs a booking that was never created. Failing there costs a
  // decision nobody is authorised to make.
  try {
    validateTierSet(tierSet.tiers);
  } catch (err) {
    throw new AppError(
      500,
      'Booking is temporarily unavailable: the cancellation terms are not currently valid. ' +
        `Nothing has been charged. (${(err as Error).message})`
    );
  }

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
      cancellationTiersSnapshot: tierSet.tiers.map((t: CancellationTierSnapshot) => ({
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
function assertCanTransact(user: UserRow, role: 'client' | 'artist'): void {
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

function validateAmount(amountKobo: unknown): Kobo {
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

function validateEventWindow(
  eventDate: Date | string,
  eventEndAt?: Date | string | null
): { start: Date; end: Date } {
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
  assertCanTransact,
  transition,
  assertTransition,
  canTransition,
  generateEscrowReference,
  ALLOWED_TRANSITIONS,
  TERMINAL_STATES,
};
