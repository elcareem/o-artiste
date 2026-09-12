/**
 * Admin and super-admin endpoints — docs/02-API-CONTRACT.md §9.
 *
 * Permission is enforced HERE, at the route, server-side. Hiding a field in the
 * UI is a courtesy to the honest user, not a permission check (docs/07 §2).
 */

const express = require('express');

const { AppError } = require('../lib/errors');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  setCommissionRate,
  resolveCommissionRate,
  listCommissionRates,
} = require('../services/commissionService');

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
  async (req, res, next) => {
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
  async (req, res, next) => {
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

module.exports = { router };
