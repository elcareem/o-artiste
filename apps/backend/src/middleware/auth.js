/**
 * Authentication and role enforcement — docs/07 §2.
 *
 * Permission checks live HERE, at the route, server-side. Hiding a field or a
 * screen in the UI is a courtesy to the honest user, not a permission check.
 * #36 asserts the point directly: a request submitted straight to the API is
 * rejected even when the UI prevented it.
 */

const { verifyToken } = require('../lib/auth');
const { AppError } = require('../lib/errors');
const prisma = require('../lib/prisma');
const { recordAuditSafe, actorContext } = require('../lib/audit');

/**
 * Requires a valid session. Attaches `req.user` — the live database row, not
 * the token payload.
 *
 * The token says what the role WAS when it was issued. A user suspended or
 * demoted five minutes ago still holds a perfectly valid token, and trusting
 * its claims would let them keep acting on a standing they no longer have.
 * Tokens last days; account standing changes in seconds.
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw new AppError(401, 'You need to be logged in to do that.');
    }

    const payload = verifyToken(token);

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      throw new AppError(401, 'Your session is invalid or has expired. Please log in again.');
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Requires one of the given roles. Use after requireAuth.
 *
 *   router.put('/admin/config/commission', requireAuth, requireRole('SUPER_ADMIN'), handler)
 *
 * Roles are matched exactly, with no implicit hierarchy. SUPER_ADMIN is not
 * "ADMIN plus more" in code: if an endpoint should accept both, it says so.
 * Implicit rank is how a permission ends up somewhere nobody intended.
 */
function requireRole(...roles) {
  return function roleGuard(req, res, next) {
    if (!req.user) {
      return next(new AppError(401, 'You need to be logged in to do that.'));
    }
    if (!roles.includes(req.user.role)) {
      // An authenticated user reaching for an endpoint above their level. More
      // significant than the anonymous case, because this one has an account
      // we can name.
      recordAuditSafe({
        ...actorContext(req),
        actorUserId: req.user.id,
        action: 'ROLE_DENIED',
        entityType: 'Endpoint',
        entityId: `${req.method} ${req.originalUrl}`,
        reason: 'Role is not permitted for this endpoint.',
        after: { held: req.user.role, required: roles },
      });
      return next(new AppError(403, 'You do not have permission to do that.'));
    }
    next();
  };
}

/**
 * Requires a verified identity. Written here in #10's spirit but enforced from
 * #15 onward, where the endpoints it guards exist.
 */
function requireVerified(req, res, next) {
  if (!req.user) {
    return next(new AppError(401, 'You need to be logged in to do that.'));
  }
  if (req.user.verificationStatus !== 'VERIFIED') {
    // Actionable, not merely a refusal — the user is told what to do next.
    return next(new AppError(403, 'Verify your identity before continuing.'));
  }
  next();
}

module.exports = { requireAuth, requireRole, requireVerified };
