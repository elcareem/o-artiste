/**
 * Artist profile and rate card — issue #11.
 *
 * Public discovery (`GET /artists`, `GET /artists/:id`) is #12. This issue owns
 * the artist's own view and edit of their profile.
 */

const express = require('express');

const prisma = require('../lib/prisma');
const { AppError } = require('../lib/errors');
const { requireAuth, requireRole } = require('../middleware/auth');
const { updateProfileAsOwner, isListable } = require('../services/artistService');

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
