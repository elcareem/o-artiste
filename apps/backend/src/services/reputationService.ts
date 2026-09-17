/**
 * The cancellation rate — docs/06 §6, issue #35.
 *
 * TWO RULES MAKE THIS STATISTIC FAIR RATHER THAN MERELY AVAILABLE.
 *
 * A rolling window, not a lifetime figure. An artist who had a bad year and
 * then improved should not carry it indefinitely: a permanent statistic gives
 * no path back and stops measuring current reliability, which is the only thing
 * a client looking at it actually wants to know.
 *
 * A minimum booking count before it is shown at all. "100% cancellation rate"
 * on an artist with one cancelled booking is not information, it is noise
 * presented as a verdict.
 *
 * BELOW THE THRESHOLD THE ANSWER IS `null`, AND THE UI RENDERS NOTHING — not
 * `0%`, which implies a perfect record that has not been earned, and not `N/A`,
 * which draws attention to an absence and reads as a warning.
 */

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const { recordAudit } = require('../lib/audit.ts');

/** Open item `docs/00` §11.7 — the right numbers need real booking data. */
const DEFAULT_WINDOW_MONTHS = 12;
const DEFAULT_MIN_BOOKINGS = 5;

/**
 * The configuration in force.
 *
 * Falls back to the shipped defaults when nothing is published, so a fresh
 * deployment computes a defensible figure rather than none at all.
 */
async function resolveConfig(
  at: Date = new Date(),
  client: PrismaLike = prisma
): Promise<ReputationSettings> {
  const latest = await (client as any).reputationConfig.findFirst({
    where: { effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });

  return latest
    ? { windowMonths: latest.windowMonths, minBookings: latest.minBookings, isDefault: false }
    : {
        windowMonths: DEFAULT_WINDOW_MONTHS,
        minBookings: DEFAULT_MIN_BOOKINGS,
        isDefault: true,
      };
}

/** The earliest conclusion date still inside the window. */
function windowStart(windowMonths: number, at: Date = new Date()): Date {
  const start = new Date(at);
  start.setMonth(start.getMonth() - windowMonths);
  return start;
}

/**
 * The cancellation rate for one party, or `null` below the threshold.
 *
 * THE WINDOW IS MEASURED ON THE BOOKING'S CONCLUSION, not its creation, and
 * numerator and denominator share that basis. "Of the bookings that concluded
 * in the last twelve months, what fraction did you cancel?" is a question with
 * one answer; mixing the two dates produces a figure that can exceed 100% or
 * silently drop a recent cancellation of an old booking.
 *
 * In-flight bookings are excluded entirely. A booking whose outcome is unknown
 * is not evidence either way, and counting it in the denominator would let
 * someone dilute their rate simply by making bookings.
 *
 * A RECLASSIFIED CANCELLATION COUNTS AGAINST THE ARTIST, NOT THE CLIENT. That
 * is the entire point of #29: the client cancelled because of the artist's
 * conduct, and leaving it on the client's record would publish a statistic the
 * platform has already ruled is wrong.
 */
async function rateFor({
  userId,
  party,
  at = new Date(),
}: {
  userId: string;
  party: 'ARTIST' | 'CLIENT';
  at?: Date;
}): Promise<CancellationRateResult> {
  const config = await resolveConfig(at);
  const since = windowStart(config.windowMonths, at);

  const concluded = await concludedBookings({ userId, party, since, at });

  if (concluded.length < config.minBookings) {
    return {
      rate: null,
      concluded: concluded.length,
      cancelled: 0,
      minBookings: config.minBookings,
      windowMonths: config.windowMonths,
      belowThreshold: true,
    };
  }

  const cancelled = concluded.filter((booking: any) => attributableTo(booking, party)).length;

  return {
    // Whole percent. A rate rendered to one decimal invites a precision the
    // sample size does not support.
    rate: Math.round((cancelled / concluded.length) * 100),
    concluded: concluded.length,
    cancelled,
    minBookings: config.minBookings,
    windowMonths: config.windowMonths,
    belowThreshold: false,
  };
}

/** Bookings that reached an outcome inside the window. */
async function concludedBookings({
  userId,
  party,
  since,
  at,
}: {
  userId: string;
  party: 'ARTIST' | 'CLIENT';
  since: Date;
  at: Date;
}) {
  return prisma.booking.findMany({
    where: {
      ...(party === 'ARTIST' ? { artist: { userId } } : { client: { userId } }),
      state: { in: ['RELEASED', 'REFUNDED', 'CANCELLED', 'RESOLVED'] as BookingState[] },
      OR: [
        { cancelledAt: { gte: since, lte: at } },
        { refundedAt: { gte: since, lte: at } },
        { releasedAt: { gte: since, lte: at } },
      ],
    },
    include: { cancellation: true },
  });
}

/**
 * Whether this booking's cancellation is attributable to the given party.
 *
 * A booking that was refunded or released without a `Cancellation` row — a
 * dispute, an uncontradicted no-show — counts in the denominator but against
 * nobody. It concluded, and neither party walked away from it.
 */
function attributableTo(
  booking: BookingRow & { cancellation: CancellationRow | null },
  party: 'ARTIST' | 'CLIENT'
): boolean {
  const cancellation = booking.cancellation;
  if (!cancellation) return false;

  // #29: the platform has ruled this was the artist's doing.
  if (cancellation.reclassifiedAsArtistFault) return party === 'ARTIST';

  return cancellation.initiatedBy === party;
}

/**
 * Rates for many artists at once.
 *
 * The listing shows this beside every artist, and doing it one query per row
 * makes a page of twenty artists twenty round trips. One pass, grouped in
 * memory.
 */
async function ratesForArtists(
  artistUserIds: string[],
  at: Date = new Date()
): Promise<Map<string, number | null>> {
  const rates = new Map<string, number | null>();
  if (artistUserIds.length === 0) return rates;

  const config = await resolveConfig(at);
  const since = windowStart(config.windowMonths, at);

  const bookings = await prisma.booking.findMany({
    where: {
      artist: { userId: { in: artistUserIds } },
      state: { in: ['RELEASED', 'REFUNDED', 'CANCELLED', 'RESOLVED'] as BookingState[] },
      OR: [
        { cancelledAt: { gte: since, lte: at } },
        { refundedAt: { gte: since, lte: at } },
        { releasedAt: { gte: since, lte: at } },
      ],
    },
    include: { cancellation: true, artist: { select: { userId: true } } },
  });

  const byArtist = new Map<string, { total: number; cancelled: number }>();
  for (const id of artistUserIds) byArtist.set(id, { total: 0, cancelled: 0 });

  for (const booking of bookings) {
    const bucket = byArtist.get((booking as any).artist.userId);
    if (!bucket) continue;
    bucket.total += 1;
    if (attributableTo(booking as any, 'ARTIST')) bucket.cancelled += 1;
  }

  for (const [id, bucket] of byArtist) {
    rates.set(
      id,
      bucket.total < config.minBookings
        ? null
        : Math.round((bucket.cancelled / bucket.total) * 100)
    );
  }

  return rates;
}

/** Publishes new settings. Append-only, like every other configuration. */
async function setReputationConfig({
  windowMonths,
  minBookings,
  actorUserId,
  effectiveFrom = new Date(),
}: {
  windowMonths: number;
  minBookings: number;
  actorUserId: string;
  effectiveFrom?: Date;
}): Promise<ReputationConfigRow> {
  if (!Number.isInteger(windowMonths) || windowMonths < 1) {
    throw new AppError(400, 'The window must be a whole number of months, at least 1.');
  }
  if (!Number.isInteger(minBookings) || minBookings < 1) {
    // A threshold of zero publishes a verdict on a single booking, which is the
    // exact failure docs/06 §6 exists to prevent.
    throw new AppError(
      400,
      'At least one booking must be required before a rate is shown. A threshold of zero publishes a verdict on a single booking.'
    );
  }

  return prisma.$transaction(async (tx: PrismaTx) => {
    const created = await tx.reputationConfig.create({
      data: { windowMonths, minBookings, effectiveFrom, setByUserId: actorUserId },
    });

    await recordAudit(tx, {
      actorUserId,
      action: 'REPUTATION_CONFIG_UPDATED',
      entityType: 'ReputationConfig',
      entityId: created.id,
      after: { windowMonths, minBookings, effectiveFrom },
    });

    return created;
  });
}

module.exports = {
  resolveConfig,
  windowStart,
  rateFor,
  ratesForArtists,
  attributableTo,
  setReputationConfig,
  DEFAULT_WINDOW_MONTHS,
  DEFAULT_MIN_BOOKINGS,
};
