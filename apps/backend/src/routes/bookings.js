/**
 * Booking creation and status — issue #15.
 */

const express = require('express');

const prisma = require('../lib/prisma');
const { AppError } = require('../lib/errors');
const { requireAuth, requireRole, requireVerified } = require('../middleware/auth');
const { createBooking } = require('../services/bookingService');
const { computeCompletion } = require('../services/feeService');

const router = express.Router();

/**
 * The booking shape safe to return to a participant.
 *
 * An allowlist. `checkInCode` is deliberately absent — it is issued to the
 * client only, and #22 adds it to the client's own view behind a role check.
 * Serialising it here would leak it to the artist, which would defeat the
 * entire mechanism (docs/04 §1).
 */
function publicBooking(booking) {
  return {
    id: booking.id,
    state: booking.state,
    amountKobo: booking.amountKobo,
    eventDate: booking.eventDate,
    eventEndAt: booking.eventEndAt,
    eventLocation: booking.eventLocation,
    escrowReference: booking.escrowReference,
    createdAt: booking.createdAt,

    // The snapshot is returned so a client can see the terms that apply to
    // THIS booking, not whatever the current configuration says.
    commissionRateBpsSnapshot: booking.commissionRateBpsSnapshot,
    cancellationTiersSnapshot: booking.cancellationTiersSnapshot,
  };
}

/**
 * POST /bookings
 *
 * `requireVerified` closes #10's deferred criterion: an unverified client
 * receives 403 with a message telling them what to do about it.
 */
router.post(
  '/bookings',
  requireAuth,
  requireRole('CLIENT'),
  requireVerified,
  async (req, res, next) => {
    try {
      const { artistId, amountKobo, eventDate, eventEndAt, eventLocation } = req.body ?? {};

      if (!artistId) throw new AppError(400, 'Choose an artist to book.');

      const booking = await createBooking({
        clientUserId: req.user.id,
        artistId: String(artistId),
        amountKobo,
        eventDate,
        eventEndAt,
        eventLocation,
      });

      res.status(201).json({ booking: publicBooking(booking) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /bookings/:id
 *
 * Visible to the booking's own client and artist only. A stranger gets 404
 * rather than 403 — confirming a booking exists is itself information.
 */
router.get('/bookings/:id', requireAuth, async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { client: true, artist: true },
    });

    const isParticipant =
      booking &&
      (booking.client.userId === req.user.id ||
        booking.artist.userId === req.user.id ||
        req.user.role === 'ADMIN' ||
        req.user.role === 'SUPER_ADMIN');

    if (!isParticipant) throw new AppError(404, 'Booking not found.');

    res.json({ booking: publicBooking(booking) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /bookings/:id/payout-preview
 *
 * What the artist would net, computed from the booking's SNAPSHOT.
 *
 * Required before acceptance by docs/00 §7: an artist must see their net after
 * commission and escrow fees before agreeing to a booking. Reading the snapshot
 * rather than live configuration is the whole point of #15.
 */
router.get('/bookings/:id/payout-preview', requireAuth, async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { client: true, artist: true },
    });

    const isParticipant =
      booking &&
      (booking.client.userId === req.user.id || booking.artist.userId === req.user.id);
    if (!isParticipant) throw new AppError(404, 'Booking not found.');

    const breakdown = computeCompletion({
      amountKobo: booking.amountKobo,
      commissionBps: booking.commissionRateBpsSnapshot,
    });

    res.json({ payout: breakdown });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, publicBooking };
