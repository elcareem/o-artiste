/**
 * Artist profile and rate card — issue #11.
 *
 * The rate bound is enforced HERE, at profile level, rather than at checkout.
 * It is not product policy: EscrowPay processes transactions between ₦20,000
 * and ₦3,000,000, and a booking outside that range simply cannot be funded.
 * Enforcing it when the rate is set means the artist finds out while editing
 * their own profile, not the client at the point of payment.
 */

const prisma = require('../lib/prisma');
const { AppError } = require('../lib/errors');
const { MIN_TRANSACTION_KOBO, MAX_TRANSACTION_KOBO } = require('../lib/escrowpay');
const { formatNairaForMessage } = require('../lib/money');

/** Fields a complete, listable profile must carry. */
const REQUIRED_FOR_COMPLETE = ['stageName', 'category', 'location', 'baseRateKobo'];

const EDITABLE = ['stageName', 'bio', 'category', 'location', 'baseRateKobo', 'media'];

/**
 * Validates a base rate against the provider's transaction range.
 *
 * The message NAMES the limit. "Invalid rate" leaves an artist guessing at a
 * bound they have no way to discover.
 */
function validateBaseRate(kobo) {
  if (kobo === null || kobo === undefined) return null;

  if (typeof kobo !== 'number' || !Number.isInteger(kobo)) {
    throw new AppError(400, 'Enter your rate as a whole number of kobo.');
  }

  if (kobo < MIN_TRANSACTION_KOBO || kobo > MAX_TRANSACTION_KOBO) {
    throw new AppError(
      400,
      `Your rate must be between ${formatNairaForMessage(MIN_TRANSACTION_KOBO)} and ` +
        `${formatNairaForMessage(MAX_TRANSACTION_KOBO)}. ` +
        'Bookings outside that range cannot be processed by our payment partner.'
    );
  }

  return kobo;
}

/**
 * Updates the calling artist's own profile.
 *
 * Ownership is resolved from the authenticated user rather than taken from the
 * request, so there is no artist id to tamper with. An attempt to edit someone
 * else's profile is a 403 rather than a silent no-op — a silent no-op hides an
 * attempt worth seeing.
 */
async function updateOwnProfile({ userId, patch }) {
  const artist = await prisma.artist.findUnique({ where: { userId } });
  if (!artist) {
    throw new AppError(403, 'Only artists can edit an artist profile.');
  }

  const data = {};
  for (const field of EDITABLE) {
    if (patch[field] === undefined) continue;
    data[field] = field === 'baseRateKobo' ? validateBaseRate(patch[field]) : patch[field];
  }

  if (Object.keys(data).length === 0) {
    throw new AppError(400, 'Nothing to update.');
  }

  if (data.stageName !== undefined && String(data.stageName).trim().length === 0) {
    throw new AppError(400, 'Enter a stage name.');
  }

  const merged = { ...artist, ...data };
  data.profileComplete = REQUIRED_FOR_COMPLETE.every(
    (f) => merged[f] !== null && merged[f] !== undefined && String(merged[f]).trim() !== ''
  );

  return prisma.artist.update({ where: { id: artist.id }, data });
}

/**
 * Updates a specific artist by id, enforcing ownership.
 *
 * Exists because the API exposes `PUT /artists/:id`, and the check has to be
 * server-side at the endpoint — hiding the edit button is a courtesy to the
 * honest user, not a permission check (docs/07 §2).
 */
async function updateProfileAsOwner({ artistId, userId, patch }) {
  const artist = await prisma.artist.findUnique({ where: { id: artistId } });
  if (!artist) throw new AppError(404, 'Artist not found.');

  if (artist.userId !== userId) {
    throw new AppError(403, 'You can only edit your own profile.');
  }

  return updateOwnProfile({ userId, patch });
}

/**
 * Whether an artist may appear in public listings.
 *
 * Excluded at the query level in #12 rather than filtered in the frontend: a
 * suspended artist appearing in a listing, even briefly, is a trust failure.
 */
function listabilityFilter() {
  return {
    profileComplete: true,
    user: {
      verificationStatus: 'VERIFIED',
      accountStanding: { notIn: ['SUSPENDED', 'REMOVED'] },
    },
  };
}

async function isListable(artistId) {
  const found = await prisma.artist.findFirst({
    where: { id: artistId, ...listabilityFilter() },
    select: { id: true },
  });
  return Boolean(found);
}

module.exports = {
  validateBaseRate,
  updateOwnProfile,
  updateProfileAsOwner,
  listabilityFilter,
  isListable,
  REQUIRED_FOR_COMPLETE,
  MIN_TRANSACTION_KOBO,
  MAX_TRANSACTION_KOBO,
};
