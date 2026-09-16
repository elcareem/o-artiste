/**
 * Auto-release — issue #25, docs/04 §4.
 *
 * THE COUNTERWEIGHT TO CLIENT-CONTROLLED RELEASE. Without it a client holds an
 * artist's money indefinitely by simply never responding: the exact failure the
 * platform exists to prevent, arriving through inaction rather than bad faith.
 * It is the one money movement in the system that happens because nobody asked
 * for it, which is why every condition it checks is checked at the moment it
 * runs rather than at the moment it was scheduled.
 *
 * IT FIRES ONLY WHERE A CHECK-IN EXISTS. No check-in and no client response
 * means nobody has evidence the event happened, and paying out on silence there
 * would pay for a performance that may never have occurred. Those bookings wait
 * for a person — `awaiting_response` in #24's matrix.
 *
 * The job is scheduled at FUNDING, which is months before it might fire. By
 * then the booking may have been cancelled, refunded, disputed, or released by
 * either party. So the payload carries a booking id and nothing else, and every
 * decision is re-made against the database when it wakes.
 */

const QUEUE_NAME = 'releases';
const JOB_NAME = 'auto-release';

/**
 * Hours after `eventEndAt` before funds release on silence.
 *
 * Configuration, never a constant — open item `docs/00` §11.5. The right value
 * is not knowable until there is real booking data: too short and a client who
 * was travelling loses their window to dispute, too long and every artist waits
 * on the slowest client. It ships configurable so the decision can be made
 * later without a deploy.
 */
function graceHours(): number {
  const raw = process.env.AUTO_RELEASE_GRACE_HOURS;
  if (raw === undefined || raw === '') return 48;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `AUTO_RELEASE_GRACE_HOURS must be a positive number of hours, received: ${raw}`
    );
  }
  return value;
}

/** When auto-release becomes due for an event ending at `eventEndAt`. */
function deadlineFor(eventEndAt: Date | string): Date {
  return new Date(new Date(eventEndAt).getTime() + graceHours() * 3600_000);
}

/**
 * One job per booking, forever.
 *
 * A hyphen, not a colon: BullMQ rejects a custom job id containing `:`, which
 * #22 discovered the expensive way — the enqueue failed on every booking and
 * said so only in a log line.
 */
function jobIdFor(bookingId: string): string {
  return `${JOB_NAME}-${bookingId}`;
}

/**
 * Schedules the release and records the deadline on the booking.
 *
 * Called at funding, after that transaction commits. The deadline is written
 * here rather than derived later because it is disclosed to the client, and a
 * disclosed deadline that disagrees with the scheduled job is worse than no
 * disclosure at all.
 *
 * Failures are logged, not thrown. A booking whose auto-release did not
 * schedule is still fully functional — both parties can confirm — and turning a
 * Redis blip into a failed funding webhook would leave the client's money
 * unrecorded.
 */
async function schedule(booking: { id: string; eventEndAt: Date | string }): Promise<Date | null> {
  const deadline = deadlineFor(booking.eventEndAt);

  try {
    const { getQueue } = require('../lib/queue.ts');
    const prisma = require('../lib/prisma.ts');

    const delay = Math.max(0, deadline.getTime() - Date.now());

    await getQueue(QUEUE_NAME).add(
      JOB_NAME,
      { bookingId: booking.id },
      { jobId: jobIdFor(booking.id), delay }
    );

    await prisma.booking.update({
      where: { id: booking.id },
      data: { autoReleaseAt: deadline },
    });

    console.log(
      `[auto-release] booking ${booking.id} scheduled for ${deadline.toISOString()}` +
        ` (${graceHours()}h after the event)`
    );
    return deadline;
  } catch (err) {
    console.error(
      `[auto-release] COULD NOT SCHEDULE for booking ${booking.id}: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Removes a pending auto-release.
 *
 * Called when a booking concludes early — released, refunded, cancelled. The
 * job would no-op anyway, because it re-checks everything when it wakes; this
 * is housekeeping, so the queue reflects what is actually outstanding and an
 * operator reading it is not looking at jobs for finished bookings.
 */
async function cancel(bookingId: string): Promise<boolean> {
  try {
    const { getQueue } = require('../lib/queue.ts');
    await getQueue(QUEUE_NAME).remove(jobIdFor(bookingId));
    return true;
  } catch {
    // Never worth propagating. The booking has already concluded, and the job
    // is harmless whether or not it is still queued.
    return false;
  }
}

/**
 * Releases, or explains why not.
 *
 * Every condition is re-read here. The job was scheduled at funding and the
 * world has had months to change.
 */
async function run(job: import('bullmq').Job): Promise<AutoReleaseOutcome> {
  const { bookingId } = job.data ?? {};
  if (!bookingId) throw new Error('auto-release job has no bookingId');

  const prisma = require('../lib/prisma.ts');
  const { releaseBooking } = require('../services/escrowService.ts');
  const { transition } = require('../services/bookingService.ts');

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { checkIn: true, disputes: true },
  });

  if (!booking) {
    console.warn(`[auto-release] booking ${bookingId} no longer exists`);
    return { bookingId, released: false, reason: 'booking_missing' };
  }

  const skip = (reason: AutoReleaseSkipReason, note: string): AutoReleaseOutcome => {
    console.log(`[auto-release] booking ${bookingId} skipped — ${note}`);
    return { bookingId, released: false, reason };
  };

  // Already concluded. Covers the idempotent case too: a retry after a partial
  // failure finds RELEASED and stops, so a duplicate run releases once.
  if (['RELEASED', 'REFUNDED', 'CANCELLED', 'RESOLVED'].includes(booking.state)) {
    return skip('already_settled', `it is already ${booking.state.toLowerCase()}`);
  }

  // An open dispute suppresses this absolutely. One of the two parties is not
  // telling the truth and the system cannot determine which — paying out on a
  // timer would decide it in the artist's favour by default (docs/04 §5).
  if (booking.state === 'DISPUTED' || booking.disputes.some((d: { state: string }) => d.state === 'OPEN')) {
    return skip('dispute_open', 'a dispute is open');
  }

  // The rule this job exists to respect.
  if (!booking.checkIn) {
    return skip(
      'no_check_in',
      'no check-in was recorded, so nobody has evidence the event happened'
    );
  }

  if (booking.clientNoShowClaimedAt) {
    // #24 already acted on this. Reaching here means the claim produced a
    // dispute that has since closed, or a refund that has not — either way it
    // is not this job's decision to make.
    return skip('client_claimed_no_show', 'the client reported a no-show');
  }

  // Not yet due. BullMQ should not deliver early, but this job moves money and
  // a delay miscalculated somewhere else must not become an early payout.
  const deadline = booking.autoReleaseAt ? new Date(booking.autoReleaseAt) : deadlineFor(booking.eventEndAt);
  if (Date.now() < deadline.getTime()) {
    return skip('not_yet_due', `it is not due until ${deadline.toISOString()}`);
  }

  // The window the booking waits in while the parties respond. `FUNDED_HELD`
  // cannot go straight to `RELEASED`, on purpose (#24).
  if (booking.state === 'FUNDED_HELD' || booking.state === 'CHECKED_IN') {
    await transition({ bookingId: booking.id, to: 'AWAITING_CONFIRMATION' });
  }

  const release = await releaseBooking({
    bookingId: booking.id,
    reason: `Auto-released ${graceHours()} hours after the event — the client did not respond and a check-in was recorded`,
  });

  console.log(
    `[auto-release] booking ${bookingId} released ${release.payoutKobo ?? 'n/a'} kobo on silence`
  );

  return { bookingId, released: !release.alreadyReleased, reason: 'released', release };
}

module.exports = {
  QUEUE_NAME,
  JOB_NAME,
  graceHours,
  deadlineFor,
  jobIdFor,
  schedule,
  cancel,
  // Declared as `run` and exported under the name the worker expects. A
  // function declaration called `process` shadows Node's global for the WHOLE
  // module, so `process.env` inside `graceHours` silently became a property
  // lookup on this function — the grace period would have been the default
  // forever, whatever the configuration said. `tsc` caught it; at runtime it
  // would have been a config setting that quietly did nothing.
  process: run,
};
