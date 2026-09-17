/**
 * Strike consequences and enforcement — docs/06 §5, issue #34.
 *
 * THE ACCOUNT CONSEQUENCE IS THE DETERRENT, NOT THE FEE. A ₦2,070 liability is
 * a rounding error to a working artist; losing listing visibility is not. A
 * client left scrambling for a replacement act two days before their event has
 * suffered a harm no cancellation percentage compensates, and the only
 * meaningful response is to make it less likely to happen again.
 *
 * Two ladders, and they differ on purpose:
 *
 *   artist   strike accrual → suspension pending review → permanent removal
 *   client   warning → restricted booking → suspension
 *
 * The client ladder has a middle rung because minimum-lead-time enforcement
 * addresses the SPECIFIC failure mode — last-minute cancellation — without
 * removing an otherwise usable customer. A client who cancels late twice can
 * still book a month out, which is the behaviour we actually want from them.
 */

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const { recordAudit } = require('../lib/audit.ts');

/**
 * The shipped ladders — open item `docs/00` §11.6.
 *
 * Chosen to cohere with #33's default weights rather than picked separately:
 * `ARTIST_CANCEL_DAY_OF` is weight 3, so a single day-of cancellation lands
 * exactly on suspension, which is what docs/06 §2 says it should.
 * `DISPUTE_FALSE_NO_SHOW_CLAIM` is weight 3, so one attempt to obtain a
 * performance for free restricts a client immediately.
 */
const DEFAULT_LADDERS: EnforcementRuleInput[] = [
  // Artist — docs/06 §5. No warning rung: an artist cancellation severe enough
  // to strike is severe enough to review.
  { party: 'ARTIST', minWeight: 3, standing: 'SUSPENDED', minLeadDays: null },
  { party: 'ARTIST', minWeight: 6, standing: 'REMOVED', minLeadDays: null },

  // Client — the middle rung is the point of this ladder.
  { party: 'CLIENT', minWeight: 1, standing: 'WARNED', minLeadDays: null },
  { party: 'CLIENT', minWeight: 3, standing: 'RESTRICTED', minLeadDays: 14 },
  { party: 'CLIENT', minWeight: 5, standing: 'SUSPENDED', minLeadDays: null },
];

/** How severe each standing is, for picking the harshest matching rung. */
const SEVERITY: Record<AccountStanding, number> = {
  GOOD: 0,
  WARNED: 1,
  RESTRICTED: 2,
  SUSPENDED: 3,
  REMOVED: 4,
};

/**
 * The ladder set in force.
 *
 * Falls back to the shipped defaults when nothing is published, for the reason
 * #33 does: a system that quietly stops enforcing because a table is empty is
 * worse than one that refuses to start.
 */
async function resolveLadders(
  at: Date = new Date(),
  client: PrismaLike = prisma
): Promise<{ rules: EnforcementRuleRow[]; versionId: string | null; isDefault: boolean }> {
  const latest = await (client as any).enforcementRule.findFirst({
    where: { effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });

  if (!latest) {
    return { rules: DEFAULT_LADDERS as EnforcementRuleRow[], versionId: null, isDefault: true };
  }

  const rules = await (client as any).enforcementRule.findMany({
    where: { versionId: latest.versionId },
    orderBy: { minWeight: 'asc' },
  });

  return { rules, versionId: latest.versionId, isDefault: false };
}

/**
 * The rung that applies at this weight, or null for none.
 *
 * THE HARSHEST MATCHING RUNG WINS. Rungs are cumulative — a client at weight 5
 * matches WARNED, RESTRICTED and SUSPENDED — and picking the lowest would mean
 * accruing strikes made an account *safer*.
 */
function rungFor(
  rules: EnforcementRuleRow[],
  party: EnforcementParty,
  weight: number
): EnforcementRuleRow | null {
  const matching = rules.filter((r) => r.party === party && weight >= r.minWeight);
  if (matching.length === 0) return null;

  return matching.reduce((worst, rule) =>
    SEVERITY[rule.standing] > SEVERITY[worst.standing] ? rule : worst
  );
}

/**
 * Re-derives a user's standing from their active strikes and applies it.
 *
 * Called inside the transaction that wrote the strike, so an account whose
 * conduct changed and an account whose standing changed are never two different
 * facts.
 *
 * STANDING IS NEVER LOWERED HERE. An admin who lifted a suspension has made a
 * decision, and a later unrelated strike recomputing from weight alone would
 * silently overturn it. Enforcement only ever escalates; relief is an explicit
 * admin act (`review`).
 */
async function applyStanding(
  tx: PrismaTx,
  { userId, party, at = new Date() }: { userId: string; party: EnforcementParty; at?: Date }
): Promise<StandingChange | null> {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const strikes = await tx.strike.findMany({ where: { userId, active: true } });
  const weight = strikes.reduce((total: number, s: StrikeRow) => total + s.weight, 0);

  const { rules } = await resolveLadders(at, tx);
  const rung = rungFor(rules, party, weight);
  if (!rung) return null;

  if (SEVERITY[rung.standing] <= SEVERITY[user.accountStanding as AccountStanding]) {
    return null;
  }

  await tx.user.update({
    where: { id: userId },
    data: {
      accountStanding: rung.standing,
      // Only meaningful on the RESTRICTED rung; cleared otherwise so a later
      // suspension does not leave a stale lead time behind it.
      restrictedMinLeadDays: rung.standing === 'RESTRICTED' ? rung.minLeadDays : null,
    },
  });

  await recordAudit(tx, {
    actorUserId: null,
    action: 'ACCOUNT_STANDING_CHANGED',
    entityType: 'User',
    entityId: userId,
    reason: `Accumulated strike weight ${weight} reached the ${rung.standing.toLowerCase()} threshold.`,
    before: { accountStanding: user.accountStanding },
    after: { accountStanding: rung.standing, weight, minLeadDays: rung.minLeadDays },
  });

  return {
    userId,
    from: user.accountStanding as AccountStanding,
    to: rung.standing,
    weight,
    minLeadDays: rung.standing === 'RESTRICTED' ? rung.minLeadDays : null,
  };
}

/**
 * Tells someone their standing changed, and why.
 *
 * A consequence discovered by failing to book is a support ticket. A
 * consequence someone was told about is a deterrent (docs/06 §5). Called after
 * the transaction commits, because a message sent for a change that then rolled
 * back is worse than a late one.
 */
async function notifyStandingChange(change: StandingChange): Promise<void> {
  try {
    const user = await prisma.user.findUnique({ where: { id: change.userId } });
    if (!user?.phone) return;

    const { sendSms } = require('../lib/notifications.ts');
    await sendSms({
      to: user.phone,
      message: standingMessage(change),
      reference: `standing:${change.userId}`,
    });
  } catch (err) {
    // Never fatal. The standing change is already recorded and enforced; a
    // failed message must not undo it.
    console.error(`[enforcement] could not notify ${change.userId}: ${(err as Error).message}`);
  }
}

/** One segment, plain language, and it says what to do next. */
function standingMessage(change: StandingChange): string {
  switch (change.to) {
    case 'WARNED':
      return 'o-artiste: a cancellation has been recorded against your account. Another may limit how you can book. Reply HELP to talk to us.';
    case 'RESTRICTED':
      return `o-artiste: your account is limited — you can now only book at least ${change.minLeadDays ?? 14} days ahead. This is because of repeated late cancellations. Reply HELP to talk to us.`;
    case 'SUSPENDED':
      return 'o-artiste: your account is suspended pending review and cannot be used for new bookings. Reply HELP to talk to us.';
    case 'REMOVED':
      return 'o-artiste: your account has been removed and can no longer be used. Reply HELP if you believe this is wrong.';
    default:
      return 'o-artiste: your account standing has changed. Reply HELP to talk to us.';
  }
}

/**
 * Refuses a booking a restricted client is not allowed to make.
 *
 * THE RESTRICTION IS THE SPECIFIC FAILURE MODE, not a general punishment: a
 * client who cancels late is blocked from booking late, and left free to book
 * well ahead. Removing them entirely would cost the platform a usable customer
 * to prevent a harm that the lead time already prevents.
 */
function assertWithinLeadTime(user: UserRow, eventDate: Date | string): void {
  if (user.accountStanding !== 'RESTRICTED') return;

  const minDays = user.restrictedMinLeadDays;
  if (minDays === null || minDays === undefined) return;

  const { daysBeforeEvent } = require('./cancellationService.ts');
  const days = daysBeforeEvent(eventDate);

  if (days < minDays) {
    throw new AppError(
      403,
      `Because of previous late cancellations, you can only book events at least ${minDays} days ahead. ` +
        `This one is ${days < 0 ? 'in the past' : `${days} day${days === 1 ? '' : 's'} away`}. ` +
        'Contact support if you need to book sooner.'
    );
  }
}

/**
 * An admin reviews a strike — overrides it, or expires it.
 *
 * Every strike is appealable (docs/06 §5). The strike is DEACTIVATED, never
 * deleted: it happened, and the record of it happening and then being overturned
 * is more useful than its absence. Standing is recomputed afterwards, and this
 * is the one path that may lower it.
 */
async function reviewStrike({
  strikeId,
  actorUserId,
  reason,
  expiresAt,
}: ReviewStrikeInput): Promise<StrikeReviewResult> {
  if (!reason || !String(reason).trim()) {
    throw new AppError(400, 'Record why this strike is being overridden.');
  }

  const strike = await prisma.strike.findUnique({
    where: { id: strikeId },
    include: { user: true },
  });
  if (!strike) throw new AppError(404, 'Strike not found.');

  if (!strike.active) {
    throw new AppError(409, 'This strike has already been overridden.');
  }

  const party: EnforcementParty = strike.user.role === 'ARTIST' ? 'ARTIST' : 'CLIENT';

  const result = await prisma.$transaction(async (tx: PrismaTx) => {
    await tx.strike.update({
      where: { id: strikeId },
      data: {
        active: false,
        overriddenByUserId: actorUserId,
        overrideReason: String(reason).slice(0, 2000),
        overriddenAt: new Date(),
        ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
      },
    });

    const remaining = await tx.strike.findMany({ where: { userId: strike.userId, active: true } });
    const weight = remaining.reduce((total: number, s: StrikeRow) => total + s.weight, 0);

    const { rules } = await resolveLadders(new Date(), tx);
    const rung = rungFor(rules, party, weight);
    const standing: AccountStanding = rung?.standing ?? 'GOOD';

    // The one path that may LOWER standing. Recomputing from the remaining
    // strikes is the point of an override: removing a strike that should not
    // have been issued must undo what it caused.
    await tx.user.update({
      where: { id: strike.userId },
      data: {
        accountStanding: standing,
        restrictedMinLeadDays: standing === 'RESTRICTED' ? (rung?.minLeadDays ?? null) : null,
      },
    });

    await recordAudit(tx, {
      actorUserId,
      action: 'STRIKE_OVERRIDDEN',
      entityType: 'Strike',
      entityId: strikeId,
      reason: String(reason).slice(0, 2000),
      before: { active: true, accountStanding: strike.user.accountStanding },
      after: { active: false, accountStanding: standing, remainingWeight: weight },
    });

    return { standing, weight, previousStanding: strike.user.accountStanding as AccountStanding };
  });

  if (result.standing !== result.previousStanding) {
    await notifyStandingChange({
      userId: strike.userId,
      from: result.previousStanding,
      to: result.standing,
      weight: result.weight,
      minLeadDays: null,
    });
  }

  console.log(`[enforcement] strike ${strikeId} overridden by ${actorUserId}`);

  return {
    strikeId,
    userId: strike.userId,
    standing: result.standing,
    remainingWeight: result.weight,
  };
}

/** Publishes a new ladder set. Append-only, like every other configuration. */
async function setEnforcementLadders({
  rules,
  actorUserId,
  effectiveFrom = new Date(),
}: {
  rules: EnforcementRuleInput[];
  actorUserId: string;
  effectiveFrom?: Date;
}): Promise<{ versionId: string; rules: EnforcementRuleRow[] }> {
  validateLadders(rules);

  const versionId = `er_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  return prisma.$transaction(async (tx: PrismaTx) => {
    await tx.enforcementRule.createMany({
      data: rules.map((r) => ({
        versionId,
        party: r.party,
        minWeight: r.minWeight,
        standing: r.standing,
        minLeadDays: r.minLeadDays ?? null,
        effectiveFrom,
        setByUserId: actorUserId,
      })),
    });

    await recordAudit(tx, {
      actorUserId,
      action: 'ENFORCEMENT_LADDERS_UPDATED',
      entityType: 'EnforcementRule',
      entityId: versionId,
      after: { versionId, rules } as unknown as import('@prisma/client').Prisma.InputJsonValue,
    });

    return {
      versionId,
      rules: await tx.enforcementRule.findMany({
        where: { versionId },
        orderBy: { minWeight: 'asc' },
      }),
    };
  });
}

function validateLadders(rules: EnforcementRuleInput[]): void {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new AppError(400, 'Provide at least one enforcement rung.');
  }

  for (const rule of rules) {
    if (rule.party !== 'ARTIST' && rule.party !== 'CLIENT') {
      throw new AppError(400, 'Every rung must apply to an artist or a client.');
    }
    if (!Number.isInteger(rule.minWeight) || rule.minWeight < 1) {
      throw new AppError(
        400,
        `${rule.party}: minWeight must be a whole number of at least 1, received ${rule.minWeight}.`
      );
    }
    if (rule.standing === 'GOOD') {
      // A rung to GOOD is not a consequence, and having one would let a
      // published ladder silently clear an existing suspension.
      throw new AppError(400, 'A rung cannot set standing back to good. Override the strike instead.');
    }
    if (rule.standing === 'RESTRICTED' && !Number.isInteger(rule.minLeadDays)) {
      throw new AppError(
        400,
        'A restricted rung must say how many days ahead the client may still book.'
      );
    }
  }
}

module.exports = {
  resolveLadders,
  rungFor,
  applyStanding,
  notifyStandingChange,
  standingMessage,
  assertWithinLeadTime,
  reviewStrike,
  setEnforcementLadders,
  validateLadders,
  DEFAULT_LADDERS,
  SEVERITY,
};
