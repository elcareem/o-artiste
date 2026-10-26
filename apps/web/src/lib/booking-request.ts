/**
 * Requesting a booking, and reading its terms — issue #46.
 */

import { formatNaira } from './currency.ts';
import { parseNairaToKobo } from './naira.ts';

/** Mirrors MIN/MAX_TRANSACTION_KOBO in the backend's escrowpay client. */
export const MIN_BOOKING_KOBO = 2_000_000;
export const MAX_BOOKING_KOBO = 300_000_000;

/**
 * A Lagos wall-clock date and time, as an instant.
 *
 * People type the time their event starts WHERE IT IS, and the platform is in
 * Nigeria. Lagos is UTC+1 all year — no daylight saving — so the offset is
 * fixed and written into the string, rather than left to whatever timezone the
 * browser happens to be in. A visitor booking from London still books 8pm Lagos.
 */
export function lagosToIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const instant = new Date(`${date}T${time}:00+01:00`);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

/**
 * Start and end, where the end may be after midnight.
 *
 * An event from 8pm to 2am is ordinary. An end time EARLIER than the start is
 * read as the next morning — and said back to the person, so it is never a
 * silent assumption.
 */
export function eventWindow(date: string, start: string, end: string) {
  const startIso = lagosToIso(date, start);
  const sameDayEnd = lagosToIso(date, end);
  if (!startIso || !sameDayEnd) return null;

  let endIso = sameDayEnd;
  let crossesMidnight = false;
  if (new Date(sameDayEnd).getTime() <= new Date(startIso).getTime()) {
    endIso = new Date(new Date(sameDayEnd).getTime() + 24 * 3600_000).toISOString();
    crossesMidnight = true;
  }
  return { startIso, endIso, crossesMidnight };
}

export type RequestFields = { date: string; start: string; end: string; location: string; amount: string };

export function requestProblems(f: RequestFields, now: Date = new Date()): Partial<Record<keyof RequestFields, string>> {
  const problems: Partial<Record<keyof RequestFields, string>> = {};

  if (!f.date) problems.date = 'Choose the date of your event.';
  if (!f.start) problems.start = 'When does it start?';
  if (!f.end) problems.end = 'When does it end?';

  const window = f.date && f.start && f.end ? eventWindow(f.date, f.start, f.end) : null;
  if (f.date && f.start && !lagosToIso(f.date, f.start)) problems.start = 'That is not a time we can read.';
  if (window && new Date(window.startIso).getTime() <= now.getTime()) {
    problems.date = 'The event has to be in the future.';
  }
  if (window && f.start === f.end) problems.end = 'The event has to end after it starts.';

  if (f.location.trim() === '') problems.location = 'Where is the event? The artist needs to know where to go.';

  const amount = parseNairaToKobo(f.amount, 'The amount');
  if (!amount.ok) problems.amount = amount.problem;
  else if (amount.kobo < MIN_BOOKING_KOBO || amount.kobo > MAX_BOOKING_KOBO) {
    problems.amount = `Bookings must be between ${formatNaira(MIN_BOOKING_KOBO)} and ${formatNaira(MAX_BOOKING_KOBO)}.`;
  }

  return problems;
}

export type Band = {
  minDaysBefore: number;
  maxDaysBefore: number | null;
  clientRefundBps: number;
  artistCompensationBps: number;
};

const pct = (bps: number) => `${bps / 100}%`;

/**
 * The cancellation terms in words, most notice first.
 *
 * These are the BOOKING'S OWN terms — the snapshot taken when it was created —
 * passed in exactly as the API returned them. They are what the client is
 * agreeing to, and what will execute if they cancel, however the platform's
 * current table changes afterwards (#16).
 */
export function bandSentences(bands: Band[], amountKobo: number): { when: string; outcome: string }[] {
  return [...bands]
    .sort((a, b) => b.minDaysBefore - a.minDaysBefore)
    .map((b) => {
      const when =
        b.maxDaysBefore === null
          ? `${b.minDaysBefore} or more days before`
          : b.minDaysBefore === 0 && b.maxDaysBefore === 0
            ? 'On the day of the event'
            : b.minDaysBefore === b.maxDaysBefore
              ? `${b.minDaysBefore} day${b.minDaysBefore === 1 ? '' : 's'} before`
              : `${b.minDaysBefore}–${b.maxDaysBefore} days before`;

      // In naira, from the same flooring rule the backend uses (R1): the
      // client's share is floored and the artist takes the remainder.
      const back = Math.floor((amountKobo * b.clientRefundBps) / 10_000);
      const outcome =
        b.clientRefundBps === 10_000
          ? `You get everything back — ${formatNaira(back)}.`
          : b.clientRefundBps === 0
            ? `Nothing comes back to you; the artist is paid for the date they held.`
            : `${pct(b.clientRefundBps)} comes back to you — ${formatNaira(back)}. ` +
              `The artist keeps ${pct(b.artistCompensationBps)} for the date they held.`;
      return { when, outcome };
    });
}
