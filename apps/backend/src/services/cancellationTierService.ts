/**
 * Cancellation tier configuration — docs/05-CANCELLATIONS-AND-FEES.md §5,
 * docs/07-ADMIN-CONFIG.md §3.
 *
 * Rows are ADDABLE AND DELETABLE, not merely editable. The band structure
 * itself will change — a 14-day tier may be introduced, or the day-of band
 * split into "cancelled before start time" and "failed to appear". Fixed rows
 * with editable percentages would force a deploy for what is fundamentally a
 * business decision.
 *
 * THE VALIDATION IS THE POINT OF THIS MODULE.
 *
 * A gap means a booking cancelled in that window has no applicable rule, and
 * there is no safe default: refunding everything harms the artist, refunding
 * nothing is FCCPA exposure. The validation makes an unresolvable state
 * unsaveable — which is the only way to guarantee it never has to be resolved
 * under pressure with money already held.
 *
 * Every message NAMES the offending bands or the uncovered window. "Invalid
 * tier set" tells an admin nothing they can act on.
 */

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const { recordAudit } = require('../lib/audit.ts');

const TOTAL_BPS = 10000;

/**
 * Validates a complete tier set. Throws AppError(400) with a specific message
 * on the first problem found; returns the set sorted ascending by band.
 *
 * Pure — no database, no clock. #36 mirrors these rules client-side for
 * immediate feedback, but the server stays authoritative: a tier table with a
 * gap must be unsaveable regardless of which path the request arrives by.
 */
function validateTierSet(tiers: CancellationTierSnapshot[]): CancellationTierSnapshot[] {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new AppError(400, 'Provide at least one cancellation band.');
  }

  tiers.forEach(validateRow);

  const openEnded = tiers.filter((t) => t.maxDaysBefore === null || t.maxDaysBefore === undefined);
  if (openEnded.length === 0) {
    throw new AppError(
      400,
      'One band must be open-ended (no upper limit), or cancellations made far in advance have no applicable rule.'
    );
  }
  if (openEnded.length > 1) {
    const starts = openEnded.map((t) => `day ${t.minDaysBefore}`).join(' and ');
    throw new AppError(400, `Only one band may be open-ended, but ${starts} both are.`);
  }

  const sorted = [...tiers].sort((a, b) => a.minDaysBefore - b.minDaysBefore);

  if (sorted[sorted.length - 1].maxDaysBefore !== null && sorted[sorted.length - 1].maxDaysBefore !== undefined) {
    throw new AppError(400, 'The open-ended band must be the one covering the longest notice.');
  }

  if (sorted[0].minDaysBefore !== 0) {
    throw new AppError(
      400,
      `Day 0 is not covered. The lowest band starts at day ${sorted[0].minDaysBefore}, so a booking cancelled on the event day has no applicable rule.`
    );
  }

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    // The open-ended band sorts last, so a null here means every later band
    // would be unreachable — treated as infinity rather than skipped.
    const previousEnd = previous.maxDaysBefore ?? Number.POSITIVE_INFINITY;

    if (current.minDaysBefore <= previousEnd) {
      throw new AppError(
        400,
        `Bands ${describe(previous)} and ${describe(current)} overlap. A cancellation in that window would match two rules.`
      );
    }

    if (current.minDaysBefore > previousEnd + 1) {
      const gapStart = previousEnd + 1;
      const gapEnd = current.minDaysBefore - 1;
      const window = gapStart === gapEnd ? `Day ${gapStart} is` : `Days ${gapStart} to ${gapEnd} are`;
      throw new AppError(
        400,
        `${window} not covered by any band. A cancellation in that window would have no applicable rule.`
      );
    }
  }

  return sorted;
}

function validateRow(tier: CancellationTierSnapshot, index: number): void {
  const label = `Band ${index + 1}`;

  if (!isNonNegativeInteger(tier?.minDaysBefore)) {
    throw new AppError(400, `${label}: the band start must be a whole number of days, 0 or more.`);
  }

  const hasMax = tier.maxDaysBefore !== null && tier.maxDaysBefore !== undefined;
  if (hasMax) {
    if (!isNonNegativeInteger(tier.maxDaysBefore)) {
      throw new AppError(400, `${label}: the band end must be a whole number of days, or empty for no upper limit.`);
    }
    if ((tier.maxDaysBefore as number) < tier.minDaysBefore) {
      throw new AppError(
        400,
        `${label}: the band ends at day ${tier.maxDaysBefore} but starts at day ${tier.minDaysBefore}.`
      );
    }
  }

  for (const field of ['clientRefundBps', 'artistCompensationBps'] as const) {
    if (!isNonNegativeInteger(tier?.[field]) || tier[field] > TOTAL_BPS) {
      throw new AppError(
        400,
        `${describe(tier)}: ${field} must be a whole number of basis points between 0 and ${TOTAL_BPS}.`
      );
    }
  }

  const sum = tier.clientRefundBps + tier.artistCompensationBps;
  if (sum !== TOTAL_BPS) {
    // The two percentages divide the BOOKING TOTAL. Platform commission is
    // applied to the artist's share afterwards, never carved out of this split
    // — conflating them silently changes what the client was shown.
    throw new AppError(
      400,
      `${describe(tier)}: client refund ${tier.clientRefundBps} + artist compensation ${tier.artistCompensationBps} = ${sum} basis points. They must sum to ${TOTAL_BPS}.`
    );
  }
}

function describe(tier: CancellationTierSnapshot): string {
  const end =
    tier.maxDaysBefore === null || tier.maxDaysBefore === undefined
      ? 'and above'
      : `to ${tier.maxDaysBefore}`;
  return `day ${tier.minDaysBefore} ${end}`;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Saves a validated set as a NEW version. Prior versions are never touched and
 * remain queryable forever.
 */
async function setCancellationTiers({
  tiers,
  effectiveFrom,
  actorUserId,
  reason,
}: {
  tiers: CancellationTierSnapshot[];
  effectiveFrom?: Date | string;
  actorUserId: string;
  reason?: string | null;
}) {
  const validated = validateTierSet(tiers);
  const from = validateEffectiveFrom(effectiveFrom);
  const versionId = `tiers_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return prisma.$transaction(async (tx: PrismaTx) => {
    const previousVersionId = await currentVersionId(new Date(), tx);

    await tx.cancellationTier.createMany({
      data: validated.map((tier) => ({
        versionId,
        minDaysBefore: tier.minDaysBefore,
        maxDaysBefore: tier.maxDaysBefore ?? null,
        clientRefundBps: tier.clientRefundBps,
        artistCompensationBps: tier.artistCompensationBps,
        effectiveFrom: from,
        setByUserId: actorUserId,
      })),
    });

    const created = await tx.cancellationTier.findMany({
      where: { versionId },
      orderBy: { minDaysBefore: 'asc' },
    });

    const previous = previousVersionId
      ? await tx.cancellationTier.findMany({
          where: { versionId: previousVersionId },
          orderBy: { minDaysBefore: 'asc' },
        })
      : [];

    await recordAudit(tx, {
      actorUserId,
      action: 'CANCELLATION_TIERS_CHANGED',
      entityType: 'CancellationTier',
      entityId: versionId,
      reason: reason ?? null,
      before: previous.length ? { versionId: previousVersionId, tiers: previous.map(publicTier) } : null,
      after: { versionId, tiers: created.map(publicTier) },
    });

    return { versionId, effectiveFrom: from, tiers: created };
  });
}

/** The version id in force at `at`, or null if none. */
async function currentVersionId(at: Date = new Date(), client: PrismaLike = prisma) {
  const latest = await client.cancellationTier.findFirst({
    where: { effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    select: { versionId: true },
  });
  return latest?.versionId ?? null;
}

/**
 * The full tier set in force at `at`.
 *
 * This is what #15 copies onto a booking at creation. Every later cancellation
 * calculation reads that snapshot, never this (docs/07 §4).
 */
async function resolveTierSet(at: Date = new Date(), client: PrismaLike = prisma) {
  const versionId = await currentVersionId(at, client);
  if (!versionId) {
    throw new AppError(
      500,
      'No cancellation tier table is configured. Bookings cannot be created until one is set.'
    );
  }
  const tiers = await client.cancellationTier.findMany({
    where: { versionId },
    orderBy: { minDaysBefore: 'asc' },
  });
  return { versionId, tiers };
}

/** Every version, newest first, each as a grouped set. */
async function listTierVersions(client: PrismaLike = prisma) {
  const rows = await client.cancellationTier.findMany({
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }, { minDaysBefore: 'asc' }],
  });

  const byVersion = new Map();
  for (const row of rows) {
    if (!byVersion.has(row.versionId)) {
      byVersion.set(row.versionId, {
        versionId: row.versionId,
        effectiveFrom: row.effectiveFrom,
        setByUserId: row.setByUserId,
        tiers: [],
      });
    }
    byVersion.get(row.versionId).tiers.push(publicTier(row));
  }

  for (const version of byVersion.values()) {
    version.tiers.sort(
      (a: CancellationTierSnapshot, b: CancellationTierSnapshot) => a.minDaysBefore - b.minDaysBefore
    );
  }

  return [...byVersion.values()];
}

function publicTier(row: CancellationTierSnapshot & { id?: string }) {
  return {
    minDaysBefore: row.minDaysBefore,
    maxDaysBefore: row.maxDaysBefore,
    clientRefundBps: row.clientRefundBps,
    artistCompensationBps: row.artistCompensationBps,
  };
}

function validateEffectiveFrom(value: unknown): Date {
  if (value === undefined || value === null) return new Date();
  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, 'Effective-from must be a valid date.');
  }
  if (date.getTime() < Date.now() - 1000) {
    throw new AppError(400, 'A cancellation tier table cannot take effect in the past.');
  }
  return date;
}

module.exports = {
  validateTierSet,
  setCancellationTiers,
  resolveTierSet,
  listTierVersions,
  currentVersionId,
  TOTAL_BPS,
};
