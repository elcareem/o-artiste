/**
 * Admin and super-admin endpoints — docs/02-API-CONTRACT.md §9.
 *
 * Permission is enforced HERE, at the route, server-side. Hiding a field in the
 * UI is a courtesy to the honest user, not a permission check (docs/07 §2).
 */

const express = require('express');

const { AppError } = require('../lib/errors.ts');
const { requireAuth, requireRole } = require('../middleware/auth.ts');
const { recordAudit } = require('../lib/audit.ts');
const {
  setCommissionRate,
  resolveCommissionRate,
  listCommissionRates,
} = require('../services/commissionService.ts');
const {
  setCancellationTiers,
  tierSetOrNull,
  listTierVersions,
} = require('../services/cancellationTierService.ts');
const {
  resolveRules,
  setStrikeRules,
  strikesFor,
} = require('../services/strikeService.ts');
const {
  writeOffLiabilities,
  reclassifyAsArtistFault,
  resolveDispute,
  releaseBooking,
  refundBooking,
} = require('../services/escrowService.ts');
const bookingAdminService = require('../services/bookingAdminService.ts');
const payoutService = require('../services/payoutService.ts');
const disputeService = require('../services/disputeService.ts');
const enforcementService = require('../services/enforcementService.ts');
const reputationService = require('../services/reputationService.ts');
const prisma = require('../lib/prisma.ts');

const router = express.Router();

/**
 * GET /admin/config/commission
 *
 * Current rate plus the full history. Readable by ADMIN — seeing what the take
 * is does not carry the risk that changing it does.
 */
router.get(
  '/admin/config/commission',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Req, res: Res, next: Next) => {
    try {
      const [current, history] = await Promise.all([
        resolveCommissionRate(),
        listCommissionRates(),
      ]);
      res.json({ current, history });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /admin/config/commission
 *
 * SUPER_ADMIN only, and deliberately NOT ADMIN. An admin resolving a dispute
 * affects one booking; this affects every booking created afterwards
 * (docs/07 §1).
 *
 * Writes a new record — it never updates the existing one.
 */
router.put(
  '/admin/config/commission',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { rateBasisPoints, effectiveFrom, reason } = req.body ?? {};

      if (typeof reason !== 'string' || reason.trim().length === 0) {
        // A change to the platform's take without a recorded justification is
        // indefensible later, and "later" means a regulator or an artist asking
        // months afterwards.
        throw new AppError(400, 'Give a reason for this change.');
      }

      const created = await setCommissionRate({
        rateBasisPoints,
        effectiveFrom,
        actorUserId: req.user.id,
        reason: reason.trim(),
      });

      res.status(201).json({ current: created });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin/config/cancellation-tiers
 *
 * The set currently in force, plus every prior version. Prior sets remain
 * queryable forever — a booking cancelled today may have been created under a
 * table that has since been replaced, and reconstructing that is the whole
 * reason versions are kept.
 */
router.get(
  '/admin/config/cancellation-tiers',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Req, res: Res, next: Next) => {
    try {
      const [current, history] = await Promise.all([tierSetOrNull(), listTierVersions()]);
      // `null` on a system where none has ever been published — the screen that
      // publishes the first one cannot be the screen that fails without one.
      res.json({ current, history });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /admin/config/cancellation-tiers
 *
 * SUPER_ADMIN only. Saves a validated set as a new version; prior versions are
 * never touched.
 *
 * Rows are replaced wholesale rather than patched individually, because the
 * band structure itself changes — adding a 14-day tier or splitting the day-of
 * band is a business decision, not a deploy.
 */
router.put(
  '/admin/config/cancellation-tiers',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { tiers, effectiveFrom, reason } = req.body ?? {};

      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new AppError(400, 'Give a reason for this change.');
      }

      const saved = await setCancellationTiers({
        tiers,
        effectiveFrom,
        actorUserId: req.user.id,
        reason: reason.trim(),
      });

      res.status(201).json({ current: saved });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin/config/strikes
 *
 * The rule set in force, and whether it is a published one — issue #33.
 *
 * `isDefault` matters: an empty table falls back to the shipped defaults so a
 * fresh deployment accrues correctly rather than silently accruing nothing, and
 * an admin should be able to tell "nobody has decided yet" from "somebody
 * decided this".
 *
 * Readable by ADMIN. Seeing how conduct is priced does not carry the risk that
 * changing it does.
 */
router.get(
  '/admin/config/strikes',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Req, res: Res, next: Next) => {
    try {
      const { rules, versionId, isDefault } = await resolveRules();
      res.json({ current: { versionId, isDefault, rules } });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /admin/config/strikes
 *
 * SUPER_ADMIN only, and deliberately not ADMIN — the same line drawn for the
 * commission rate (docs/07 §1). An admin reviewing one strike affects one
 * person; this changes how every future one is priced.
 *
 * Append-only. The previous set is never edited, so a strike issued last month
 * can still be explained by the rules in force when it was issued.
 */
router.put(
  '/admin/config/strikes',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { rules, effectiveFrom } = req.body ?? {};

      const published = await setStrikeRules({
        rules,
        actorUserId: req.user.id,
        ...(effectiveFrom ? { effectiveFrom: new Date(effectiveFrom) } : {}),
      });

      res.status(201).json({ published });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin/users/:id/strikes
 *
 * One user's conduct record — docs/06 §4.
 *
 * The whole record, not a count. Every strike is appealable, and a total tells
 * an admin what happened to an account while only the individual reasons tell
 * them whether it should have.
 */
router.get(
  '/admin/users/:id/strikes',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Req, res: Res, next: Next) => {
    try {
      res.json({ history: await strikesFor(req.params.id) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /admin/users/:id/fee-liabilities/write-off
 *
 * Writes off an artist's outstanding fee liabilities — issue #28.
 *
 * Pursuing a ₦2,000 debt through collections costs more than the debt, so a
 * liability against an account that will never transact again is written off
 * rather than carried indefinitely.
 *
 * WRITTEN OFF, NOT DELETED. The platform bore that cost and the ledger has to
 * keep saying so; the row changes status and gains a reason, and the action is
 * attributed in `AuditLog`.
 *
 * A written reason is mandatory, for the same rule that governs every other
 * manual money decision (docs/07 §1): a movement without a recorded
 * justification is indefensible later.
 */
router.post(
  '/admin/users/:id/fee-liabilities/write-off',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { reason } = req.body ?? {};
      if (!reason) throw new AppError(400, 'Record why these liabilities are being written off.');

      const result = await writeOffLiabilities({
        artistUserId: req.params.id,
        reason: String(reason).slice(0, 2000),
        actorUserId: req.user.id,
      });

      res.json({ writeOff: result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /admin/cancellations/:id/reclassify
 *
 * Reclassifies a client cancellation as artist-fault — issue #29.
 *
 * Not every client cancellation is the client's fault. Where the artist changed
 * terms after booking or disclosed costs late, charging the client a
 * cancellation fee is the situation the FCCPA addresses.
 *
 * A WRITTEN REASON IS MANDATORY. This moves money on a settled booking and
 * accrues a strike against a named artist; a decision like that without a
 * recorded justification is indefensible when it is questioned, and it will be.
 * The deciding admin is named in `AuditLog`.
 */
router.post(
  '/admin/cancellations/:id/reclassify',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { reason } = req.body ?? {};

      const reclassification = await reclassifyAsArtistFault({
        cancellationId: req.params.id,
        actorUserId: req.user.id,
        reason,
      });

      res.json({ reclassification });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin/payouts/awaiting
 *
 * Bookings released but not paid out — money in our wallet that belongs to
 * someone else.
 *
 * EscrowPay rejects automatic payout on this business, so a release lands in
 * our wallet and the transfer to the artist is a second call that can fail.
 * When it does, the release is still correct and the artist is still owed;
 * `docs/00` §3 says the platform never holds client money, and this is the query
 * that says whether it currently is.
 */
router.get(
  '/admin/payouts/awaiting',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Req, res: Res, next: Next) => {
    try {
      const bookings = await payoutService.awaitingPayout();

      res.json({
        awaiting: bookings.map((b: any) => ({
          bookingId: b.id,
          releasedAt: b.releasedAt,
          artist: b.artist?.stageName ?? null,
          hasPayoutAccount: Boolean(b.artist?.payoutAccountId),
          failureReason: b.payoutFailureReason,
        })),
        total: bookings.length,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin/disputes
 *
 * The queue — issue #32. Open and under-review disputes, oldest first.
 *
 * AGE AND VALUE ARE ON THE LIST. A dispute is money held from two people who
 * both believe it is theirs, and how long that has been true is the thing an
 * admin needs to triage on. `hasCheckIn` is there because a dispute with one
 * should be cheap to decide.
 */
router.get(
  '/admin/disputes',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Req, res: Res, next: Next) => {
    try {
      const includeResolved = req.query.resolved === 'true';

      const disputes = await prisma.dispute.findMany({
        where: includeResolved
          ? {}
          : { state: { in: ['OPEN', 'UNDER_REVIEW'] as DisputeState[] } },
        orderBy: { createdAt: 'asc' },
        include: {
          booking: { include: { client: true, artist: true } },
          checkIn: true,
          _count: { select: { evidence: true } },
        },
      });

      res.json({
        disputes: disputes.map((d: any) => ({
          id: d.id,
          bookingId: d.bookingId,
          state: d.state,
          openedAt: d.createdAt,
          ageDays: Math.floor((Date.now() - new Date(d.createdAt).getTime()) / 86400000),
          amountKobo: d.booking.amountKobo,
          eventDate: d.booking.eventDate,
          artist: d.booking.artist.stageName,
          client: d.booking.client.displayName,
          // The single fact that reduces the common case to a binary one.
          hasCheckIn: Boolean(d.checkInId),
          evidenceCount: d._count.evidence,
          openedReason: d.openedReason,
        })),
        total: disputes.length,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin/disputes/:id
 *
 * One dispute in full, for deciding it.
 *
 * THE CHECK-IN IS FIRST IN THE PAYLOAD, not buried among the attachments
 * (docs/04 §6). Most disputes should be cheap to resolve because that single
 * record reduces "did the event happen?" to a timestamped fact; burying it
 * makes every dispute expensive.
 */
router.get(
  '/admin/disputes/:id',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Req, res: Res, next: Next) => {
    try {
      const dispute = await prisma.dispute.findUnique({
        where: { id: req.params.id },
        include: {
          booking: { include: { client: true, artist: true } },
          checkIn: true,
          evidence: { orderBy: { createdAt: 'asc' } },
        },
      });

      if (!dispute) throw new AppError(404, 'Dispute not found.');

      res.json({
        dispute: {
          id: dispute.id,
          state: dispute.state,
          openedAt: dispute.createdAt,
          openedReason: dispute.openedReason,
          openedBy: disputeService.partyOf(dispute.booking, dispute.openedByUserId),

          // Above the fold, deliberately.
          checkIn: dispute.checkIn
            ? {
                redeemedAt: dispute.checkIn.redeemedAt,
                hasLocation: dispute.checkIn.latitude !== null,
                latitude: dispute.checkIn.latitude,
                longitude: dispute.checkIn.longitude,
                accuracyMeters: dispute.checkIn.accuracyMeters,
              }
            : null,

          booking: {
            id: dispute.booking.id,
            amountKobo: dispute.booking.amountKobo,
            commissionRateBpsSnapshot: dispute.booking.commissionRateBpsSnapshot,
            eventDate: dispute.booking.eventDate,
            eventEndAt: dispute.booking.eventEndAt,
            state: dispute.booking.state,
            artist: dispute.booking.artist.stageName,
            client: dispute.booking.client.displayName,
            clientConfirmedAt: dispute.booking.clientConfirmedAt,
            artistConfirmedAt: dispute.booking.artistConfirmedAt,
            clientNoShowClaimedAt: dispute.booking.clientNoShowClaimedAt,
            clientNoShowReason: dispute.booking.clientNoShowReason,
          },

          evidence: dispute.evidence.map((e: DisputeEvidenceRow) => ({
            id: e.id,
            party: disputeService.partyOf(dispute.booking, e.submittedByUserId),
            statement: e.statement,
            fileUrl: e.fileUrl,
            createdAt: e.createdAt,
          })),

          resolvedAt: dispute.resolvedAt,
          resolutionReason: dispute.resolutionReason,
          splitClientKobo: dispute.splitClientKobo,
          splitArtistKobo: dispute.splitArtistKobo,
          externalMediatorOpinion: dispute.externalMediatorOpinion,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /admin/disputes/:id/resolve
 *
 * Release, refund, or split — with a mandatory written reason.
 *
 * Dispute authority sits with us, not the provider: EscrowPay does not
 * arbitrate, and funds stay held until we instruct otherwise (docs/04 §6).
 *
 * `mediatorOpinion` is recorded and executes nothing. Where a dispute turns on
 * quality rather than attendance an outside view may be worth having, but the
 * verdict returns to us and we issue the instruction.
 */
router.post(
  '/admin/disputes/:id/resolve',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { outcome, reason, splitClientKobo, mediatorOpinion } = req.body ?? {};

      const resolution = await resolveDispute({
        disputeId: req.params.id,
        outcome,
        reason,
        actorUserId: req.user.id,
        splitClientKobo,
        mediatorOpinion,
      });

      res.json({ resolution });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /admin/strikes/:id/review
 *
 * Overrides a strike — issue #34, docs/06 §5.
 *
 * Every strike is appealable, so every override carries a written reason and
 * names the admin who made it.
 *
 * THE STRIKE IS DEACTIVATED, NEVER DELETED. It happened, and the record of it
 * happening and then being overturned is more useful than its absence —
 * particularly to the next person reviewing the same account.
 *
 * Standing is recomputed from what remains, and this is the one path that may
 * LOWER it: removing a strike that should not have been issued has to undo what
 * it caused.
 */
router.post(
  '/admin/strikes/:id/review',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { reason, expiresAt } = req.body ?? {};

      const result = await enforcementService.reviewStrike({
        strikeId: req.params.id,
        actorUserId: req.user.id,
        reason,
        expiresAt,
      });

      res.json({ review: result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin/config/enforcement
 *
 * The ladders in force, and whether they are published or the shipped default.
 */
router.get(
  '/admin/config/enforcement',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Req, res: Res, next: Next) => {
    try {
      const { rules, versionId, isDefault } = await enforcementService.resolveLadders();
      res.json({ current: { versionId, isDefault, rules } });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /admin/config/enforcement
 *
 * SUPER_ADMIN only — the same line drawn for the commission rate and the strike
 * weights. An admin reviewing one strike affects one person; this changes what
 * every future accumulation does to an account.
 */
router.put(
  '/admin/config/enforcement',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { rules, effectiveFrom } = req.body ?? {};

      const published = await enforcementService.setEnforcementLadders({
        rules,
        actorUserId: req.user.id,
        ...(effectiveFrom ? { effectiveFrom: new Date(effectiveFrom) } : {}),
      });

      res.status(201).json({ published });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin/config/reputation
 *
 * The cancellation-rate window and display threshold — issue #35.
 */
router.get(
  '/admin/config/reputation',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Req, res: Res, next: Next) => {
    try {
      res.json({ current: await reputationService.resolveConfig() });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /admin/config/reputation
 *
 * SUPER_ADMIN only. Changing the threshold changes who has a published
 * reputation at all, which is a decision about every artist at once.
 */
router.put(
  '/admin/config/reputation',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { windowMonths, minBookings, effectiveFrom } = req.body ?? {};

      const published = await reputationService.setReputationConfig({
        windowMonths,
        minBookings,
        actorUserId: req.user.id,
        ...(effectiveFrom ? { effectiveFrom: new Date(effectiveFrom) } : {}),
      });

      res.status(201).json({ published });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin/config/auto-release
 *
 * The grace period in force, plus its history — issue #36, docs/04 §4.
 *
 * `source` distinguishes a published row from the environment variable and from
 * the shipped default. An operator needs to know which of the three they are
 * looking at before changing it: editing the row does nothing while an
 * environment variable is set.
 */
router.get(
  '/admin/config/auto-release',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Req, res: Res, next: Next) => {
    try {
      const autoReleaseJob = require('../jobs/autoReleaseJob.ts');

      const [graceHours, history] = await Promise.all([
        autoReleaseJob.resolveGraceHours(),
        prisma.autoReleaseConfig.findMany({
          orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
          take: 20,
          include: { setBy: { select: { id: true, email: true, role: true } } },
        }),
      ]);

      res.json({
        current: {
          graceHours,
          source: process.env.AUTO_RELEASE_GRACE_HOURS
            ? 'environment'
            : history.length > 0
              ? 'published'
              : 'default',
        },
        history: history.map(historyEntry),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /admin/config/auto-release
 *
 * SUPER_ADMIN only. The grace period decides when money moves on silence, which
 * is a decision about every future booking.
 */
router.put(
  '/admin/config/auto-release',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { graceHours, effectiveFrom } = req.body ?? {};

      if (!Number.isInteger(graceHours) || graceHours < 1) {
        throw new AppError(400, 'The grace period must be a whole number of hours, at least 1.');
      }
      if (graceHours > 24 * 30) {
        // Not a hard limit of the system, a limit of what is defensible: an
        // artist waiting a month to be paid on a client's silence is the
        // failure auto-release exists to prevent.
        throw new AppError(400, 'A grace period longer than 30 days leaves artists unpaid on silence.');
      }

      const published = await prisma.$transaction(async (tx: PrismaTx) => {
        const created = await tx.autoReleaseConfig.create({
          data: {
            graceHours,
            effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
            setByUserId: req.user.id,
          },
        });

        await recordAudit(tx, {
          actorUserId: req.user.id,
          action: 'AUTO_RELEASE_CONFIG_UPDATED',
          entityType: 'AutoReleaseConfig',
          entityId: created.id,
          after: { graceHours },
        });

        return created;
      });

      res.status(201).json({
        published,
        // Said plainly rather than discovered: the row is saved and inert.
        ...(process.env.AUTO_RELEASE_GRACE_HOURS
          ? {
              warning:
                'AUTO_RELEASE_GRACE_HOURS is set on this service and takes precedence. Unset it for this change to take effect.',
            }
          : {}),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin/settings
 *
 * Every tunable decision in one response — issue #36, docs/07 §6.
 *
 * One request rather than six, because the settings screen shows them together
 * and six round trips is six chances to render a half-loaded page of numbers
 * that govern money.
 *
 * FIELDS THE CALLER MAY NOT CHANGE ARE MARKED, NOT OMITTED. An `ADMIN` sees
 * that a commission rate exists and that they cannot set it, which is more
 * useful than a screen that silently lacks a section — and the server refuses
 * the write regardless of what the screen offers.
 */
router.get(
  '/admin/settings',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const autoReleaseJob = require('../jobs/autoReleaseJob.ts');
      const isSuperAdmin = req.user.role === 'SUPER_ADMIN';

      const [commission, tiers, strikes, ladders, reputation, graceHours] = await Promise.all([
        resolveCommissionRate(),
        tierSetOrNull(),
        resolveRules(),
        enforcementService.resolveLadders(),
        reputationService.resolveConfig(),
        autoReleaseJob.resolveGraceHours(),
      ]);

      res.json({
        settings: {
          commission: { rateBasisPoints: commission.rateBasisPoints, editable: isSuperAdmin },
          cancellationTiers: {
            // Reported as absent rather than erroring: bookings are blocked
            // until a table exists, and this is the screen that creates one.
            configured: tiers !== null,
            versionId: tiers?.versionId ?? null,
            tiers: tiers?.tiers ?? [],
            editable: isSuperAdmin,
          },
          autoRelease: {
            graceHours,
            source: process.env.AUTO_RELEASE_GRACE_HOURS ? 'environment' : 'configuration',
            editable: isSuperAdmin,
          },
          strikes: { isDefault: strikes.isDefault, rules: strikes.rules, editable: isSuperAdmin },
          enforcement: { isDefault: ladders.isDefault, rules: ladders.rules, editable: isSuperAdmin },
          reputation: { ...reputation, editable: isSuperAdmin },
        },
        viewerRole: req.user.role,
      });
    } catch (err) {
      next(err);
    }
  }
);

/** One prior version, with the person who set it. */
function historyEntry(row: any) {
  return {
    id: row.id,
    graceHours: row.graceHours,
    effectiveFrom: row.effectiveFrom,
    createdAt: row.createdAt,
    // Named, because "who changed this and when" is the question a change
    // history exists to answer (docs/07 §5).
    setBy: row.setBy ? { email: row.setBy.email, role: row.setBy.role } : null,
  };
}


// ---------------------------------------------------------------------------
// Operational visibility — issue #37, docs/07 §7
// ---------------------------------------------------------------------------

/**
 * GET /admin/bookings
 *
 * Filterable by state, event date and value. An unrecognised filter value is a
 * 400 rather than a silently ignored parameter: a dropped filter returns a full
 * list that looks like a filtered one, and the reader cannot tell.
 */
router.get(
  '/admin/bookings',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Req, res: Res, next: Next) => {
    try {
      res.json(await bookingAdminService.listBookings(req.query as Record<string, unknown>));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /admin/bookings/:id
 *
 * State history, check-in record, terms acknowledgement and the reconciled
 * ledger — with the net position computed here rather than in the view, because
 * a screen that adds up money itself is a second implementation of the
 * arithmetic, and the one that disagrees with the ledger is the one people read.
 */
router.get(
  '/admin/bookings/:id',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Req, res: Res, next: Next) => {
    try {
      res.json(await bookingAdminService.bookingDetail(req.params.id));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * The written reason every manual money movement carries.
 *
 * Mandatory at the endpoint, not in the service: `releaseBooking` takes an
 * optional reason because the AUTOMATED paths legitimately have none — an
 * auto-release has a grace period, not a justification. A manual one has a
 * person behind it, and a money movement without a recorded justification is
 * indefensible later (docs/07 §5).
 */
function requireWrittenReason(body: any): string {
  const reason = body?.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new AppError(400, 'Record why you are moving this money. The reason is kept with the booking.');
  }
  if (reason.trim().length < 10) {
    // "ok" and "fixed" are not reasons. The bar is low deliberately — this is
    // about leaving something readable behind, not about paperwork.
    throw new AppError(400, 'Give a little more detail — this is the only explanation the record will have.');
  }
  return reason.trim().slice(0, 2000);
}

/**
 * POST /admin/bookings/:id/release
 *
 * The safety valve for cases the automated paths do not cover — a client who
 * will not confirm and will not dispute, a booking stuck by a bug we have since
 * fixed.
 *
 * Goes through `escrowService`, which stays the sole money-mover. This endpoint
 * adds exactly two things: the role check and the mandatory reason.
 */
router.post(
  '/admin/bookings/:id/release',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const reason = requireWrittenReason(req.body);

      const release = await releaseBooking({ bookingId: req.params.id, reason });

      await prisma.$transaction((tx: PrismaTx) =>
        recordAudit(tx, {
          actorUserId: req.user.id,
          action: 'BOOKING_MANUALLY_RELEASED',
          entityType: 'Booking',
          entityId: req.params.id,
          reason,
          after: { state: 'RELEASED' },
        })
      );

      res.json({ release });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /admin/bookings/:id/refund
 *
 * The same valve in the other direction.
 */
router.post(
  '/admin/bookings/:id/refund',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const reason = requireWrittenReason(req.body);

      const refund = await refundBooking({ bookingId: req.params.id, reason });

      await prisma.$transaction((tx: PrismaTx) =>
        recordAudit(tx, {
          actorUserId: req.user.id,
          action: 'BOOKING_MANUALLY_REFUNDED',
          entityType: 'Booking',
          entityId: req.params.id,
          reason,
          after: { state: 'REFUNDED' },
        })
      );

      res.json({ refund });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = { router };
