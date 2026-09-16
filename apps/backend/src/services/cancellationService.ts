/**
 * Cancellation — docs/05-CANCELLATIONS-AND-FEES.md §5, issue #27.
 *
 * THE TIER COMES FROM THE BOOKING'S SNAPSHOT, NEVER THE LIVE TABLE. That is the
 * entire payoff of #15's snapshot and #16's acknowledgement: the client agreed
 * to specific percentages, and those percentages execute however the
 * configuration changes afterwards. A cancellation that read live configuration
 * would make the acknowledgement a record of something that did not happen.
 *
 * The arithmetic lives in `feeService` and the money movement in
 * `escrowService`. This module resolves which tier applies and to what, which
 * is the part that depends on a calendar.
 */

const { AppError } = require('../lib/errors.ts');

/** Nigeria is UTC+1 year-round, with no daylight saving. */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days from a cancellation to the event, counted in Africa/Lagos.
 *
 * CALENDAR DAYS, NOT ELAPSED HOURS DIVIDED BY 24. A client cancelling at 23:00
 * on Monday for a Wednesday 09:00 event has 34 hours in hand, which floors to
 * 1 — but in the only calendar anyone involved is using, that is two days
 * before. The tiers are read by people as "a week before", "the day before",
 * and the boundary between a 70% refund and a 40% one must fall where they
 * would put it.
 *
 * Both instants are shifted into Lagos and truncated to midnight before
 * subtracting, so the answer is a difference of dates rather than of durations.
 *
 * Day 0 means cancelling on the event day. A cancellation after the event
 * returns a negative number, which no band covers — `resolveTier` refuses it
 * rather than guessing.
 */
function daysBeforeEvent(eventDate: Date | string, at: Date | string = new Date()): number {
  const midnightInLagos = (value: Date | string) => {
    const shifted = new Date(new Date(value).getTime() + LAGOS_OFFSET_MS);
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  };

  return Math.round((midnightInLagos(eventDate) - midnightInLagos(at)) / DAY_MS);
}

/**
 * The band covering `days`, from the booking's own snapshot.
 *
 * #8's validation guarantees a valid set has no gaps, no overlaps and covers
 * day 0 — so for any day from 0 upwards exactly one band matches. Reaching the
 * end of the list therefore means either a booking snapshotted before that
 * validation existed, or a cancellation after the event. Both throw: there is
 * no safe default here, because refunding everything harms the artist and
 * refunding nothing is FCCPA exposure (docs/05 §5).
 */
function resolveTier(
  tiers: CancellationTierSnapshot[],
  days: number
): CancellationTierSnapshot {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new AppError(500, 'This booking has no cancellation terms recorded against it.');
  }

  if (days < 0) {
    throw new AppError(
      409,
      'This event has already taken place, so it cannot be cancelled. Confirm it or report a no-show instead.'
    );
  }

  const tier = tiers.find(
    (t) => days >= t.minDaysBefore && (t.maxDaysBefore === null || days <= t.maxDaysBefore)
  );

  if (!tier) {
    // Unreachable for any set #8 would have accepted. Loud rather than guessed.
    throw new AppError(
      500,
      `No cancellation tier covers ${days} day(s) before this booking's event.`
    );
  }

  return tier;
}

/** The booking's frozen tier set, as an array. */
function tiersOf(booking: { cancellationTiersSnapshot: unknown }): CancellationTierSnapshot[] {
  const snapshot = booking.cancellationTiersSnapshot;
  return Array.isArray(snapshot) ? (snapshot as CancellationTierSnapshot[]) : [];
}

/** Which tier applies to cancelling this booking now, and how far out that is. */
function applicableTier(
  booking: { cancellationTiersSnapshot: unknown; eventDate: Date | string },
  at: Date = new Date()
): { tier: CancellationTierSnapshot; daysBefore: number } {
  const daysBefore = daysBeforeEvent(booking.eventDate, at);
  return { tier: resolveTier(tiersOf(booking), daysBefore), daysBefore };
}

module.exports = { daysBeforeEvent, resolveTier, tiersOf, applicableTier, LAGOS_OFFSET_MS };
