/**
 * Every message this system sends — issue #38.
 *
 * PURE. Nothing here touches a provider, a queue or the database: each function
 * takes the facts and returns text. That is what makes the copy testable, and
 * the copy is the part with the actual requirements in it — "the confirmation
 * prompt must state the auto-release deadline" is a claim about a sentence.
 *
 * THE DEADLINE IS RENDERED IN LAGOS TIME. A client in Lagos told "15:00 UTC" has
 * been told the wrong time by an hour, and the whole point of disclosing a
 * deadline is that silence has a consequence they can see coming. There is no
 * configuration for this: the platform operates in Nigeria, and a timezone that
 * follows the server's locale is a deadline that changes when we move hosts.
 */

const { formatNairaForMessage } = require('./money.ts');

const TIMEZONE = 'Africa/Lagos';

/**
 * `Friday 3 October, 2:00 pm`.
 *
 * The weekday is included because "3 October at 2:00 pm" requires the reader to
 * work out whether that is tomorrow. A deadline they have to calculate is a
 * deadline they will miss.
 */
function formatDeadline(at: Date | string): string {
  const date = usableDate(at, 'formatDeadline');

  const parts = new Intl.DateTimeFormat('en-NG', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const meridiem = get('dayPeriod').toLowerCase().replace(/\s/g, '');

  return `${get('weekday')} ${get('day')} ${get('month')}, ${get('hour')}:${get('minute')} ${meridiem}`;
}

/** `Friday 3 October` — for a date where the time is not the point. */
function formatDay(at: Date | string): string {
  const parts = new Intl.DateTimeFormat('en-NG', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    // Assembled from parts rather than taking `.format()`, which inserts a comma
    // ("Saturday, 3 October") where `formatDeadline` does not. Two spellings of
    // the same date across two emails about one booking reads as carelessness.
  }).formatToParts(usableDate(at, 'formatDay'));

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}

/**
 * A date we can actually render.
 *
 * `null` is rejected explicitly because `new Date(null)` is the epoch, not an
 * error — so a missing deadline would render as "Thursday 1 January, 1:00 am"
 * with complete confidence. A throw here surfaces the caller's bug; a plausible
 * wrong date does not.
 */
function usableDate(at: Date | string | null | undefined, caller: string): Date {
  if (at === null || at === undefined || at === '') {
    throw new TypeError(`${caller} received no date (${String(at)})`);
  }
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${caller} received an unusable date: ${String(at)}`);
  }
  return date;
}

// ---------------------------------------------------------------------------
// SMS — short, and never carrying anything secret except the check-in code
// ---------------------------------------------------------------------------

/**
 * Event-day prompt to the client.
 *
 * Sent the morning of the event. Its only job is putting the code back in reach
 * of someone who is about to be at a venue, so it says where to find it rather
 * than repeating it — a code resent on the day is a code in two messages, and
 * the second one is the one that gets screenshotted and forwarded.
 */
function eventDaySms({ artistName }: { artistName?: string | null }): string {
  return (
    `${artistName || 'Your artist'} performs today. ` +
    'Have your o-artiste check-in code ready — give it to them when they arrive, not before.'
  );
}

/**
 * Post-event confirmation prompt — THE ONE WITH THE DEADLINE IN IT.
 *
 * #38's first acceptance criterion. The client is being told that doing nothing
 * has a consequence, and that is only a fair warning if they know when it
 * happens. The deadline is passed in rather than computed here: it is written on
 * the booking at funding and disclosed from there, so a prompt that recalculated
 * it could disagree with the job that actually fires (docs/04 §4).
 */
function confirmationPromptSms({
  artistName,
  autoReleaseAt,
}: {
  artistName?: string | null;
  autoReleaseAt: Date | string;
}): string {
  return (
    `Did ${artistName || 'your artist'} perform as agreed? ` +
    'Confirm in the o-artiste app to release payment. ' +
    `If we hear nothing from you by ${formatDeadline(autoReleaseAt)}, payment is released automatically.`
  );
}

// ---------------------------------------------------------------------------
// Email — room for the figures, which is why the money ones go here
// ---------------------------------------------------------------------------

type Email = { subject: string; body: string };

/**
 * Booking confirmed, money held.
 *
 * States who holds the money, because that is the question a client has after
 * transferring ₦202,000 to an account they have never seen before. "A licensed
 * bank, not us and not the artist" is the sentence that answers it.
 */
function bookingConfirmedEmail({
  clientName,
  artistName,
  amountKobo,
  eventDate,
  eventLocation,
  checkInCodeHint,
}: {
  clientName?: string | null;
  artistName?: string | null;
  amountKobo: number;
  eventDate: Date | string;
  eventLocation?: string | null;
  checkInCodeHint?: boolean;
}): Email {
  return {
    subject: `Your booking with ${artistName || 'your artist'} is confirmed`,
    body: [
      `Hello${clientName ? ` ${clientName}` : ''},`,
      '',
      `Your payment of ${formatNairaForMessage(amountKobo)} has arrived and is being held by a licensed bank — not by us, and not by ${artistName || 'the artist'}.`,
      '',
      `Event: ${formatDay(eventDate)}${eventLocation ? ` at ${eventLocation}` : ''}`,
      `Artist: ${artistName || 'your artist'}`,
      `Amount held: ${formatNairaForMessage(amountKobo)}`,
      '',
      checkInCodeHint
        ? 'Nearer the date we will text you a check-in code. Give it to the artist when they arrive — that is what starts the payment moving, and it is why you should not share it beforehand.'
        : null,
      checkInCodeHint ? '' : null,
      'The money is released after the event, once you confirm it went ahead. If something goes wrong, you can raise a dispute and the funds stay held until it is settled.',
    ]
      // Only `null` is dropped. An empty string is a PARAGRAPH BREAK, and
      // filtering those out turns every email into a wall of lines.
      .filter((line) => line !== null)
      .join('\n'),
  };
}

/**
 * A cancellation, with the figures.
 *
 * #38 requires "the exact figures shown at confirmation time". The caller passes
 * the amounts that were ACTUALLY WRITTEN TO THE LEDGER, not a recalculation —
 * this email is read alongside a bank statement, and a figure here that differs
 * by one kobo from the money received is a support ticket.
 */
function cancellationOutcomeEmail({
  recipient,
  clientName,
  artistName,
  amountKobo,
  clientRefundKobo,
  artistCompensationKobo,
  cancelledBy,
  reclassified,
}: {
  recipient: 'CLIENT' | 'ARTIST';
  clientName?: string | null;
  artistName?: string | null;
  amountKobo: number;
  clientRefundKobo: number;
  artistCompensationKobo: number;
  cancelledBy: 'CLIENT' | 'ARTIST';
  reclassified?: boolean;
}): Email {
  const toClient = recipient === 'CLIENT';
  const name = toClient ? clientName : artistName;

  const whoCancelled =
    cancelledBy === 'CLIENT'
      ? toClient
        ? 'You cancelled this booking.'
        : `${clientName || 'The client'} cancelled this booking.`
      : toClient
        ? `${artistName || 'The artist'} cancelled this booking.`
        : 'You cancelled this booking.';

  const figures = [
    `Booking value: ${formatNairaForMessage(amountKobo)}`,
    `Refunded to ${toClient ? 'you' : clientName || 'the client'}: ${formatNairaForMessage(clientRefundKobo)}`,
    artistCompensationKobo > 0
      ? `Paid to ${toClient ? artistName || 'the artist' : 'you'}: ${formatNairaForMessage(artistCompensationKobo)}`
      : `Paid to ${toClient ? artistName || 'the artist' : 'you'}: nothing`,
  ];

  return {
    subject: `Booking cancelled — ${artistName || 'your booking'}`,
    body: [
      `Hello${name ? ` ${name}` : ''},`,
      '',
      whoCancelled,
      reclassified
        ? // Said plainly, because the client is being refunded money they were
          // already told they would not get back, and an unexplained credit is
          // as confusing as an unexplained charge.
          'We reviewed this cancellation and found it was not the client’s fault, so the original charge has been reversed in full.'
        : 'These are the amounts, worked out from the cancellation terms shown when the booking was made:',
      '',
      ...figures,
      '',
      'Refunds reach your bank within a few working days.',
    ]
      // Only `null` is dropped. An empty string is a PARAGRAPH BREAK, and
      // filtering those out turns every email into a wall of lines.
      .filter((line) => line !== null)
      .join('\n'),
  };
}

/** A dispute moved. Says what is true now and what happens next, nothing more. */
function disputeUpdateEmail({
  recipient,
  artistName,
  stage,
  outcomeDescription,
}: {
  recipient: 'CLIENT' | 'ARTIST';
  artistName?: string | null;
  stage: 'OPENED' | 'EVIDENCE' | 'RESOLVED';
  outcomeDescription?: string | null;
}): Email {
  const body: Record<typeof stage, string> = {
    OPENED:
      'A dispute has been raised on this booking. The money stays held — nobody is paid and nothing is refunded — until it is decided. ' +
      'Add anything that helps explain what happened; the more specific, the faster this moves.',
    EVIDENCE:
      'New evidence has been added to the dispute on this booking. The funds remain held.',
    RESOLVED:
      outcomeDescription ||
      'The dispute on this booking has been decided and the funds have been moved accordingly.',
  };

  return {
    subject:
      stage === 'RESOLVED'
        ? `Dispute decided — ${artistName || 'your booking'}`
        : `Dispute update — ${artistName || 'your booking'}`,
    body: [
      'Hello,',
      '',
      body[stage],
      '',
      recipient === 'CLIENT'
        ? 'You can see the full record of this dispute in the app.'
        : 'You can see the full record of this dispute in the app.',
    ].join('\n'),
  };
}

/**
 * Money is on its way to the artist.
 *
 * Names the commission as its own line. The artist agreed to a percentage, and
 * showing the deduction is how they can check we applied the one they agreed to
 * — a single net figure asks them to take our word for it.
 */
function payoutConfirmedEmail({
  artistName,
  amountKobo,
  commissionKobo,
  netKobo,
  accountHint,
}: {
  artistName?: string | null;
  amountKobo: number;
  /**
   * Null where the caller cannot say — a dispute split, where the artist's share
   * was decided by a ruling rather than by the commission rate. The breakdown is
   * then omitted rather than guessed, because a wrong commission line is worse
   * than no commission line.
   */
  commissionKobo?: number | null;
  netKobo: number;
  accountHint?: string | null;
}): Email {
  const breakdown =
    commissionKobo === null || commissionKobo === undefined
      ? [
          `Paid to you: ${formatNairaForMessage(netKobo)}`,
          'This booking was settled by a support decision, so it is not a straight percentage of the booking value.',
        ]
      : [
          `Booking value: ${formatNairaForMessage(amountKobo)}`,
          `Platform commission: \u2212${formatNairaForMessage(commissionKobo)}`,
          `Paid to you: ${formatNairaForMessage(netKobo)}`,
        ];

  return {
    subject: `Payment sent — ${formatNairaForMessage(netKobo)}`,
    body: [
      `Hello${artistName ? ` ${artistName}` : ''},`,
      '',
      'Your payment for this booking is on its way.',
      '',
      ...breakdown,
      accountHint ? `Sent to the account ending ${accountHint}.` : null,
      '',
      'Bank transfers usually arrive the same working day.',
    ]
      // Only `null` is dropped. An empty string is a PARAGRAPH BREAK, and
      // filtering those out turns every email into a wall of lines.
      .filter((line) => line !== null)
      .join('\n'),
  };
}

module.exports = {
  formatDeadline,
  formatDay,
  eventDaySms,
  confirmationPromptSms,
  bookingConfirmedEmail,
  cancellationOutcomeEmail,
  disputeUpdateEmail,
  payoutConfirmedEmail,
  TIMEZONE,
};
