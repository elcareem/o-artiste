/**
 * Booking creation and status — issue #15.
 */

const express = require('express');

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const { requireAuth, requireRole, requireVerified } = require('../middleware/auth.ts');
const { createBooking } = require('../services/bookingService.ts');
const { computeCompletion } = require('../services/feeService.ts');
const {
  getTermsForBooking,
  acknowledgeTerms,
  assertAcknowledged,
} = require('../services/acknowledgementService.ts');
const { createEscrowForBooking } = require('../services/escrowService.ts');
const { codeForClient, redeem } = require('../services/checkInService.ts');

const router = express.Router();

/**
 * The booking shape safe to return to a participant.
 *
 * An allowlist. `checkInCode` is deliberately absent — it is issued to the
 * client only, and #22 adds it to the client's own view behind a role check.
 * Serialising it here would leak it to the artist, which would defeat the
 * entire mechanism (docs/04 §1).
 */
function publicBooking(booking: BookingRow) {
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
  async (req: AuthedReq, res: Res, next: Next) => {
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
router.get('/bookings/:id', requireAuth, async (req: AuthedReq, res: Res, next: Next) => {
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
router.get('/bookings/:id/payout-preview', requireAuth, async (req: AuthedReq, res: Res, next: Next) => {
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

    // OUTSTANDING LIABILITIES ARE DISCLOSED HERE, because #26 nets them off
    // this payout and an artist should not discover the deduction afterwards.
    // docs/00 §7 requires them to see their net before agreeing to a booking,
    // and "net" that omits a known deduction is not a net.
    //
    // Reported separately rather than subtracted into `artistNetKobo`: an
    // earlier booking may settle the liability first, so the deduction is
    // possible rather than certain, and a single blended figure could not say
    // which. #26 settles whole liabilities only, so `willSettle` lists exactly
    // those this payout could clear.
    const outstanding = await prisma.feeLiability.findMany({
      where: { artistUserId: booking.artist.userId, status: 'OUTSTANDING' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, amountKobo: true, originBookingId: true, createdAt: true },
    });

    const willSettle = [];
    let settleableKobo = 0;
    for (const liability of outstanding) {
      if (settleableKobo + liability.amountKobo > breakdown.artistNetKobo) continue;
      willSettle.push(liability);
      settleableKobo += liability.amountKobo;
    }

    res.json({
      payout: {
        ...breakdown,
        outstandingLiabilityKobo: outstanding.reduce((sum: Kobo, l: { amountKobo: Kobo }) => sum + l.amountKobo, 0),
        liabilitySettleableKobo: settleableKobo,
        /** What would actually reach the artist if this released now. */
        estimatedPayoutKobo: breakdown.artistNetKobo - settleableKobo,
        liabilities: willSettle,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /bookings/:id/terms
 *
 * The cancellation table this booking is governed by, in full, read from its
 * own snapshot. Rendered at checkout as a distinct step — not a link, and not
 * buried in general terms (docs/05 §8).
 */
router.get('/bookings/:id/terms', requireAuth, requireRole('CLIENT'), async (req: AuthedReq, res: Res, next: Next) => {
  try {
    const terms = await getTermsForBooking({
      bookingId: req.params.id,
      clientUserId: req.user.id,
    });
    res.json({ terms });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /bookings/:id/check-in-code
 *
 * The check-in code, its QR, and whether it is redeemable right now.
 *
 * `requireRole('CLIENT')` is the outer guard and ownership is checked inside
 * the service, so an artist token cannot reach this handler at all and a client
 * who is not THIS booking's client gets 404. This is the only endpoint in the
 * system that returns `checkInCode` in any form (docs/02 §5) — every other
 * booking response goes through `publicBooking()`, which does not carry it.
 *
 * 404 rather than 403 for a non-owner: a 403 confirms the booking exists, and
 * "this booking has a code you may not see" is worth nothing to a stranger and
 * something to an artist probing for one.
 */
router.get(
  '/bookings/:id/check-in-code',
  requireAuth,
  requireRole('CLIENT'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const checkIn = await codeForClient({
        bookingId: req.params.id,
        userId: req.user.id,
      });
      res.json({ checkIn });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /bookings/:id/terms/acknowledge
 *
 * Records the acknowledgement. The client sends back the tiers as displayed to
 * them, which are checked against the snapshot — that is what makes the record
 * evidence rather than an assertion.
 */
router.post(
  '/bookings/:id/terms/acknowledge',
  requireAuth,
  requireRole('CLIENT'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { acknowledged, tiersAsDisplayed } = req.body ?? {};

      const record = await acknowledgeTerms({
        bookingId: req.params.id,
        clientUserId: req.user.id,
        acknowledged,
        tiersAsDisplayed,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.status(201).json({
        acknowledgement: {
          bookingId: record.bookingId,
          acknowledgedAt: record.acknowledgedAt,
          tiersAsDisplayed: record.tiersAsDisplayed,
          commissionRateBpsAsDisplayed: record.commissionRateBpsAsDisplayed,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /bookings/:id/funding
 *
 * Returns the bank transfer instruction. #18 replaces the body of this with a
 * real escrow creation; what matters here is the GATE.
 *
 * A booking cannot proceed to funding without a recorded acknowledgement, and
 * the check lives at the endpoint — so calling this directly, without visiting
 * the checkout step, fails exactly as it would through the UI.
 */
router.post('/bookings/:id/funding', requireAuth, requireRole('CLIENT'), async (req: AuthedReq, res: Res, next: Next) => {
  try {
    // Escrow creation lives in escrowService — the only module permitted to
    // talk to the provider about money. The acknowledgement gate is enforced
    // there as well as here, so no future caller can reach it around the check.
    const funding = await createEscrowForBooking({
      bookingId: req.params.id,
      clientUserId: req.user.id,
    });
    res.json({ funding });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /bookings/:id/check-in
 *
 * The artist redeems the client's code on arrival — issue #23, docs/04 §2.
 *
 * The request body carries the code and, optionally, a geolocation reading.
 * **It cannot carry a time.** `redeem()` has no parameter for one and the
 * column is a database default, so a `redeemedAt` in the body is not ignored by
 * a line of code that could later be removed — there is nowhere for it to go.
 * That is what makes the record evidence rather than an assertion.
 */
router.post(
  '/bookings/:id/check-in',
  requireAuth,
  requireRole('ARTIST'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { code, latitude, longitude, accuracyMeters } = req.body ?? {};

      if (!code) throw new AppError(400, 'Enter the check-in code from the client.');

      const { checkIn, booking } = await redeem({
        bookingId: req.params.id,
        artistUserId: req.user.id,
        code,
        latitude,
        longitude,
        accuracyMeters,
      });

      res.status(201).json({
        checkIn: {
          bookingId: checkIn.bookingId,
          redeemedAt: checkIn.redeemedAt,
          hasLocation: checkIn.latitude !== null,
        },
        booking: publicBooking(booking),
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = { router, publicBooking };
