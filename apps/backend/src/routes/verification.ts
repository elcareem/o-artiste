/**
 * Identity verification endpoints — issue #10.
 *
 * Onboarding, not checkout. The cost is once per person for life and must never
 * appear in per-booking economics.
 */

const express = require('express');

const { requireAuth } = require('../middleware/auth.ts');
const { verifyUser, getStatus } = require('../services/verificationService.ts');

const router = express.Router();

/**
 * POST /me/verification
 *
 * Body: `{ method: "NIN" | "BVN", identifier: "…" }`
 *
 * The identifier is used for this call and never stored.
 */
router.post('/me/verification', requireAuth, async (req, res, next) => {
  try {
    const { method, identifier } = req.body ?? {};
    const result = await verifyUser({ userId: req.user.id, method, identifier });
    res.status(result.cached ? 200 : 201).json({ verification: result });
  } catch (err) {
    next(err);
  }
});

/** GET /me/verification — current status, and whether a retry is worth offering. */
router.get('/me/verification', requireAuth, async (req, res, next) => {
  try {
    res.json({ verification: await getStatus(req.user.id) });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
