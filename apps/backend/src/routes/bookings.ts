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
const {
  createEscrowForBooking,
  cancelByClient,
  cancelByArtist,
} = require('../services/escrowService.ts');
const { applicableTier } = require('../services/cancellationService.ts');
const {
  computeClientCancellation,
  computeArtistCancellation,
} = require('../services/feeService.ts');
const strikeService = require('../services/strikeService.ts');
const { codeForClient, redeem } = require('../services/checkInService.ts');
const { confirm, claimNoShow } = require('../services/confirmationService.ts');
const disputeService = require('../services/disputeService.ts');

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

    // Who has responded, and when (#24). Both parties see both, so the status
    // page can say "waiting for the client" rather than leaving an artist
    // wondering whether anything is happening. The client's written account of
    // a no-show is NOT here — it is an accusation, and it belongs in the
    // dispute record where the other party can answer it.
    clientConfirmedAt: booking.clientConfirmedAt,
    artistConfirmedAt: booking.artistConfirmedAt,
    clientNoShowClaimedAt: booking.clientNoShowClaimedAt,

    // When silence releases the money (#25, docs/04 §4). Disclosed because the
    // client is being told that not responding has a consequence, and that only
    // works if they are told when.
    autoReleaseAt: booking.autoReleaseAt,
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

/**
 * POST /bookings/:id/confirm
 *
 * Either party confirms the event took place — issue #24, docs/04 §3.
 *
 * Open to CLIENT and ARTIST because both rows of the matrix that end in a
 * release begin with a confirmation, and the two are recorded separately. The
 * caller's part in the booking is resolved server-side from the token; there is
 * no role in the request body to disagree with it.
 *
 * What happens next is the matrix's decision, not the caller's: a client's
 * confirmation releases, an artist's alone waits for the grace period, because
 * an artist confirming their own payment is not evidence of anything.
 */
router.post('/bookings/:id/confirm', requireAuth, async (req: AuthedReq, res: Res, next: Next) => {
  try {
    const result = await confirm({ bookingId: req.params.id, userId: req.user.id });
    res.json({ confirmation: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /bookings/:id/claim-no-show
 *
 * The client reports that the artist did not perform.
 *
 * CLIENT only. An artist reporting their own absence is a cancellation (#28),
 * not a claim about someone else's conduct.
 *
 * Uncontradicted, this refunds the client in full including the fee they paid
 * at funding. Contradicted by a check-in, it opens a dispute and **nothing is
 * decided automatically** — one of the two parties is not telling the truth,
 * and the system cannot determine which (docs/04 §3).
 */
router.post(
  '/bookings/:id/claim-no-show',
  requireAuth,
  requireRole('CLIENT'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { reason } = req.body ?? {};

      const result = await claimNoShow({
        bookingId: req.params.id,
        clientUserId: req.user.id,
        reason,
      });

      res.json({ confirmation: result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /bookings/:id/cancellation-preview
 *
 * EXACT figures, before anything is committed — issue #27, docs/05 §8.
 *
 * Not an estimate and not a range. `docs/00` §10 exists because the failure
 * this system is built to avoid is a client discovering a deduction after the
 * fact, and a preview that rounds differently from the thing that executes is
 * the same failure with extra steps. It therefore calls the SAME function the
 * cancellation calls, against the SAME snapshot.
 *
 * Open to both parties. An artist is entitled to know what a cancellation today
 * would pay them — it is their date being held.
 */
router.get(
  '/bookings/:id/cancellation-preview',
  requireAuth,
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: { client: true, artist: true },
      });

      const isParticipant =
        booking &&
        (booking.client.userId === req.user.id || booking.artist.userId === req.user.id);
      if (!isParticipant) throw new AppError(404, 'Booking not found.');

      const { tier, daysBefore } = applicableTier(booking);

      const breakdown = computeClientCancellation({
        amountKobo: booking.amountKobo,
        commissionBps: booking.commissionRateBpsSnapshot,
        clientRefundBps: tier.clientRefundBps,
        artistCompensationBps: tier.artistCompensationBps,
      });

      res.json({
        preview: {
          bookingId: booking.id,
          state: booking.state,
          cancellable: canBeCancelled(booking.state),
          daysBeforeEvent: daysBefore,
          appliedTier: tier,

          amountKobo: booking.amountKobo,
          clientRefundKobo: breakdown.clientRefundKobo,
          artistCompensationKobo: breakdown.artistCompensationKobo,
          commissionKobo: breakdown.commissionKobo,

          // Named separately because it is the figure a client is most likely
          // to feel misled about: paid at funding, on top of the amount, and
          // consumed whether or not the event happens.
          clientSunkFeeKobo: breakdown.clientSunkFeeKobo,
          moneyOutFeeKobo: breakdown.moneyOutFeeKobo,

          // Never negative. docs/05 §6: a shortfall is not recovered from
          // anyone, but it must be SHOWN rather than discovered.
          unrecoveredShortfallKobo: breakdown.unrecoveredShortfallKobo,

          // THE ARTIST'S OWN DECISION IS A DIFFERENT ONE (#30).
          //
          // The figures above answer "what happens if the client cancels". An
          // artist weighing whether to cancel needs what it costs THEM: the
          // client is made whole, they are paid nothing, they owe the fees, and
          // their standing changes. Showing them the client's split would be
          // answering a question they did not ask.
          ifArtistCancels: await artistOutcome(booking, daysBefore),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /bookings/:id/cancel
 *
 * **Behaviour differs by caller role** — docs/02 §7. Both parties use this
 * path, and which one is calling is resolved server-side from the token against
 * the booking, never from the request body.
 *
 * | Caller | Outcome |
 * |---|---|
 * | `CLIENT` | Tiered split from the booking's snapshot; the client bears the fees (#27) |
 * | `ARTIST` | Client made whole including the fee they paid; the artist accrues a liability (#28) |
 *
 * These are different economic events, not one event with a parameter. A client
 * cancelling has made a choice with a price attached, which they acknowledged
 * at #16. An artist cancelling has removed the thing that was bought.
 */
router.post(
  '/bookings/:id/cancel',
  requireAuth,
  requireRole('CLIENT', 'ARTIST'),
  async (req: AuthedReq, res: Res, next: Next) => {
    try {
      const { reason } = req.body ?? {};
      const trimmed = reason ? String(reason).slice(0, 2000) : undefined;

      const cancellation =
        req.user.role === 'ARTIST'
          ? await cancelByArtist({
              bookingId: req.params.id,
              artistUserId: req.user.id,
              reason: trimmed,
            })
          : await cancelByClient({
              bookingId: req.params.id,
              clientUserId: req.user.id,
              reason: trimmed,
            });

      res.json({ cancellation });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * What cancelling costs the artist, in money and in standing.
 *
 * Both halves, because both are consequences they should be able to weigh
 * before deciding rather than discover on their next payout (#30). The strike
 * band is read from the rules in force, not hardcoded — #33 makes those
 * configurable and a preview quoting stale numbers is worse than none.
 */
async function artistOutcome(booking: BookingRow, daysBefore: number) {
  const corrected = computeArtistCancellation({ amountKobo: booking.amountKobo });
  const { rules } = await strikeService.resolveRules();
  const rule = strikeService.triggerForCancellation(rules, 'ARTIST', daysBefore);

  return {
    // The client is made whole, whatever the timing.
    clientRefundKobo: corrected.clientRefundKobo,
    clientFeeReimbursementKobo: corrected.clientFeeReimbursementKobo,
    clientTotalReturnedKobo: corrected.clientTotalReturnedKobo,

    // Nothing for the artist, and a debt.
    artistCompensationKobo: 0,
    feeLiabilityKobo: corrected.feeLiabilityKobo,

    consequence: strikeService.consequenceOfArtistCancellation(rule),
  };
}

/**
 * POST /bookings/:id/disputes
 *
 * Either party raises a dispute — issue #31, docs/04 §5.
 *
 * #24 opens one automatically when a no-show claim is contradicted by a
 * check-in. This is the manual path, for everything that is not that: a
 * performance that happened but not as agreed, a client who says the artist
 * left early, an artist who says the venue never let them in.
 *
 * OPENING ONE STOPS THE CLOCK. Auto-release is cancelled, so a dispute raised
 * near the grace boundary cannot be overtaken by an automatic payout while it
 * is under review.
 */
router.post('/bookings/:id/disputes', requireAuth, async (req: AuthedReq, res: Res, next: Next) => {
  try {
    const { reason } = req.body ?? {};

    const dispute = await disputeService.raise({
      bookingId: req.params.id,
      userId: req.user.id,
      reason,
    });

    res.status(201).json({ dispute });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /disputes/:id
 *
 * One dispute, for a party to it. Both sides see both submissions — a dispute
 * where only one side can read the case against them is not one.
 */
router.get('/disputes/:id', requireAuth, async (req: AuthedReq, res: Res, next: Next) => {
  try {
    const dispute = await disputeService.forParty({
      disputeId: req.params.id,
      userId: req.user.id,
    });
    res.json({ dispute });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /disputes/:id/evidence
 *
 * A written statement, a file link, or both. Accepted while a dispute is open
 * or under review; refused once it has been decided, because after a ruling
 * there is nothing for it to inform and accepting it would imply a
 * reconsideration that is not going to happen.
 */
router.post('/disputes/:id/evidence', requireAuth, async (req: AuthedReq, res: Res, next: Next) => {
  try {
    const { statement, fileUrl } = req.body ?? {};

    const dispute = await disputeService.submitEvidence({
      disputeId: req.params.id,
      userId: req.user.id,
      statement,
      fileUrl,
    });

    res.status(201).json({ dispute });
  } catch (err) {
    next(err);
  }
});

/** Whether a cancellation is still possible, for the preview's own use. */
function canBeCancelled(state: BookingState): boolean {
  return state === 'PENDING_PAYMENT' || state === 'FUNDED_HELD';
}

module.exports = { router, publicBooking };
