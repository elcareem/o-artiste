/**
 * Cancellation policy acknowledgement — docs/05 §8, issue #16.
 *
 * THIS IS A COMPLIANCE OBLIGATION, NOT A UX PREFERENCE.
 *
 * Nigeria's FCCPA gives consumers a right to a refund where a service is not
 * rendered per agreed terms, and there is public precedent of Nigerian venue
 * cancellation deductions escalating into disputes specifically on the grounds
 * that terms were not clearly disclosed.
 *
 * A deduction we cannot prove was disclosed is a deduction we may not be able
 * to defend. That is what this module exists to produce: evidence.
 */

const prisma = require('../lib/prisma');
const { AppError } = require('../lib/errors');

/** Exactly the fields a band carries. Anything else is not a tier. */
const TIER_FIELDS = ['minDaysBefore', 'maxDaysBefore', 'clientRefundBps', 'artistCompensationBps'];

/**
 * Returns the terms this booking must have acknowledged before it can be
 * funded — read from the booking's own SNAPSHOT, never from live config.
 *
 * This is what the checkout step renders in full. The client sees the table
 * that will actually govern their booking, not the table that happens to be
 * current.
 */
async function getTermsForBooking({ bookingId, clientUserId }) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { client: true, termsAcknowledgement: true },
  });

  if (!booking || booking.client.userId !== clientUserId) {
    throw new AppError(404, 'Booking not found.');
  }

  return {
    bookingId: booking.id,
    amountKobo: booking.amountKobo,
    eventDate: booking.eventDate,
    commissionRateBps: booking.commissionRateBpsSnapshot,
    tiers: booking.cancellationTiersSnapshot,
    acknowledged: Boolean(booking.termsAcknowledgement),
    acknowledgedAt: booking.termsAcknowledgement?.acknowledgedAt ?? null,
  };
}

/**
 * Records an acknowledgement.
 *
 * The client must send back the tiers **as they were displayed to them**, and
 * those are compared against the booking's snapshot. That is not ceremony: it
 * is what makes the record evidence rather than an assertion. If the two
 * disagree, the client was shown something other than what governs the booking,
 * and the acknowledgement is refused rather than recorded as if it were sound.
 */
async function acknowledgeTerms({ bookingId, clientUserId, acknowledged, tiersAsDisplayed, ipAddress, userAgent }) {
  // An active act. A pre-ticked box or a passive T&C acceptance does not
  // satisfy the disclosure requirement, so the flag must be explicitly true.
  if (acknowledged !== true) {
    throw new AppError(400, 'You need to accept the cancellation terms before continuing.');
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { client: true, termsAcknowledgement: true },
  });

  if (!booking || booking.client.userId !== clientUserId) {
    throw new AppError(404, 'Booking not found.');
  }

  if (booking.state !== 'PENDING_PAYMENT') {
    throw new AppError(409, 'This booking can no longer be changed.');
  }

  // Idempotent: re-acknowledging returns the original record rather than
  // creating a second one or erroring. A client who double-taps has not done
  // anything wrong.
  if (booking.termsAcknowledgement) return booking.termsAcknowledgement;

  assertMatchesSnapshot(tiersAsDisplayed, booking.cancellationTiersSnapshot);

  return prisma.termsAcknowledgement.create({
    data: {
      bookingId: booking.id,
      clientUserId,
      // The literal percentages, stored as displayed. NOT a foreign key to a
      // configuration version: a pointer requires reconstructing what the
      // client saw, and a copy IS what they saw.
      tiersAsDisplayed: normaliseTiers(booking.cancellationTiersSnapshot),
      commissionRateBpsAsDisplayed: booking.commissionRateBpsSnapshot,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    },
  });
}

/**
 * Confirms the client acknowledged the same table that governs the booking.
 *
 * Compared field by field after sorting, so key order or band order in the
 * request cannot cause a spurious mismatch — while a genuine difference in any
 * percentage or day range still fails.
 */
function assertMatchesSnapshot(displayed, snapshot) {
  if (!Array.isArray(displayed)) {
    throw new AppError(400, 'Accept the cancellation terms as they were shown to you.');
  }

  const a = normaliseTiers(displayed);
  const b = normaliseTiers(snapshot);

  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new AppError(
      409,
      'The cancellation terms changed while you were reading them. Review them again before continuing.'
    );
  }
}

function normaliseTiers(tiers) {
  return [...tiers]
    .map((t) => {
      const out = {};
      for (const field of TIER_FIELDS) out[field] = t[field] ?? null;
      return out;
    })
    .sort((x, y) => x.minDaysBefore - y.minDaysBefore);
}

/**
 * The gate. Called before any funding action.
 *
 * Throws 409 rather than 403: nothing is forbidden, a required step simply has
 * not happened yet.
 */
async function assertAcknowledged(bookingId, client = prisma) {
  const record = await client.termsAcknowledgement.findUnique({ where: { bookingId } });
  if (!record) {
    throw new AppError(
      409,
      'Accept the cancellation terms before paying for this booking.'
    );
  }
  return record;
}

/** For the admin booking detail view (#37) and dispute defence. */
function getAcknowledgement(bookingId, client = prisma) {
  return client.termsAcknowledgement.findUnique({ where: { bookingId } });
}

module.exports = {
  getTermsForBooking,
  acknowledgeTerms,
  assertAcknowledged,
  getAcknowledgement,
  TIER_FIELDS,
};
