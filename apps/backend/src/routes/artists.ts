/**
 * Artist profile and rate card — issue #11.
 *
 * Public discovery (`GET /artists`, `GET /artists/:id`) is #12. This issue owns
 * the artist's own view and edit of their profile.
 */

const express = require('express');

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const { requireAuth, requireRole } = require('../middleware/auth.ts');
const {
  updateProfileAsOwner,
  isListable,
  listabilityFilter,
} = require('../services/artistService.ts');

const router = express.Router();

/** The artist shape safe to return. An allowlist, so a column added later is private by default. */
function publicArtist(artist) {
  return {
    id: artist.id,
    stageName: artist.stageName,
    bio: artist.bio,
    category: artist.category,
    location: artist.location,
    // Kobo integer, never a formatted string — conversion to Naira is the web
    // app's job via formatNaira() (docs/00 §6).
    baseRateKobo: artist.baseRateKobo,
    media: artist.media,
    profileComplete: artist.profileComplete,
    createdAt: artist.createdAt,
  };
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * The public shape of an artist.
 *
 * `cancellationRate` is present from today, returning `null`, even though the
 * calculation lands in #35. Two reasons: adding the field later would mean
 * revisiting the frontend, and a `null` contract established now forces #13 to
 * handle the below-threshold case correctly from the start rather than treating
 * it as an edge case bolted on afterwards.
 *
 * `null` means "not enough bookings to say anything". The UI renders NOTHING
 * for it — not "0%", which implies a perfect record that has not been earned,
 * and not "N/A", which draws attention to an absence and reads as a warning
 * (docs/06 §4).
 */
function publicListing(artist) {
  return {
    id: artist.id,
    stageName: artist.stageName,
    bio: artist.bio,
    category: artist.category,
    location: artist.location,
    baseRateKobo: artist.baseRateKobo,
    media: artist.media,
    // Populated in #35. Present and null, never omitted.
    cancellationRate: null,
  };
}

/**
 * GET /artists — public discovery.
 *
 * No authentication: discovery is public. Suspended, unverified and incomplete
 * artists are excluded **at the query level** rather than filtered afterwards —
 * a suspended artist appearing in a listing, even briefly, is a trust failure.
 */
router.get('/artists', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE_SIZE));

    const where = {
      ...listabilityFilter(),
      ...(req.query.category ? { category: { equals: String(req.query.category), mode: 'insensitive' } } : {}),
      ...(req.query.location ? { location: { equals: String(req.query.location), mode: 'insensitive' } } : {}),
    };

    const [artists, total] = await Promise.all([
      prisma.artist.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.artist.count({ where }),
    ]);

    res.json({
      artists: artists.map(publicListing),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /artists/:id — public detail.
 *
 * A non-listable artist returns 404 rather than 403. Distinguishing them would
 * confirm the account exists, which is information a suspended artist's
 * would-be clients have no business receiving.
 */
router.get('/artists/:id', async (req, res, next) => {
  try {
    const artist = await prisma.artist.findFirst({
      where: { id: req.params.id, ...listabilityFilter() },
    });
    if (!artist) throw new AppError(404, 'Artist not found.');

    res.json({ artist: publicListing(artist) });
  } catch (err) {
    next(err);
  }
});

/** GET /me/artist-profile — the calling artist's own profile. */
router.get('/me/artist-profile', requireAuth, requireRole('ARTIST'), async (req, res, next) => {
  try {
    const artist = await prisma.artist.findUnique({ where: { userId: req.user.id } });
    if (!artist) throw new AppError(404, 'Artist profile not found.');

    res.json({
      artist: publicArtist(artist),
      // Told plainly why they are not yet discoverable, rather than left to
      // wonder why nobody can find them.
      listable: await isListable(artist.id),
      verificationStatus: req.user.verificationStatus,
    });
  } catch (err) {
    next(err);
  }
});

/** PUT /artists/:id — ownership enforced server-side at the endpoint. */
router.put('/artists/:id', requireAuth, requireRole('ARTIST'), async (req, res, next) => {
  try {
    const artist = await updateProfileAsOwner({
      artistId: req.params.id,
      userId: req.user.id,
      patch: req.body ?? {},
    });
    res.json({ artist: publicArtist(artist), listable: await isListable(artist.id) });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, publicArtist };
