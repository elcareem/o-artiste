/**
 * Commission rate configuration — docs/07-ADMIN-CONFIG.md §3.
 *
 * APPEND-ONLY. A rate change writes a NEW record and never touches an existing
 * one. Two reasons, and the second is the one people forget:
 *
 *   1. A rate change must never reach backwards. A booking made at 5% that is
 *      still awaiting payout when the rate moves to 7% must still pay out at
 *      5%, because that is the deal the artist accepted.
 *
 *   2. An audit trail of who changed the platform's take, and when, is basic
 *      financial control once real money is moving. A single mutable value
 *      makes that trail impossible to reconstruct.
 *
 * Note that (1) is guaranteed by the snapshot on Booking, not by this module.
 * This module's job is to answer "what was the rate at time T" correctly, and
 * to make every change attributable.
 */

const prisma = require('./../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const { recordAudit } = require('../lib/audit.ts');

const MIN_BPS = 0;
const MAX_BPS = 10000; // 100%

/**
 * Fallback rate used when no record exists at all.
 *
 * Matches the value seeded by `prisma/seed.js`, so a database that has been
 * seeded and one that has not price identically rather than diverging.
 *
 * The fallback is deliberately VISIBLE rather than silent: the record it
 * returns carries `isDefault: true`, which the admin endpoint surfaces and the
 * UI can flag, and the first use logs a warning. A silent fallback would price
 * real bookings off a number nobody configured, and the discrepancy would
 * surface only in a ledger that will not reconcile — the point is to avoid the
 * hard failure without losing the signal.
 */
const DEFAULT_BPS = 500; // 5%

let warnedAboutDefault = false;

/**
 * Returns the rate record in force at `at`.
 *
 * "In force" means the most recent record whose `effectiveFrom` is at or before
 * that moment. A record dated in the future is scheduled, not active, and is
 * correctly ignored until its time comes.
 *
 * @param {Date} at Defaults to now.
 * @param {object} client Prisma client or transaction.
 */
async function resolveCommissionRate(at: Date = new Date(), client: PrismaLike = prisma) {
  const record = await client.commissionRate.findFirst({
    where: { effectiveFrom: { lte: at } },
    // createdAt breaks ties deterministically when two records share an
    // effectiveFrom — the later-written one wins, which is the one an admin
    // most recently intended.
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });

  if (!record) return defaultRate();

  return { ...record, isDefault: false };
}

/**
 * The synthetic record used when nothing is configured. Not persisted — writing
 * it would make an unconfigured platform indistinguishable from a deliberately
 * configured one.
 */
function defaultRate() {
  if (!warnedAboutDefault) {
    warnedAboutDefault = true;
    console.warn(
      `[commission] No commission rate configured. Falling back to ${DEFAULT_BPS} bps (5%). ` +
        'Set one via PUT /admin/config/commission.'
    );
  }

  return {
    id: null,
    rateBasisPoints: DEFAULT_BPS,
    effectiveFrom: new Date(0),
    setByUserId: null,
    createdAt: new Date(0),
    isDefault: true,
  };
}

/** Convenience for callers that only need the number. */
async function resolveCommissionBps(at: Date = new Date(), client: PrismaLike = prisma): Promise<Bps> {
  return (await resolveCommissionRate(at, client)).rateBasisPoints;
}

/**
 * Writes a new rate record, with its audit row, in one transaction.
 *
 * The audit row is written with `recordAudit` inside the transaction rather
 * than best-effort: if the change cannot be attributed, the change must not
 * happen (docs/07 §5).
 */
async function setCommissionRate({
  rateBasisPoints,
  effectiveFrom,
  actorUserId,
  reason,
}: {
  rateBasisPoints: Bps;
  effectiveFrom?: Date | string;
  actorUserId: string;
  reason?: string | null;
}) {
  const bps = validateBps(rateBasisPoints);
  const from = validateEffectiveFrom(effectiveFrom);

  return prisma.$transaction(async (tx: PrismaTx) => {
    const previous = await tx.commissionRate.findFirst({
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });

    const created = await tx.commissionRate.create({
      data: { rateBasisPoints: bps, effectiveFrom: from, setByUserId: actorUserId },
    });

    await recordAudit(tx, {
      actorUserId,
      action: 'COMMISSION_RATE_CHANGED',
      entityType: 'CommissionRate',
      entityId: created.id,
      reason: reason ?? null,
      before: previous
        ? { rateBasisPoints: previous.rateBasisPoints, effectiveFrom: previous.effectiveFrom }
        : null,
      after: { rateBasisPoints: created.rateBasisPoints, effectiveFrom: created.effectiveFrom },
    });

    return created;
  });
}

/** Full history, newest first. Prior records remain queryable forever. */
function listCommissionRates(client: PrismaLike = prisma) {
  return client.commissionRate.findMany({
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });
}

function validateBps(value: unknown): Bps {
  // Rejects 5.5, "500", NaN and Infinity alike. Basis points are integers so
  // that 0.05 can never enter a money calculation (docs/00 §6).
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AppError(400, 'Commission rate must be a whole number of basis points, e.g. 500 for 5%.');
  }
  if (value < MIN_BPS || value > MAX_BPS) {
    throw new AppError(400, 'Commission rate must be between 0 and 10000 basis points (0% to 100%).');
  }
  return value;
}

function validateEffectiveFrom(value: unknown): Date {
  if (value === undefined || value === null) return new Date();

  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, 'Effective-from must be a valid date.');
  }

  // Forward-only. Backdating would rewrite what resolveCommissionRate reports
  // for moments that have already passed, which is the audit trail changing its
  // own history. Existing bookings are protected by their snapshots either way,
  // so backdating buys nothing and costs reconstructability.
  if (date.getTime() < Date.now() - 1000) {
    throw new AppError(400, 'A commission rate cannot take effect in the past.');
  }

  return date;
}

module.exports = {
  resolveCommissionRate,
  DEFAULT_BPS,
  resolveCommissionBps,
  setCommissionRate,
  listCommissionRates,
  MIN_BPS,
  MAX_BPS,
};
