/**
 * Registration, login, session — docs/02-API-CONTRACT.md §3.
 */

const express = require('express');

const prisma = require('../lib/prisma');
const { AppError } = require('../lib/errors');
const {
  hashPassword,
  verifyPassword,
  signToken,
  SELF_REGISTERABLE_ROLES,
} = require('../lib/auth');
const { requireAuth } = require('../middleware/auth');
const { recordAuditSafe, actorContext } = require('../lib/audit');

const router = express.Router();

const MIN_PASSWORD_LENGTH = 10;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * POST /auth/register
 *
 * `role` accepts ONLY CLIENT or ARTIST. There is no public route to ADMIN or
 * SUPER_ADMIN, and an attempt to claim one is rejected with 403 rather than
 * quietly downgraded — a silent downgrade hides an attempt worth seeing.
 */
router.post('/auth/register', async (req, res, next) => {
  try {
    const { email, phone, password, role, displayName, stageName } = req.body ?? {};

    if (!email || !EMAIL_PATTERN.test(String(email))) {
      throw new AppError(400, 'Enter a valid email address.');
    }
    if (!phone || !E164_PATTERN.test(String(phone))) {
      throw new AppError(400, 'Enter your phone number in international format, e.g. +2348012345678.');
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new AppError(400, `Your password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (!SELF_REGISTERABLE_ROLES.includes(role)) {
      // Nobody types SUPER_ADMIN into a signup form. Our own client only ever
      // sends CLIENT or ARTIST, so a request carrying anything else was
      // hand-crafted — that is reconnaissance, and it is worth a record.
      // Refusing outright rather than silently creating a CLIENT is what makes
      // the attempt visible at all.
      recordAuditSafe({
        ...actorContext(req),
        action: 'REGISTRATION_ROLE_REJECTED',
        entityType: 'Registration',
        entityId: String(email ?? 'unknown').trim().toLowerCase(),
        reason: 'Attempted to self-assign a role that is not publicly registerable.',
        after: { attemptedRole: role ?? null },
      });
      throw new AppError(403, 'You can register as a client or an artist.');
    }

    const normalisedEmail = String(email).trim().toLowerCase();

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: normalisedEmail }, { phone: String(phone) }] },
      select: { id: true },
    });
    if (existing) {
      // Deliberately does not say which of the two matched. Telling an
      // anonymous caller "that email is registered" turns this endpoint into a
      // way to enumerate who has an account.
      throw new AppError(409, 'An account already exists with those details.');
    }

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: normalisedEmail,
          phone: String(phone),
          passwordHash: await hashPassword(password),
          role,
        },
      });

      // The profile row is created in the same transaction as the user. A user
      // without their profile is a half-registered account that every later
      // query has to defend against.
      if (role === 'CLIENT') {
        await tx.client.create({
          data: { userId: created.id, displayName: String(displayName || normalisedEmail.split('@')[0]) },
        });
      } else {
        await tx.artist.create({
          data: { userId: created.id, stageName: String(stageName || normalisedEmail.split('@')[0]) },
        });
      }

      return created;
    });

    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

/** POST /auth/login */
router.post('/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};

    if (!email || typeof password !== 'string') {
      throw new AppError(400, 'Enter your email and password.');
    }

    const user = await prisma.user.findUnique({
      where: { email: String(email).trim().toLowerCase() },
    });

    // One message and one status for both "no such user" and "wrong password".
    // Distinguishing them lets anyone test which addresses hold accounts.
    const ok = user && (await verifyPassword(password, user.passwordHash));
    if (!ok) {
      throw new AppError(401, 'Email or password is incorrect.');
    }

    if (user.accountStanding === 'SUSPENDED' || user.accountStanding === 'REMOVED') {
      throw new AppError(
        403,
        'Your account is suspended. Contact support if you think this is a mistake.'
      );
    }

    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

/** GET /me — profile and verification status. */
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const profile =
      req.user.role === 'ARTIST'
        ? await prisma.artist.findUnique({ where: { userId: req.user.id } })
        : req.user.role === 'CLIENT'
          ? await prisma.client.findUnique({ where: { userId: req.user.id } })
          : null;

    res.json({ user: publicUser(req.user), profile });
  } catch (err) {
    next(err);
  }
});

/**
 * The user shape safe to return over the wire.
 *
 * An explicit allowlist, not a delete-list. `passwordHash` must never leave the
 * process, and `verificationReference` is a provider identifier with no
 * business on a client. Allowlisting means a column added later is private by
 * default rather than exposed until someone notices.
 */
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    role: user.role,
    verificationStatus: user.verificationStatus,
    verificationMethod: user.verificationMethod,
    verifiedAt: user.verifiedAt,
    accountStanding: user.accountStanding,
    restrictedMinLeadDays: user.restrictedMinLeadDays,
    createdAt: user.createdAt,
  };
}

module.exports = { router, publicUser };
