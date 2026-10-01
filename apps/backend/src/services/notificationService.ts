/**
 * What gets told to whom, and when — issue #38.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE: a notification failure never
 * blocks a state change. Every function here is safe to call from a money path
 * and none of them throws, ever — including on a programming error inside them.
 * The money path and the messaging path are separate concerns, and coupling them
 * means an SMS provider outage becomes a payment outage.
 *
 * That is achieved structurally rather than by care: each function does nothing
 * but build text and hand a job to the queue, and the whole body sits inside a
 * catch that logs. The provider is never called here.
 *
 * Call these AFTER the transaction commits, never inside it. A notification sent
 * from inside a transaction that then rolls back tells a client about money that
 * did not move.
 */

const notificationJob = require('../jobs/notificationJob.ts');
const messages = require('../lib/messages.ts');

/**
 * Everything any message here needs, loaded fresh.
 *
 * Every function takes a booking ID and loads it rather than accepting the
 * caller's object, for two reasons. The caller's copy is from BEFORE the
 * transaction that just committed — its `state` is stale and `autoReleaseAt` is
 * null, which would make `confirmationPrompt` silently decline to send. And a
 * shared include means no call site can forget the relation its message reads,
 * which would otherwise surface as a notification addressed to `undefined`.
 */
const WITH_PARTIES = {
  client: { include: { user: { select: { email: true, phone: true } } } },
  artist: { include: { user: { select: { email: true } } } },
};

async function load(bookingId: string): Promise<any | null> {
  const prisma = require('../lib/prisma.ts');
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: WITH_PARTIES,
  });
  if (!booking) console.warn(`[notify] booking ${bookingId} no longer exists, nothing sent`);
  return booking;
}

/**
 * Wraps a dispatch so nothing escapes.
 *
 * A thrown error here would propagate into whichever money path called it. The
 * log line is loud because a notification nobody receives and nobody records is
 * the failure mode worth preventing.
 */
async function safely(what: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(`[notify] could not dispatch ${what}: ${(err as Error).message}`);
    return false;
  }
}

/** The morning of the event, in Lagos time, as a delay from now. */
function eventDayDelayMs(eventDate: Date | string, now: Date = new Date()): number {
  const event = new Date(eventDate);
  // 8am Lagos is 7am UTC. Fixed rather than configurable: the prompt is useless
  // at 3am and redundant after the artist has arrived.
  const morning = new Date(
    Date.UTC(event.getUTCFullYear(), event.getUTCMonth(), event.getUTCDate(), 7, 0, 0)
  );
  return Math.max(0, morning.getTime() - now.getTime());
}

/**
 * Funding landed: confirm the booking, and queue the event-day prompt.
 *
 * Both at once because both are known now, and the event-day prompt's content
 * carries nothing secret — it says where to find the code rather than repeating
 * it — so scheduling it months ahead is safe.
 */
async function bookingFunded(bookingId: string): Promise<void> {
  const booking = await load(bookingId);
  if (!booking) return;

  const email = booking.client?.user?.email;
  const phone = booking.client?.user?.phone;

  if (email) {
    await safely(`booking-confirmed:${booking.id}`, () => {
      const { subject, body } = messages.bookingConfirmedEmail({
        clientName: booking.client?.displayName,
        artistName: booking.artist?.stageName,
        amountKobo: booking.amountKobo,
        eventDate: booking.eventDate,
        eventLocation: booking.eventLocation,
        checkInCodeHint: true,
      });
      return notificationJob.enqueue(
        { channel: 'EMAIL', to: email, subject, body, reference: `booking-confirmed-${booking.id}` },
        // Deduped: the funding webhook is retryable and the provider redelivers.
        { jobId: `notify-funded-${booking.id}` }
      );
    });
  }

  if (phone) {
    await safely(`event-day:${booking.id}`, () =>
      notificationJob.enqueue(
        {
          channel: 'SMS',
          to: phone,
          message: messages.eventDaySms({ artistName: booking.artist?.stageName }),
          reference: `event-day-${booking.id}`,
          bookingId: booking.id,
          // A cancelled booking gets no arrival prompt.
          requireState: ['FUNDED_HELD', 'CHECKED_IN'],
        },
        {
          delay: eventDayDelayMs(booking.eventDate),
          jobId: `notify-event-day-${booking.id}`,
        }
      )
    );

    // The post-event prompt, scheduled now for the same reason: its content —
    // including the auto-release deadline — is fully known at funding, and the
    // moment it needs to arrive is a fixed point after the event ends.
    //
    // It cannot be sent when the booking ENTERS AwaitingConfirmation, which is
    // the obvious-looking hook: both paths that make that transition release the
    // money in the next breath, so the prompt would arrive after the deadline it
    // announces had already passed.
    await confirmationPrompt(booking.id, { scheduled: true });
  }
}

/**
 * The event is over: ask the client to confirm, and say when silence decides it.
 *
 * #38's first acceptance criterion lives here. `autoReleaseAt` is read FROM THE
 * BOOKING rather than recomputed — it was written at funding and is the same
 * value the scheduled job will fire on, and a prompt quoting a different time
 * than the one that executes is worse than quoting none.
 */
async function confirmationPrompt(
  bookingId: string,
  { scheduled = false }: { scheduled?: boolean } = {}
): Promise<void> {
  const booking = await load(bookingId);
  if (!booking) return;

  const phone = booking.client?.user?.phone;
  if (!phone) return;

  if (!booking.autoReleaseAt) {
    // Scheduling failed at funding, which is logged there. Prompting without the
    // deadline would be telling a client that silence has a consequence while
    // declining to say what it is.
    console.warn(
      `[notify] booking ${booking.id} has no auto-release deadline, confirmation prompt not sent`
    );
    return;
  }

  await safely(`confirmation-prompt:${booking.id}`, () =>
    notificationJob.enqueue(
      {
        channel: 'SMS',
        to: phone,
        message: messages.confirmationPromptSms({
          artistName: booking.artist?.stageName,
          autoReleaseAt: booking.autoReleaseAt,
        }),
        reference: `confirmation-prompt-${booking.id}`,
        bookingId: booking.id,
        // Not sent on a booking that has already settled or is under dispute:
        // the first has nothing left to confirm, the second is being decided by
        // a person and a nudge about automatic release would be wrong.
        requireState: ['FUNDED_HELD', 'CHECKED_IN', 'AWAITING_CONFIRMATION'],
      },
      {
        ...(scheduled ? { delay: confirmationPromptDelayMs(booking) } : {}),
        jobId: `notify-confirm-${booking.id}`,
      }
    )
  );
}

/**
 * When the post-event prompt should land.
 *
 * Shortly after the event ends, not at the deadline — the client needs time to
 * act on it, and a prompt arriving as the grace period expires is a notification
 * of something that has already happened.
 *
 * Capped at the midpoint of the grace period so it cannot be scheduled past the
 * release it is warning about, however short the configured grace is.
 */
function confirmationPromptDelayMs(booking: any, now: Date = new Date()): number {
  const ends = new Date(booking.eventEndAt).getTime();
  const deadline = new Date(booking.autoReleaseAt).getTime();

  const oneHourAfter = ends + 3600_000;
  const midpoint = ends + (deadline - ends) / 2;

  return Math.max(0, Math.min(oneHourAfter, midpoint) - now.getTime());
}

/**
 * A cancellation settled, to both parties, with the figures.
 *
 * The amounts are passed in by the caller, taken from what was WRITTEN TO THE
 * LEDGER. Recomputing them here would produce a second implementation of the
 * cancellation arithmetic whose output is read next to a bank statement.
 */
async function cancellationSettled({
  bookingId,
  clientRefundKobo,
  artistCompensationKobo,
  cancelledBy,
  reclassified = false,
}: {
  bookingId: string;
  clientRefundKobo: number;
  artistCompensationKobo: number;
  cancelledBy: 'CLIENT' | 'ARTIST';
  reclassified?: boolean;
}): Promise<void> {
  const booking = await load(bookingId);
  if (!booking) return;

  const recipients: [('CLIENT' | 'ARTIST'), string | undefined][] = [
    ['CLIENT', booking.client?.user?.email],
    ['ARTIST', booking.artist?.user?.email],
  ];

  for (const [recipient, email] of recipients) {
    if (!email) continue;

    await safely(`cancellation:${booking.id}:${recipient}`, () => {
      const { subject, body } = messages.cancellationOutcomeEmail({
        recipient,
        clientName: booking.client?.displayName,
        artistName: booking.artist?.stageName,
        amountKobo: booking.amountKobo,
        clientRefundKobo,
        artistCompensationKobo,
        cancelledBy,
        reclassified,
      });
      return notificationJob.enqueue({
        channel: 'EMAIL',
        to: email,
        subject,
        body,
        reference: `cancellation-${recipient.toLowerCase()}-${booking.id}`,
      });
    });
  }
}

/** A dispute opened, gained evidence, or was decided. Both parties, every time. */
async function disputeUpdate({
  bookingId,
  stage,
  outcomeDescription,
}: {
  bookingId: string;
  stage: 'OPENED' | 'EVIDENCE' | 'RESOLVED';
  outcomeDescription?: string | null;
}): Promise<void> {
  const booking = await load(bookingId);
  if (!booking) return;

  const recipients: [('CLIENT' | 'ARTIST'), string | undefined][] = [
    ['CLIENT', booking.client?.user?.email],
    ['ARTIST', booking.artist?.user?.email],
  ];

  for (const [recipient, email] of recipients) {
    if (!email) continue;

    await safely(`dispute:${booking.id}:${stage}:${recipient}`, () => {
      const { subject, body } = messages.disputeUpdateEmail({
        recipient,
        artistName: booking.artist?.stageName,
        stage,
        outcomeDescription,
      });
      // NOT deduped. A dispute produces several updates and an id derived from
      // the booking would deliver only the first.
      return notificationJob.enqueue({
        channel: 'EMAIL',
        to: email,
        subject,
        body,
        reference: `dispute-${stage.toLowerCase()}-${recipient.toLowerCase()}-${booking.id}`,
      });
    });
  }
}

/** Money is on its way to the artist, with the commission shown as its own line. */
async function payoutSent({
  bookingId,
  commissionKobo,
  netKobo,
  accountHint,
}: {
  bookingId: string;
  /** Null on a dispute split — see `payoutConfirmedEmail`. */
  commissionKobo?: number | null;
  netKobo: number;
  accountHint?: string | null;
}): Promise<void> {
  const booking = await load(bookingId);
  if (!booking) return;

  const email = booking.artist?.user?.email;
  if (!email) return;

  await safely(`payout:${booking.id}`, () => {
    const { subject, body } = messages.payoutConfirmedEmail({
      artistName: booking.artist?.stageName,
      amountKobo: booking.amountKobo,
      commissionKobo,
      netKobo,
      accountHint,
    });
    return notificationJob.enqueue(
      { channel: 'EMAIL', to: email, subject, body, reference: `payout-${booking.id}` },
      { jobId: `notify-payout-${booking.id}` }
    );
  });
}

module.exports = {
  bookingFunded,
  confirmationPrompt,
  cancellationSettled,
  disputeUpdate,
  payoutSent,
  eventDayDelayMs,
  confirmationPromptDelayMs,
};
