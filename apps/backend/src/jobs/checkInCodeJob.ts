/**
 * Check-in code delivery by SMS — issue #22.
 *
 * The code is written to the booking the moment funding lands, but it is not
 * SENT then. Funding can happen months ahead of the event, and a code received
 * in June for a September wedding is a code that has been forwarded, screenshot
 * and forgotten by the time it matters. It goes out a configurable lead time
 * before the event instead — close enough to still be in the client's messages
 * when the artist arrives.
 *
 * THE JOB ID IS DERIVED FROM THE BOOKING, deliberately. The funding webhook is
 * retryable and the provider redelivers, so `schedule()` can be reached more
 * than once for the same booking; BullMQ rejects a duplicate job id, which
 * turns "send once" into a property of the queue rather than a thing every
 * caller has to remember.
 */

const checkInService = require('../services/checkInService.ts');

const QUEUE_NAME = 'notifications';
const JOB_NAME = 'check-in-code';

/**
 * One job per booking, forever. See the note above.
 *
 * A HYPHEN, NOT A COLON. BullMQ rejects a custom job id containing `:` — the
 * character delimits its own Redis keys — and `schedule()` deliberately
 * swallows its failures, so the natural `check-in-code:<id>` spelling produced
 * a queue call that failed for every booking and said so only in a log line
 * nobody reads. Asserted against a real queue below, because no amount of
 * unit testing around it would have noticed.
 */
function jobIdFor(bookingId: string): string {
  return `${JOB_NAME}-${bookingId}`;
}

/**
 * Milliseconds until the message should go out.
 *
 * Never negative. A booking funded inside the lead time — someone paying the
 * morning of the event — sends immediately rather than being scheduled into the
 * past, which BullMQ would run instantly anyway but which reads as a bug at the
 * call site.
 */
function delayFor(eventDate: Date | string, now: Date = new Date()): number {
  const sendAt = new Date(eventDate).getTime() - checkInService.SMS_LEAD_HOURS * 3600_000;
  return Math.max(0, sendAt - now.getTime());
}

/**
 * Queues the delivery.
 *
 * Called AFTER the funding transaction commits, never inside it. A job that
 * fires against a transaction that then rolls back would text a client a code
 * the database does not have.
 *
 * Failures here are logged, not thrown. The code is already issued and visible
 * in the client's portal; losing the SMS is a degraded delivery, and turning it
 * into a failed webhook would leave the booking unfunded over a Redis blip.
 */
async function schedule(booking: { id: string; eventDate: Date | string }): Promise<boolean> {
  try {
    const { getQueue } = require('../lib/queue.ts');
    const delay = delayFor(booking.eventDate);

    await getQueue(QUEUE_NAME).add(
      JOB_NAME,
      { bookingId: booking.id },
      { jobId: jobIdFor(booking.id), delay }
    );

    console.log(
      `[check-in-code] delivery queued for booking ${booking.id} in ${Math.round(delay / 60_000)} min`
    );
    return true;
  } catch (err) {
    console.error(
      `[check-in-code] COULD NOT QUEUE DELIVERY for booking ${booking.id}: ${(err as Error).message}`
    );
    return false;
  }
}

/**
 * Sends the code.
 *
 * Re-reads the booking rather than trusting the job payload: the job was
 * scheduled weeks ago and the booking may have been cancelled, refunded or
 * already checked in since. Texting a code for a cancelled booking is a support
 * ticket at best and a confused artist at a venue at worst.
 */
async function run(job: import('bullmq').Job): Promise<CheckInCodeDelivery> {
  const { bookingId } = job.data ?? {};
  if (!bookingId) throw new Error('check-in-code job has no bookingId');

  // Required lazily: the worker loads this module at startup, and these pull in
  // Prisma and the notification transport.
  const prisma = require('../lib/prisma.ts');
  const { sendSms } = require('../lib/notifications.ts');

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { client: { include: { user: true } }, artist: true },
  });

  if (!booking) {
    console.warn(`[check-in-code] booking ${bookingId} no longer exists, nothing sent`);
    return { bookingId, sent: false, reason: 'booking_missing' };
  }

  // The states in which an event is still going to happen. A booking that has
  // left this set does not need a code in anybody's pocket.
  if (booking.state !== 'FUNDED_HELD') {
    console.log(
      `[check-in-code] booking ${bookingId} is ${booking.state}, not sending`
    );
    return { bookingId, sent: false, reason: 'booking_not_active' };
  }

  if (!booking.checkInCode) {
    // Funding wrote the code in the same transaction as the state change, so
    // this combination should be impossible. Loud rather than silent.
    console.error(`[check-in-code] booking ${bookingId} is FUNDED_HELD with no code`);
    return { bookingId, sent: false, reason: 'no_code' };
  }

  const result = await sendSms({
    to: booking.client.user.phone,
    message: checkInService.smsBodyFor({
      code: booking.checkInCode,
      artistName: booking.artist.stageName,
    }),
    reference: `check-in-code:${bookingId}`,
  });

  console.log(
    `[check-in-code] booking ${bookingId} → ${result.to}` +
      `${result.stubbed ? ' (stubbed, #38)' : ''}, ${result.segments} segment(s)`
  );

  return { bookingId, sent: true, delivered: result.delivered, stubbed: result.stubbed };
}

module.exports = { QUEUE_NAME, JOB_NAME, jobIdFor, delayFor, schedule,
  // Declared as `run`, exported under the name the worker expects. A function
  // declaration called `process` shadows Node's global for the WHOLE module, so
  // any `process.env` read in this file would silently become a property lookup
  // on this function. Caught in #25, where it turned a configurable grace
  // period into one that could never be configured.
  process: run,
};
