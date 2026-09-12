/**
 * Identity verification — docs/02-API-CONTRACT.md §6, issue #10.
 *
 * Verification runs at ONBOARDING, not at checkout. The ₦50 the provider
 * charges is once per person for life, not per transaction, so it belongs to
 * the account and must never touch per-booking economics.
 *
 * Both sides verify, not just artists. Money flows out to the client on refunds
 * as well as to the artist on payouts, so an unverified client is a refund with
 * no confirmed recipient — and the client side is where the fraud concentrates:
 * a serial false-no-show claimant is only deterrable if the account is tied to
 * an identity that cannot be recreated after suspension.
 */

const prisma = require('../lib/prisma');
const { AppError } = require('../lib/errors');
const escrowpay = require('../lib/escrowpay');

/** ₦50, once per successful check. Returning users are free. */
const VERIFICATION_COST_KOBO = 5000;
const COST_CATEGORY = 'IDENTITY_VERIFICATION';

const METHODS = Object.freeze(['NIN', 'BVN']);

/**
 * Verifies a user's identity, or returns the cached result.
 *
 * @returns {{status, method, verifiedAt, partyId, cached: boolean}}
 */
async function verifyUser({ userId, method, identifier }) {
  const normalisedMethod = String(method || '').toUpperCase();
  if (!METHODS.includes(normalisedMethod)) {
    throw new AppError(400, 'Choose either NIN or BVN.');
  }
  if (typeof identifier !== 'string' || identifier.trim().length < 3) {
    throw new AppError(400, 'Enter your NIN or BVN.');
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  // A returning user is never re-charged or re-checked. The provider enforces
  // this too — a repeat onboarding returns 409 — but checking here means no
  // provider call is made at all, which is what #10 requires.
  if (user.verificationStatus === 'VERIFIED') {
    return {
      status: 'VERIFIED',
      method: user.verificationMethod,
      verifiedAt: user.verifiedAt,
      partyId: user.escrowPartyId,
      cached: true,
    };
  }

  if (user.verificationStatus === 'REJECTED') {
    // A genuine mismatch is not retryable by resubmitting the same details.
    throw new AppError(
      403,
      'We could not verify that identity. Contact support if you believe this is wrong.'
    );
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      verificationStatus: 'PENDING',
      verificationAttempts: { increment: 1 },
      lastVerificationAttemptAt: new Date(),
    },
  });

  let result;
  try {
    result = await escrowpay.onboardParty({
      type: normalisedMethod.toLowerCase(),
      identifier: identifier.trim(),
      email: user.email,
      reference: `verify_${userId}`,
    });
  } catch (err) {
    return handleProviderFailure({ user, method: normalisedMethod, err });
  }

  return recordSuccess({
    user,
    method: normalisedMethod,
    partyId: result.party.id,
    identityId: result.identity?.id ?? null,
    chargeable: true,
  });
}

/**
 * Distinguishes the three ways a provider call can fail. Collapsing them would
 * lock a legitimate user out over a network blip.
 */
async function handleProviderFailure({ user, method, err }) {
  const code = err.providerCode;

  // ALREADY VERIFIED ELSEWHERE — not a failure.
  //
  // Identities are unique per environment, so a repeat onboarding returns 409.
  // Discovered while building #17. Treating it as an error would lock out
  // exactly the returning users the caching is meant to serve.
  if (code === 'identity_already_exists') {
    return recordSuccess({
      user,
      method,
      partyId: null,
      identityId: null,
      chargeable: false,
      note: 'identity_already_exists',
    });
  }

  // A GENUINE REJECTION — the details did not match.
  if (code === 'identity_verification_failed') {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        verificationStatus: 'REJECTED',
        verificationFailureReason: err.providerMessage ?? 'verification_failed',
      },
    });
    throw new AppError(
      403,
      'We could not verify that identity. Check the number and try again, or contact support.'
    );
  }

  // A REQUEST WE GOT WRONG — a 4xx that is not one of the cases above, such as
  // a malformed email. Retrying unchanged fails identically forever, so telling
  // the user to "try again in a few minutes" would be actively misleading.
  //
  // The user returns to UNVERIFIED rather than RETRYABLE_FAILURE: nothing is
  // broken, the submitted details simply need correcting.
  if (err.providerStatus && err.providerStatus >= 400 && err.providerStatus < 500) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        verificationStatus: 'UNVERIFIED',
        verificationFailureReason: err.providerCode ?? 'provider_rejected_request',
      },
    });
    throw new AppError(
      400,
      'We could not start verification with those details. Check your email address and identity number, then try again.'
    );
  }

  // ANYTHING ELSE — a timeout, a 5xx, an unreachable provider. Retryable.
  //
  // #10's fourth criterion: a provider timeout must leave the user able to try
  // again, not marked as having failed verification.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      verificationStatus: 'RETRYABLE_FAILURE',
      verificationFailureReason: err.providerCode ?? err.providerMessage ?? 'provider_unreachable',
    },
  });
  throw new AppError(
    503,
    'We could not reach our verification partner. Please try again in a few minutes.'
  );
}

/**
 * Persists a successful verification and records the platform cost.
 *
 * The RESULT is stored, never the identifier. Retaining a NIN or BVN is NDPR
 * exposure with no operational benefit — and the provider masks it on their
 * side too, so neither party holds it.
 */
async function recordSuccess({ user, method, partyId, identityId, chargeable, note }) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        verificationStatus: 'VERIFIED',
        verificationMethod: method,
        verifiedAt: new Date(),
        verificationReference: identityId,
        verificationFailureReason: note ?? null,
        ...(partyId ? { escrowPartyId: partyId } : {}),
      },
    });

    // Only a NEW successful check is billable; the provider does not charge for
    // a returning user. `reference` is unique, so a retry cannot double-charge.
    if (chargeable && identityId) {
      await tx.platformCost.create({
        data: {
          category: COST_CATEGORY,
          amountKobo: VERIFICATION_COST_KOBO,
          userId: user.id,
          reference: identityId,
          description: `Identity verification (${method})`,
        },
      });
    }

    return {
      status: updated.verificationStatus,
      method: updated.verificationMethod,
      verifiedAt: updated.verifiedAt,
      partyId: updated.escrowPartyId,
      cached: false,
    };
  });
}

/** Current status, for the portal and for `GET /me`. */
async function getStatus(userId) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      verificationStatus: true,
      verificationMethod: true,
      verifiedAt: true,
      verificationAttempts: true,
      lastVerificationAttemptAt: true,
      escrowPartyId: true,
    },
  });

  return {
    status: user.verificationStatus,
    method: user.verificationMethod,
    verifiedAt: user.verifiedAt,
    attempts: user.verificationAttempts,
    lastAttemptAt: user.lastVerificationAttemptAt,
    // Whether another attempt is worth offering. REJECTED is terminal without
    // support intervention; a provider failure is not.
    retryable: ['UNVERIFIED', 'RETRYABLE_FAILURE', 'PENDING'].includes(user.verificationStatus),
    partyId: user.escrowPartyId,
  };
}

module.exports = {
  verifyUser,
  getStatus,
  VERIFICATION_COST_KOBO,
  COST_CATEGORY,
  METHODS,
};
