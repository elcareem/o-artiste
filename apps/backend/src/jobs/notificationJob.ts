/**
 * Queued notification dispatch — issue #38.
 *
 * EVERY notification goes through this queue. Not for throughput — these are
 * low-volume — but because #38's hard requirement is that a notification failure
 * never blocks a state change, and the only reliable way to guarantee that is for
 * the money path to hand off a job and stop caring.
 *
 * A send that fails is retried by BullMQ (three attempts, exponential backoff)
 * and a permanently failed one lands in the dead-letter queue, where
 * `GET /admin/queue/dead-letter` can see it. That is the difference between a
 * degraded notification and a silent one.
 *
 * Shares the `notifications` queue with the check-in code job, which was already
 * on it — one worker, one connection, and the deployed Key Value instance has a
 * connection cap worth respecting.
 */

const QUEUE_NAME = 'notifications';
const JOB_NAME = 'notify';

/**
 * Queues one notification.
 *
 * NEVER THROWS, and never returns a rejected promise. This is called from the
 * money paths — immediately after a funding or release transaction commits — and
 * the whole point is that a Redis outage cannot turn into a payment failure.
 * A failure to enqueue is logged loudly and that is all.
 */
async function enqueue(
  data: NotificationJobData,
  options: {
    /** Milliseconds to wait. Used for the event-day prompt, queued at funding. */
    delay?: number;
    /**
     * Dedupe key. BullMQ rejects a duplicate, which turns "send once" into a
     * property of the queue rather than something every caller remembers —
     * worth having where the funding webhook can be redelivered.
     *
     * Deliberately NOT the default: a booking can produce several dispute
     * updates, and an id derived from the booking would drop all but the first.
     * Must contain no colon, which BullMQ rejects in a custom job id (#22).
     */
    jobId?: string;
  } = {}
): Promise<boolean> {
  try {
    const { getQueue } = require('../lib/queue.ts');

    await getQueue(QUEUE_NAME).add(JOB_NAME, data, {
      ...(options.delay ? { delay: Math.max(0, options.delay) } : {}),
      ...(options.jobId ? { jobId: options.jobId } : {}),
    });

    return true;
  } catch (err) {
    console.error(
      `[notify] COULD NOT QUEUE ${data.channel} for ${data.reference}: ${(err as Error).message}`
    );
    return false;
  }
}

/**
 * Sends it.
 *
 * Throws on a retryable provider failure, so BullMQ retries. Returns normally on
 * a non-retryable one — a malformed number, an unregistered sender — because
 * three more attempts produce the same rejection and bury a real signal under
 * repeats. The log line is the record in that case.
 */
async function run(job: import('bullmq').Job): Promise<Record<string, unknown>> {
  const data = (job.data ?? {}) as NotificationJobData;
  const { channel, to, reference } = data;

  if (!channel || !to) throw new Error('notify job is missing a channel or destination');

  // A message scheduled weeks ago, checked against the booking as it is NOW.
  // The alternative is a cancelled client being asked to confirm an event that
  // did not happen — and the client has already been refunded by then, so the
  // message contradicts their bank statement.
  if (data.bookingId && data.requireState?.length) {
    const prisma = require('../lib/prisma.ts');
    const booking = await prisma.booking.findUnique({
      where: { id: data.bookingId },
      select: { state: true },
    });

    if (!booking) {
      console.warn(`[notify] booking ${data.bookingId} is gone, ${reference} not sent`);
      return { reference, channel, delivered: false, skipped: 'booking_missing' };
    }
    if (!data.requireState.includes(booking.state)) {
      console.log(
        `[notify] booking ${data.bookingId} is ${booking.state}, ${reference} not sent`
      );
      return { reference, channel, delivered: false, skipped: 'state_changed' };
    }
  }

  const notifications = require('../lib/notifications.ts');

  try {
    if (channel === 'SMS') {
      if (!data.message) throw new Error(`notify job ${reference} has no message`);
      const result = await notifications.sendSms({ to, message: data.message, reference });
      return { reference, channel, ...result };
    }

    if (channel === 'EMAIL') {
      if (!data.subject || !data.body) throw new Error(`notify job ${reference} has no subject or body`);
      const result = await notifications.sendEmail({
        to,
        subject: data.subject,
        body: data.body,
        reference,
      });
      return { reference, channel, ...result };
    }

    throw new Error(`notify job ${reference} has an unknown channel: ${channel}`);
  } catch (err) {
    const error = err as { retryable?: boolean; message: string };

    if (error.retryable === false) {
      // Our mistake, not the provider's. Recorded and dropped — see above.
      console.error(
        `[notify] ${channel} for ${reference} was rejected and will not be retried: ${error.message}`
      );
      return { reference, channel, delivered: false, abandoned: true, reason: error.message };
    }

    console.error(`[notify] ${channel} for ${reference} failed, will retry: ${error.message}`);
    throw err;
  }
}

module.exports = {
  QUEUE_NAME,
  JOB_NAME,
  enqueue,
  // See checkInCodeJob: a function declaration named `process` shadows Node's
  // global for the whole module.
  process: run,
};
