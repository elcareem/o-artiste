/**
 * The two-sided confirmation matrix — docs/04 §3, issue #24.
 *
 * Every row encodes a specific piece of reasoning, and the reasoning is what
 * makes the row defensible when someone disputes the outcome:
 *
 *   Client confirms, artist silent  → RELEASE. The artist has no incentive to
 *     withhold confirmation of their own payment. Silence is indifference, not
 *     a signal, and requiring their active confirmation would strand payouts on
 *     nothing.
 *
 *   Client silent                   → the grace period decides (#25). Without
 *     that, a client withholds an artist's money indefinitely by never
 *     responding — the exact failure the platform exists to prevent, arriving
 *     through inaction rather than bad faith.
 *
 *   No-show claim, no check-in      → REFUND. The claim is uncontradicted.
 *     Nobody has evidence the event happened.
 *
 *   No-show claim, check-in exists  → DISPUTE. This is the case the check-in
 *     code exists to catch. It MUST NEVER auto-resolve in either direction:
 *     one of the two parties is not telling the truth, and the system cannot
 *     determine which from the data alone.
 *
 * `evaluate` is pure, and takes facts rather than a booking row, so each row of
 * the matrix is a test that needs no database.
 */

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const { transition } = require('./bookingService.ts');
const { releaseBooking, refundBooking } = require('./escrowService.ts');

/**
 * The matrix, as a function.
 *
 * Deliberately ignorant of booking state, roles and timing — those are gates
 * applied by the caller. This answers only "given who has said what, and
 * whether an attendance record exists, what should happen?"
 */
function evaluate(facts: ConfirmationFacts): ConfirmationVerdict {
  const { clientConfirmed, clientClaimedNoShow, artistConfirmed, hasCheckIn } = facts;

  if (clientConfirmed && clientClaimedNoShow) {
    // Refused at the point of the second statement, so a booking should never
    // carry both. Reaching here means something wrote around that guard, and
    // guessing which statement to honour is exactly the decision a human has
    // to make.
    return {
      outcome: 'dispute',
      reason: 'The client has both confirmed and reported a no-show for this booking.',
    };
  }

  if (clientClaimedNoShow) {
    return hasCheckIn
      ? {
          outcome: 'dispute',
          reason: 'The client reports a no-show, but a check-in was recorded at the event.',
        }
      : {
          outcome: 'refund',
          reason: 'The client reports a no-show and no check-in was recorded.',
        };
  }

  if (clientConfirmed) {
    return {
      outcome: 'release',
      reason: artistConfirmed
        ? 'Both parties confirmed the event took place.'
        : 'The client confirmed the event took place.',
    };
  }

  // The client has said nothing. What happens next is a matter of time, not of
  // this function — and what CAN happen depends on whether there is evidence
  // the event occurred.
  return hasCheckIn
    ? {
        outcome: 'awaiting_auto_release',
        reason: 'A check-in was recorded. Payment releases automatically after the grace period.',
      }
    : {
        outcome: 'awaiting_response',
        reason:
          'No check-in was recorded and the client has not responded. Nothing releases automatically.',
      };
}

/** The matrix inputs, read off a booking. */
function factsFor(booking: ConfirmableBooking): ConfirmationFacts {
  return {
    clientConfirmed: booking.clientConfirmedAt !== null,
    clientClaimedNoShow: booking.clientNoShowClaimedAt !== null,
    artistConfirmed: booking.artistConfirmedAt !== null,
    hasCheckIn: Boolean(booking.checkIn),
  };
}

/**
 * Records a confirmation from whichever party is calling, then acts on it.
 */
async function confirm({
  bookingId,
  userId,
}: {
  bookingId: string;
  userId: string;
}): Promise<ConfirmationResult> {
  const { booking, party } = await participantBooking(bookingId, userId);

  assertEventIsOver(booking);
  assertActionable(booking);

  if (party === 'CLIENT' && booking.clientNoShowClaimedAt) {
    throw new AppError(
      409,
      'You reported this event as a no-show. Contact support if that was a mistake — it cannot be reversed by confirming.'
    );
  }

  const field = party === 'CLIENT' ? 'clientConfirmedAt' : 'artistConfirmedAt';

  // Idempotent: a second confirmation keeps the first timestamp. The time a
  // party responded is evidence, and overwriting it on a double-tap would
  // quietly rewrite the record.
  const updated = booking[field]
    ? booking
    : await prisma.booking.update({
        where: { id: booking.id },
        data: { [field]: new Date() },
        include: { checkIn: true, client: true, artist: true },
      });

  return act(updated, party);
}

/**
 * Records a client's no-show claim, then acts on it.
 *
 * CLIENT ONLY. An artist reporting their own no-show is a cancellation (#28),
 * not a claim about someone else's conduct.
 */
async function claimNoShow({
  bookingId,
  clientUserId,
  reason,
}: {
  bookingId: string;
  clientUserId: string;
  reason?: string;
}): Promise<ConfirmationResult> {
  const { booking, party } = await participantBooking(bookingId, clientUserId);
  if (party !== 'CLIENT') throw new AppError(404, 'Booking not found.');

  assertEventIsOver(booking);
  assertActionable(booking);

  if (booking.clientConfirmedAt) {
    throw new AppError(
      409,
      'You already confirmed this event took place. Contact support if that was a mistake.'
    );
  }

  const updated = booking.clientNoShowClaimedAt
    ? booking
    : await prisma.booking.update({
        where: { id: booking.id },
        data: {
          clientNoShowClaimedAt: new Date(),
          clientNoShowReason: reason ? String(reason).slice(0, 2000) : null,
        },
        include: { checkIn: true, client: true, artist: true },
      });

  return act(updated, 'CLIENT');
}

/**
 * Executes whatever the matrix decided.
 *
 * The booking is moved to `AWAITING_CONFIRMATION` first where it is not there
 * already. That is the state a finished event sits in while the parties
 * respond, and it is also what makes the money-moving transitions legal:
 * `FUNDED_HELD` cannot go straight to `RELEASED` in the transition map, on
 * purpose — a booking cannot be paid out without having passed through the
 * window in which it could have been disputed.
 */
async function act(booking: ConfirmableBooking, actedBy: 'CLIENT' | 'ARTIST'): Promise<ConfirmationResult> {
  const verdict = evaluate(factsFor(booking));

  if (booking.state === 'FUNDED_HELD' || booking.state === 'CHECKED_IN') {
    await transition({ bookingId: booking.id, to: 'AWAITING_CONFIRMATION' });
  }

  switch (verdict.outcome) {
    case 'release': {
      const release = await releaseBooking({ bookingId: booking.id, reason: verdict.reason });
      return { ...verdict, actedBy, bookingId: booking.id, state: release.state, release };
    }

    case 'refund': {
      const refund = await refundBooking({ bookingId: booking.id, reason: verdict.reason });
      return { ...verdict, actedBy, bookingId: booking.id, state: refund.state, refund };
    }

    case 'dispute': {
      const dispute = await openDispute(booking, verdict.reason);
      return { ...verdict, actedBy, bookingId: booking.id, state: 'DISPUTED', disputeId: dispute.id };
    }

    default: {
      const current = await prisma.booking.findUnique({ where: { id: booking.id } });
      return { ...verdict, actedBy, bookingId: booking.id, state: current.state };
    }
  }
}

/**
 * Opens the dispute and moves the booking, in one transaction.
 *
 * The check-in is attached where one exists. It is the whole substance of this
 * kind of dispute — it reduces "did the event happen?" to a timestamped fact —
 * and an admin should not have to go looking for it.
 *
 * Nothing here resolves anything. A dispute opened by this path must be
 * decided by a person (docs/04 §5).
 */
async function openDispute(booking: ConfirmableBooking, reason: string) {
  // Delegated to #31's service rather than duplicated. There is one way a
  // dispute comes into existence — automatic here, manual there — so the
  // check-in attachment, the idempotency and the audit row cannot drift apart
  // between the two paths.
  const disputeService = require('./disputeService.ts');

  return prisma.$transaction((tx: PrismaTx) =>
    disputeService.openDispute(tx, {
      bookingId: booking.id,
      openedByUserId: booking.client.userId,
      reason: booking.clientNoShowReason
        ? `${reason} Client's account: ${booking.clientNoShowReason}`
        : reason,
    })
  );
}

/** The booking and the caller's part in it, or 404. */
async function participantBooking(bookingId: string, userId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { checkIn: true, client: true, artist: true },
  });

  if (!booking) throw new AppError(404, 'Booking not found.');

  // 404 rather than 403 for a stranger: confirming a booking exists is itself
  // information, and the same reasoning applies here as everywhere else.
  if (booking.client.userId === userId) return { booking, party: 'CLIENT' as const };
  if (booking.artist.userId === userId) return { booking, party: 'ARTIST' as const };
  throw new AppError(404, 'Booking not found.');
}

/**
 * Neither party may act before the event has finished — docs/04 §3.
 *
 * `eventEndAt` rather than `eventDate`: a confirmation taken mid-performance is
 * a confirmation of something that has not happened yet, and it is the artist
 * who would be asking for it.
 */
function assertEventIsOver(booking: ConfirmableBooking): void {
  const endsAt = new Date(booking.eventEndAt);
  if (Date.now() < endsAt.getTime()) {
    throw new AppError(
      409,
      'This event has not finished yet. Confirmation opens when it ends.'
    );
  }
}

/** A booking that has already concluded cannot be confirmed into a new outcome. */
function assertActionable(booking: ConfirmableBooking): void {
  const settled: Record<string, string> = {
    RELEASED: 'This booking has already been paid out.',
    REFUNDED: 'This booking has already been refunded.',
    CANCELLED: 'This booking was cancelled.',
    RESOLVED: 'This booking was settled by support and is closed.',
    DISPUTED: 'This booking is under dispute. Support will decide it.',
    PENDING_PAYMENT: 'This booking was never paid for.',
  };

  const message = settled[booking.state];
  if (message) throw new AppError(409, message);
}

module.exports = { evaluate, factsFor, confirm, claimNoShow };
