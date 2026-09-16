/**
 * Admin and super-admin endpoints — docs/02-API-CONTRACT.md §9.
 *
 * Permission is enforced HERE, at the route, server-side. Hiding a field in the
 * UI is a courtesy to the honest user, not a permission check (docs/07 §2).
 */

const express = require('express');

const { AppError } = require('../lib/errors.ts');
const { requireAuth, requireRole } = require('../middleware/auth.ts');
const {
  setCommissionRate,
  resolveCommissionRate,
  listCommissionRates,
} = require('../services/commissionService.ts');
const {
  setCancellationTiers,
  resolveTierSet,
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
} = require('../services/escrowService.ts');

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
      const [current, history] = await Promise.all([resolveTierSet(), listTierVersions()]);
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

module.exports = { router };
