/**
 * Strike accrual — docs/06-REPUTATION-AND-STRIKES.md, issue #33.
 *
 * BOTH SIDES ACCRUE. An asymmetric system where only artists face consequences
 * leaves client misconduct costless, and client misconduct is the more
 * dangerous kind here: a client who cancels late has inconvenienced an artist,
 * while a client who receives a performance and then claims it never happened
 * has attempted theft. Treating those identically misprices the behaviour the
 * platform most needs to deter, which is why the weights differ.
 *
 * THIS MODULE IS THE ENGINE, NOT THE TRIGGERS. #28 and #29 call it when a
 * cancellation is recorded and #32 calls it when a dispute is ruled. Building
 * it first is how the circular dependency in the backlog was resolved — #33
 * listed #28 as a dependency and #28 listed #33 (docs/08 §2).
 *
 * Enforcement — suspension, restricted booking, removal — is #34. A strike
 * recorded here changes nothing about an account on its own.
 */

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const { recordAudit } = require('../lib/audit.ts');

/**
 * The shipped defaults — open item `docs/00` §11.6.
 *
 * The real numbers are not knowable until there is data on how often each
 * trigger fires, so these are a starting position, not a decision. What matters
 * structurally is the ORDERING: a false no-show ruling outweighs a late
 * cancellation, because one is an attempt to obtain a performance for free and
 * the other is poor planning.
 *
 * There is deliberately no row for a cancellation seven or more days out.
 */
const DEFAULT_RULES: StrikeRuleInput[] = [
  // Artist cancellations — docs/06 §2.
  { trigger: 'ARTIST_CANCEL_3_6_DAYS', weight: 1, minDaysBefore: 3, maxDaysBefore: 6 },
  { trigger: 'ARTIST_CANCEL_1_2_DAYS', weight: 2, minDaysBefore: 1, maxDaysBefore: 2 },
  { trigger: 'ARTIST_CANCEL_DAY_OF', weight: 3, minDaysBefore: 0, maxDaysBefore: 0 },

  // Client cancellations — docs/06 §3. Both bands are "standard": a client who
  // cancels late has inconvenienced someone, not defrauded them.
  { trigger: 'CLIENT_CANCEL_1_2_DAYS', weight: 1, minDaysBefore: 1, maxDaysBefore: 2 },
  { trigger: 'CLIENT_CANCEL_DAY_OF', weight: 1, minDaysBefore: 0, maxDaysBefore: 0 },

  // Dispute outcomes — not timing-based, so no band.
  { trigger: 'DISPUTE_RULED_AGAINST', weight: 1, minDaysBefore: null, maxDaysBefore: null },
  { trigger: 'DISPUTE_FALSE_NO_SHOW_CLAIM', weight: 3, minDaysBefore: null, maxDaysBefore: null },
];

/** Which triggers describe an artist cancelling, in severity order. */
const ARTIST_CANCELLATION_TRIGGERS: StrikeTrigger[] = [
  'ARTIST_CANCEL_3_6_DAYS',
  'ARTIST_CANCEL_1_2_DAYS',
  'ARTIST_CANCEL_DAY_OF',
];

const CLIENT_CANCELLATION_TRIGGERS: StrikeTrigger[] = [
  'CLIENT_CANCEL_1_2_DAYS',
  'CLIENT_CANCEL_DAY_OF',
];

/**
 * The rule set in force at `at`.
 *
 * Falls back to `DEFAULT_RULES` when nothing has been published, so a fresh
 * database accrues correctly rather than silently accruing nothing. A system
 * that quietly stops recording misconduct because a table is empty is worse
 * than one that refuses to start.
 */
async function resolveRules(
  at: Date = new Date(),
  client: PrismaLike = prisma
): Promise<{ rules: StrikeRuleRow[]; versionId: string | null; isDefault: boolean }> {
  const latest = await (client as any).strikeRule.findFirst({
    where: { effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  });

  if (!latest) {
    return { rules: DEFAULT_RULES as StrikeRuleRow[], versionId: null, isDefault: true };
  }

  const rules = await (client as any).strikeRule.findMany({
    where: { versionId: latest.versionId },
    orderBy: { trigger: 'asc' },
  });

  return { rules, versionId: latest.versionId, isDefault: false };
}

/**
 * The trigger for a cancellation this many days out, or `null` for none.
 *
 * `null` is a real answer, not a failure. Seven days out is a normal business
 * event and no rule covers it.
 */
function triggerForCancellation(
  rules: StrikeRuleRow[],
  by: 'ARTIST' | 'CLIENT',
  daysBefore: number
): StrikeRuleRow | null {
  const candidates = by === 'ARTIST' ? ARTIST_CANCELLATION_TRIGGERS : CLIENT_CANCELLATION_TRIGGERS;

  return (
    rules.find(
      (r) =>
        candidates.includes(r.trigger) &&
        r.minDaysBefore !== null &&
        daysBefore >= r.minDaysBefore &&
        (r.maxDaysBefore === null || daysBefore <= r.maxDaysBefore)
    ) ?? null
  );
}

/** The trigger for a dispute ruled against someone. */
function triggerForDispute(rules: StrikeRuleRow[], falseNoShowClaim: boolean): StrikeRuleRow | null {
  const wanted: StrikeTrigger = falseNoShowClaim
    ? 'DISPUTE_FALSE_NO_SHOW_CLAIM'
    : 'DISPUTE_RULED_AGAINST';
  return rules.find((r) => r.trigger === wanted) ?? null;
}

/**
 * What a cancellation costs the artist's standing, in words — docs/06 §2.
 *
 * The weight is a number for the enforcement ladders; this is the sentence an
 * artist reads BEFORE deciding. "Strike + suspension pending review" is a
 * materially different decision from "no strike", and discovering which one
 * applied afterwards is not a deterrent, it is a grievance.
 */
function consequenceOfArtistCancellation(
  rule: StrikeRuleRow | null
): ArtistCancellationConsequence {
  if (!rule) {
    return {
      trigger: null,
      weight: 0,
      // Seven days out is a normal business event. The fees were still
      // incurred, so the liability stands — there is simply nothing to deter.
      summary: 'No strike. You will still owe the escrow fees for this booking.',
      suspends: false,
      publishesRate: false,
    };
  }

  switch (rule.trigger) {
    case 'ARTIST_CANCEL_DAY_OF':
      return {
        trigger: rule.trigger,
        weight: rule.weight,
        summary:
          'A strike, and your account is suspended pending review — you will not appear in search or be bookable until someone has looked at it.',
        suspends: true,
        publishesRate: true,
      };
    case 'ARTIST_CANCEL_1_2_DAYS':
      return {
        trigger: rule.trigger,
        weight: rule.weight,
        summary:
          'A strike, and your cancellation rate becomes visible to clients on your profile.',
        suspends: false,
        publishesRate: true,
      };
    default:
      return {
        trigger: rule.trigger,
        weight: rule.weight,
        summary: 'A strike on your account.',
        suspends: false,
        publishesRate: false,
      };
  }
}

/**
 * Records a strike, inside the caller's transaction.
 *
 * Takes the transaction because a strike and the event that caused it must
 * commit together: a cancellation recorded without its strike is a conduct
 * record that quietly under-reports, and a strike recorded without its
 * cancellation cannot be reviewed.
 *
 * EVERY STRIKE CARRIES ITS CAUSE — the triggering booking, the reason, the
 * weight and the timestamp. Every one of these is appealable (docs/06 §5), and
 * a strike whose cause cannot be reconstructed is not reviewable.
 */
async function accrue(
  tx: PrismaTx,
  { userId, rule, bookingId, reason }: AccrueStrikeInput
): Promise<StrikeRow> {
  if (!userId) throw new AppError(500, 'A strike must name the user it applies to.');
  if (!reason) throw new AppError(500, 'A strike must record why it was issued.');

  const strike = await tx.strike.create({
    data: {
      userId,
      trigger: rule.trigger,
      weight: rule.weight,
      reason,
      bookingId: bookingId ?? null,
    },
  });

  // Written in the same transaction, for the same reason the strike is: this is
  // an adverse action against a person's account.
  await recordAudit(tx, {
    actorUserId: null,
    action: 'STRIKE_ACCRUED',
    entityType: 'Strike',
    entityId: strike.id,
    reason,
    after: { userId, trigger: rule.trigger, weight: rule.weight, bookingId: bookingId ?? null },
  });

  // THE CONSEQUENCE IS APPLIED IN THE SAME TRANSACTION AS THE STRIKE. An
  // account whose conduct changed and an account whose standing changed must
  // never be two different facts — a strike recorded without its consequence is
  // a deterrent that did not deter.
  //
  // #34 owns the ladders. This only says when to re-derive.
  const enforcement = require('./enforcementService.ts');
  const user = await tx.user.findUnique({ where: { id: userId } });
  const change = user
    ? await enforcement.applyStanding(tx, {
        userId,
        party: user.role === 'ARTIST' ? 'ARTIST' : 'CLIENT',
      })
    : null;

  console.log(
    `[strike] ${rule.trigger} weight ${rule.weight} against ${userId}` +
      (bookingId ? ` for booking ${bookingId}` : '') +
      (change ? ` — standing ${change.from} → ${change.to}` : '')
  );

  // Handed back so the caller can tell the person after the transaction
  // commits. A message sent for a change that then rolled back is worse than a
  // late one.
  (strike as StrikeRow & { standingChange?: StandingChange | null }).standingChange = change;

  return strike;
}

/**
 * Accrues for a cancellation, if the timing warrants one.
 *
 * Returns `null` where no rule covers the band — seven or more days out — which
 * the caller should treat as a normal outcome rather than an error.
 */
async function accrueForCancellation(
  tx: PrismaTx,
  { userId, by, daysBefore, bookingId, at = new Date() }: CancellationStrikeInput
): Promise<StrikeRow | null> {
  const { rules } = await resolveRules(at, tx);
  const rule = triggerForCancellation(rules, by, daysBefore);
  if (!rule) return null;

  return accrue(tx, {
    userId,
    rule,
    bookingId,
    reason: `${by === 'ARTIST' ? 'Artist' : 'Client'} cancelled ${daysBefore} day(s) before the event`,
  });
}

/** Accrues for a dispute ruled against someone. */
async function accrueForDispute(
  tx: PrismaTx,
  { userId, falseNoShowClaim, bookingId, at = new Date() }: DisputeStrikeInput
): Promise<StrikeRow | null> {
  const { rules } = await resolveRules(at, tx);
  const rule = triggerForDispute(rules, falseNoShowClaim);
  if (!rule) return null;

  return accrue(tx, {
    userId,
    rule,
    bookingId,
    reason: falseNoShowClaim
      ? 'Dispute ruled against them on a no-show claim contradicted by a check-in record'
      : 'Dispute ruled against them',
  });
}

/**
 * Publishes a new rule set.
 *
 * Append-only: the previous set is never edited, so a strike issued last month
 * can still be explained by the rules that were in force when it was issued.
 */
async function setStrikeRules({
  rules,
  actorUserId,
  effectiveFrom = new Date(),
}: {
  rules: StrikeRuleInput[];
  actorUserId: string;
  effectiveFrom?: Date;
}): Promise<{ versionId: string; rules: StrikeRuleRow[] }> {
  validateRules(rules);

  const versionId = `sr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  return prisma.$transaction(async (tx: PrismaTx) => {
    await tx.strikeRule.createMany({
      data: rules.map((r) => ({
        versionId,
        trigger: r.trigger,
        weight: r.weight,
        minDaysBefore: r.minDaysBefore ?? null,
        maxDaysBefore: r.maxDaysBefore ?? null,
        effectiveFrom,
        setByUserId: actorUserId,
      })),
    });

    await recordAudit(tx, {
      actorUserId,
      action: 'STRIKE_RULES_UPDATED',
      entityType: 'StrikeRule',
      entityId: versionId,
      after: { versionId, effectiveFrom, rules } as unknown as import('@prisma/client').Prisma.InputJsonValue,
    });

    const created = await tx.strikeRule.findMany({
      where: { versionId },
      orderBy: { trigger: 'asc' },
    });

    return { versionId, rules: created };
  });
}

/**
 * Every trigger the schema defines. A published set must price all of them.
 */
const ALL_TRIGGERS: StrikeTrigger[] = [
  'ARTIST_CANCEL_3_6_DAYS',
  'ARTIST_CANCEL_1_2_DAYS',
  'ARTIST_CANCEL_DAY_OF',
  'CLIENT_CANCEL_1_2_DAYS',
  'CLIENT_CANCEL_DAY_OF',
  'DISPUTE_RULED_AGAINST',
  'DISPUTE_FALSE_NO_SHOW_CLAIM',
];

/**
 * Rejects a set that cannot be applied.
 *
 * A PARTIAL SET IS REFUSED, naming what is missing. Publishing one would
 * silently stop accrual for every trigger left out — an admin editing the
 * artist bands and submitting only those would switch off client misconduct
 * entirely, and nothing would say so. That is the same failure as an empty
 * table, arriving through an edit instead of an omission.
 *
 * Found by test interference: one case published an artist-only set and two
 * later cases stopped recording client strikes, which is exactly how it would
 * present in production — not as an error, but as a record that quietly
 * under-reports.
 *
 * The set is therefore submitted whole, the way #8's tier set is.
 */
function validateRules(rules: StrikeRuleInput[]): void {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new AppError(400, 'Provide at least one strike rule.');
  }

  const seen = new Set<string>();

  for (const rule of rules) {
    if (!rule.trigger) throw new AppError(400, 'Every strike rule must name a trigger.');

    if (seen.has(rule.trigger)) {
      throw new AppError(400, `${rule.trigger} appears twice. Each trigger may have one weight.`);
    }
    seen.add(rule.trigger);

    if (!Number.isInteger(rule.weight) || rule.weight < 1) {
      throw new AppError(
        400,
        `${rule.trigger}: weight must be a whole number of at least 1, received ${rule.weight}.`
      );
    }

    const timed = rule.minDaysBefore !== null && rule.minDaysBefore !== undefined;
    if (timed) {
      if (!Number.isInteger(rule.minDaysBefore) || (rule.minDaysBefore as number) < 0) {
        throw new AppError(400, `${rule.trigger}: minDaysBefore must be zero or more.`);
      }
      if (
        rule.maxDaysBefore !== null &&
        rule.maxDaysBefore !== undefined &&
        (rule.maxDaysBefore as number) < (rule.minDaysBefore as number)
      ) {
        throw new AppError(
          400,
          `${rule.trigger}: maxDaysBefore (${rule.maxDaysBefore}) is before minDaysBefore (${rule.minDaysBefore}).`
        );
      }
    }
  }

  const missing = ALL_TRIGGERS.filter((t) => !seen.has(t));
  if (missing.length > 0) {
    throw new AppError(
      400,
      `A strike rule set must price every trigger. Missing: ${missing.join(', ')}. ` +
        'Submitting a partial set would silently stop accrual for the rest.'
    );
  }
}

/**
 * A user's strikes, newest first — docs/06 §4.
 *
 * Every one is appealable, so the whole record is returned rather than a count:
 * a total tells an admin what happened to an account, and only the individual
 * reasons tell them whether it should have.
 */
async function strikesFor(userId: string): Promise<StrikeHistory> {
  const strikes = await prisma.strike.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { booking: { select: { id: true, eventDate: true, state: true } } },
  });

  const active = strikes.filter((s: StrikeRow) => s.active);

  return {
    userId,
    total: strikes.length,
    activeCount: active.length,
    // Weight, not count, is what #34's ladders read. Three late cancellations
    // and one attempted fraud are not the same account.
    activeWeight: active.reduce((sum: number, s: StrikeRow) => sum + s.weight, 0),
    strikes,
  };
}

module.exports = {
  resolveRules,
  triggerForCancellation,
  consequenceOfArtistCancellation,
  triggerForDispute,
  accrue,
  accrueForCancellation,
  accrueForDispute,
  setStrikeRules,
  validateRules,
  strikesFor,
  DEFAULT_RULES,
  ALL_TRIGGERS,
  ARTIST_CANCELLATION_TRIGGERS,
  CLIENT_CANCELLATION_TRIGGERS,
};
