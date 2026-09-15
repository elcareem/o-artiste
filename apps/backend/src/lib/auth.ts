/**
 * Password hashing and session tokens — docs/02-API-CONTRACT.md §3.
 *
 * Passwords are hashed with bcrypt. Never stored in plaintext, never
 * recoverable — a password this system can read back is a password an attacker
 * can read back, and these accounts hold identity verification records and
 * payout history.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { AppError } = require('./errors.ts');

/**
 * Work factor. 12 is roughly 250ms on modern hardware — slow enough that
 * offline cracking is expensive, fast enough that login does not feel broken.
 * Raising it later is safe: bcrypt encodes the cost in the hash, so existing
 * hashes keep verifying against their original factor.
 */
const BCRYPT_ROUNDS = 12;

const DEFAULT_EXPIRY = '7d';

/** Roles a user may hold. Order carries no meaning; there is no implicit rank. */
const ROLES = Object.freeze(['CLIENT', 'ARTIST', 'ADMIN', 'SUPER_ADMIN']);

/**
 * The ONLY roles obtainable through public registration.
 *
 * An admin resolving a dispute affects one booking; a super-admin changing the
 * commission rate affects every booking created afterwards (docs/07 §1). Those
 * accounts are seeded or created manually — there is no public route to them,
 * and a request asking for one is rejected rather than silently downgraded,
 * because a silent downgrade hides an attempt worth seeing.
 */
const SELF_REGISTERABLE_ROLES: readonly UserRole[] = Object.freeze(['CLIENT', 'ARTIST'] as UserRole[]);

function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // Failing loudly at first use beats defaulting to something guessable.
    // A predictable signing key means anyone can mint a SUPER_ADMIN token.
    throw new Error('JWT_SECRET is not set. Refusing to sign or verify tokens.');
  }
  return secret;
}

/** Signs a session token. The payload carries only what middleware needs. */
function signToken(
  user: Pick<UserRow, 'id' | 'role'>,
  expiresIn: string = process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRY
): string {
  return jwt.sign({ sub: user.id, role: user.role }, jwtSecret(), {
    expiresIn,
  } as import('jsonwebtoken').SignOptions);
}

/**
 * Verifies a session token.
 *
 * Every failure — expired, malformed, wrong signature — surfaces as the same
 * 401 with the same message. Distinguishing them tells an attacker which part
 * of a forged token to fix next.
 */
function verifyToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, jwtSecret()) as TokenPayload;
  } catch {
    throw new AppError(401, 'Your session is invalid or has expired. Please log in again.');
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  ROLES,
  SELF_REGISTERABLE_ROLES,
  BCRYPT_ROUNDS,
};
