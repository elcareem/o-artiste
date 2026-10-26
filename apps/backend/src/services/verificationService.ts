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

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const escrowpay = require('../lib/escrowpay.ts');
const { recordAudit } = require('../lib/audit.ts');

/** ₦50, once per successful check. Returning users are free. */
const VERIFICATION_COST_KOBO = 5000;
const COST_CATEGORY = 'IDENTITY_VERIFICATION';

const METHODS = Object.freeze(['NIN', 'BVN']);

/**
 * Verifies a user's identity, or returns the cached result.
 *
 * @returns {{status, method, verifiedAt, partyId, cached: boolean}}
 */
/** Correctable mismatches before an account needs support. */
const MAX_MISMATCHES = 3;

/** The youngest a person can be to book or be booked: a contract needs an adult. */
const MIN_AGE_YEARS = 18;

/**
 * A real calendar date, `YYYY-MM-DD`, for an adult.
 *
 * Checked here as well as by the provider so an impossible date — 2026-02-30,
 * a birthday next year — is refused before it costs a provider call, and before
 * it uses up one of the person's limited mismatch tries.
 */
function validateDateOfBirth(raw: unknown, now: Date = new Date()): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new AppError(400, 'Enter your date of birth, as it appears on your NIN or BVN record.');

  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC rolls 30 February over into March; a real date survives the round trip.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new AppError(400, 'That date of birth is not a real date.');
  }

  const adultFrom = new Date(Date.UTC(y + MIN_AGE_YEARS, m - 1, d));
  if (adultFrom.getTime() > now.getTime()) {
    throw new AppError(400, `You need to be ${MIN_AGE_YEARS} or older to use o-artiste.`);
  }
  if (y < 1900) throw new AppError(400, 'Check the year of your date of birth.');

  return text;
}

async function verifyUser({
  userId,
  method,
  identifier,
  consent,
  dateOfBirth,
  context = {},
}: {
  userId: string;
  method: string;
  identifier: string;
  /**
   * The person's explicit agreement to their NIN or BVN being checked with our
   * payment partner. MUST be the boolean `true` — not "yes", not 1, not absent.
   *
   * Before #41 nothing asked, and the provider's `consent` field defaults to
   * `true`, so every check claimed consent on the user's behalf. A national
   * identity number is personal data under the NDPR, and consent to processing
   * it has to be given, not assumed.
   */
  consent?: unknown;
  /**
   * `YYYY-MM-DD`. Required by the provider since October 2026 and checked
   * against the NIN/BVN record. Sent, NEVER STORED — the same rule as the
   * number itself: it is personal data we need for one call and no longer.
   */
  dateOfBirth?: unknown;
  /** Where the request came from, kept with the consent record. */
  context?: { actorIp?: string | null; actorUserAgent?: string | null };
}) {
  const normalisedMethod = String(method || '').toUpperCase();
  if (!METHODS.includes(normalisedMethod)) {
    throw new AppError(400, 'Choose either NIN or BVN.');
  }
  if (typeof identifier !== 'string' || identifier.trim().length < 3) {
    throw new AppError(400, 'Enter your NIN or BVN.');
  }
  // Checked before anything else touches the identifier — including the cached
  // path, because submitting an identifier for checking is itself the thing
  // consent is being asked for.
  const dob = validateDateOfBirth(dateOfBirth);

  if (consent !== true) {
    throw new AppError(
      400,
      `Confirm that you agree to your ${normalisedMethod} being checked with our payment partner. ` +
        'We use it only to confirm who you are, and we do not keep the number.'
    );
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

  // THE CONSENT RECORD, written before the identifier leaves this system and
  // not best-effort: if we cannot record that consent was given, the check does
  // not happen. The number itself is NOT recorded — only that it was consented
  // to, which method, when and from where.
  const consentRecord = await recordAudit(prisma, {
    actorUserId: userId,
    actorIp: context.actorIp ?? null,
    actorUserAgent: context.actorUserAgent ?? null,
    action: 'IDENTITY_CHECK_CONSENTED',
    entityType: 'User',
    entityId: userId,
    after: { method: normalisedMethod, consent: true },
  });

  let result;
  try {
    result = await escrowpay.onboardParty({
      type: normalisedMethod.toLowerCase(),
      identifier: identifier.trim(),
      email: user.email,
      reference: `verify_${userId}`,
      // Sent explicitly rather than left to the provider's default of `true`,
      // with a reference to our own record of it.
      consent: true,
      consentReference: consentRecord.id,
      dateOfBirth: dob,
    });
  } catch (err) {
    return handleProviderFailure({ user, method: normalisedMethod, err: err as AppErrorLike });
  }

  return recordSuccess({
    user,
    method: normalisedMethod as import('@prisma/client').VerificationMethod,
    partyId: result.party.id,
    identityId: result.identity?.id ?? null,
    chargeable: true,
  });
}

/**
 * Distinguishes the three ways a provider call can fail. Collapsing them would
 * lock a legitimate user out over a network blip.
 */
async function handleProviderFailure({
  user,
  method,
  err,
}: {
  user: UserRow;
  method: string;
  err: AppErrorLike;
}): Promise<any> {
  const code = err.providerCode;

  // ALREADY VERIFIED ELSEWHERE — not a failure.
  //
  // Identities are unique per environment, so a repeat onboarding returns 409.
  // Discovered while building #17. Treating it as an error would lock out
  // exactly the returning users the caching is meant to serve.
  if (code === 'identity_already_exists') {
    return recordSuccess({
      user,
      method: method as import('@prisma/client').VerificationMethod,
      partyId: null,
      identityId: null,
      chargeable: false,
      note: 'identity_already_exists',
    });
  }

  // THE DETAILS DID NOT MATCH THE RECORD.
  //
  // This used to be a permanent rejection on the first failure. That stopped
  // being defensible when the provider began checking the DATE OF BIRTH
  // (October 2026): one mistyped birthday would have locked a person out for
  // good. A mismatch now gets a correction — but only MAX_MISMATCHES of them in
  // total, because otherwise this endpoint is a way for someone holding a
  // stolen NIN to guess the date of birth behind it, one request at a time.
  if (code === 'identity_verification_failed') {
    const mismatches = (user.verificationMismatches ?? 0) + 1;
    const exhausted = mismatches >= MAX_MISMATCHES;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        verificationStatus: exhausted ? 'REJECTED' : 'UNVERIFIED',
        verificationMismatches: mismatches,
        verificationFailureReason: err.providerMessage ?? 'verification_failed',
      },
    });

    if (exhausted) {
      throw new AppError(
        403,
        'Those details still do not match the record, so we cannot try again automatically. Contact support and we will look into it with you.'
      );
    }

    const left = MAX_MISMATCHES - mismatches;
    throw new AppError(
      422,
      `Those details do not match the record for that ${method}. Check your date of birth and the number, then try again — ` +
        `${left} ${left === 1 ? 'try' : 'tries'} left.`
    );
  }

  // Held for a person to look at, on the provider's side. Not retryable — a
  // resubmission would only start another review — and not a mismatch either.
  if (code === 'identity_requires_review') {
    await prisma.user.update({
      where: { id: user.id },
      data: { verificationStatus: 'REJECTED', verificationFailureReason: 'identity_requires_review' },
    });
    throw new AppError(
      403,
      'Your details need a manual check before we can verify you. Contact support and we will look into it with you.'
    );
  }

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
async function recordSuccess({
  user,
  method,
  partyId,
  identityId,
  chargeable,
  note,
}: {
  user: UserRow;
  method: import('@prisma/client').VerificationMethod;
  partyId: string | null;
  identityId?: string | null;
  chargeable?: boolean;
  note?: string | null;
}) {
  return prisma.$transaction(async (tx: PrismaTx) => {
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
async function getStatus(userId: string) {
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
  validateDateOfBirth,
  MAX_MISMATCHES,
  getStatus,
  VERIFICATION_COST_KOBO,
  COST_CATEGORY,
  METHODS,
};
