/**
 * The operational view of a booking — issue #37, docs/07 §7.
 *
 * This is what someone reads when a client emails asking why they received
 * ₦137,860 instead of ₦140,000. The answer is already in the ledger; this
 * module's whole job is making it legible, which means two things the raw rows
 * do not give you:
 *
 *   - the NET POSITION per party, so "where did the rest go" is answered by
 *     looking rather than by adding up signed integers by hand;
 *   - the SEQUENCE, so a correction reads as "charged, then reversed, and why"
 *     rather than as two unrelated entries that happen to cancel out.
 *
 * Read-only. Nothing here moves money or changes state — the manual release and
 * refund actions go through `escrowService`, which remains the sole money-mover.
 */

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const ledgerService = require('./ledgerService.ts');
const { computeCompletion } = require('./feeService.ts');

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const BOOKING_STATES: readonly BookingState[] = Object.freeze([
  'PENDING_PAYMENT',
  'FUNDED_HELD',
  'CHECKED_IN',
  'AWAITING_CONFIRMATION',
  'DISPUTED',
  'RELEASED',
  'REFUNDED',
  'CANCELLED',
  'RESOLVED',
]);

/**
 * Parses and validates the filter set.
 *
 * An unrecognised state is REFUSED rather than ignored. A filter silently
 * dropped returns a full list that looks like a filtered one, and the reader
 * has no way to tell — on a screen whose purpose is answering a specific
 * question about a specific booking, that is worse than an error.
 */
function parseFilters(query: Record<string, unknown>) {
  const filters: Record<string, any> = {};
  const applied: string[] = [];

  if (query.state !== undefined && query.state !== '') {
    const states = String(query.state)
      .split(',')
      .map((s) => s.trim().toUpperCase());

    const unknown = states.filter((s) => !BOOKING_STATES.includes(s as BookingState));
    if (unknown.length > 0) {
      throw new AppError(400, `Not a booking state: ${unknown.join(', ')}.`);
    }
    filters.state = { in: states };
    applied.push('state');
  }

  const eventDate: Record<string, Date> = {};
  for (const [key, op] of [
    ['from', 'gte'],
    ['to', 'lte'],
  ] as const) {
    if (query[key] === undefined || query[key] === '') continue;
    const date = new Date(String(query[key]));
    if (Number.isNaN(date.getTime())) {
      throw new AppError(400, `"${key}" is not a date we can read. Use YYYY-MM-DD.`);
    }
    eventDate[op] = date;
    applied.push(key);
  }
  if (Object.keys(eventDate).length > 0) filters.eventDate = eventDate;

  const amountKobo: Record<string, number> = {};
  for (const [key, op] of [
    ['minKobo', 'gte'],
    ['maxKobo', 'lte'],
  ] as const) {
    if (query[key] === undefined || query[key] === '') continue;
    // `Number('')` is 0 and `Number(true)` is 1, so the emptiness check above
    // has to come first — a blank value becoming a ₦0 floor would quietly
    // change what the list means.
    const value = Number(query[key]);
    if (!Number.isInteger(value) || value < 0) {
      throw new AppError(400, `"${key}" must be a whole number of kobo, 0 or more.`);
    }
    amountKobo[op] = value;
    applied.push(key);
  }
  if (Object.keys(amountKobo).length > 0) filters.amountKobo = amountKobo;

  if (filters.amountKobo?.gte !== undefined && filters.amountKobo?.lte !== undefined) {
    if (filters.amountKobo.gte > filters.amountKobo.lte) {
      throw new AppError(400, 'The minimum value is higher than the maximum, so nothing can match.');
    }
  }
  if (filters.eventDate?.gte && filters.eventDate?.lte) {
    if (filters.eventDate.gte > filters.eventDate.lte) {
      throw new AppError(400, 'The start date is after the end date, so nothing can match.');
    }
  }

  return { where: filters, applied };
}

/** One row in the list — enough to decide which booking to open, no more. */
function listRow(booking: any) {
  return {
    id: booking.id,
    escrowReference: booking.escrowReference,
    state: booking.state,
    amountKobo: booking.amountKobo,
    eventDate: booking.eventDate,
    createdAt: booking.createdAt,
    client: { displayName: booking.client?.displayName ?? null, email: booking.client?.user?.email ?? null },
    artist: { stageName: booking.artist?.stageName ?? null, email: booking.artist?.user?.email ?? null },
    // Surfaced in the list because it is the one thing that needs acting on and
    // is invisible in the state: RELEASED means the money left escrow, not that
    // the artist has it (#26).
    awaitingPayout: booking.state === 'RELEASED' && booking.paidOutAt === null,
    hasOpenDispute: (booking.disputes ?? []).some((d: any) => d.state === 'OPEN'),
  };
}

async function listBookings(query: Record<string, unknown> = {}) {
  const { where, applied } = parseFilters(query);

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.limit) || DEFAULT_PAGE_SIZE));

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        client: { include: { user: { select: { email: true } } } },
        artist: { include: { user: { select: { email: true } } } },
        disputes: { select: { state: true } },
      },
    }),
    prisma.booking.count({ where }),
  ]);

  return {
    bookings: bookings.map(listRow),
    // Echoed back so the screen can state what it is showing. A list that
    // cannot say how it was filtered is a list that gets misread.
    filters: { applied },
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

/**
 * The timeline, newest last.
 *
 * Transitions recorded before #37 existed are absent, so where a booking has no
 * recorded history the milestone timestamps are used instead and each entry is
 * marked `reconstructed`. Saying which entries are inferred matters more than
 * having a complete-looking list: an admin deciding whether to move money needs
 * to know the difference between a recorded fact and a derived one.
 */
function timeline(booking: any, transitions: any[]) {
  if (transitions.length > 0) {
    return transitions.map((t) => ({
      fromState: t.fromState,
      toState: t.toState,
      at: t.createdAt,
      actor: t.actor ? { email: t.actor.email, role: t.actor.role } : null,
      reason: t.reason,
      reconstructed: false,
    }));
  }

  const milestones: [string, Date | null, BookingState][] = [
    ['created', booking.createdAt, 'PENDING_PAYMENT'],
    ['funded', booking.fundedAt, 'FUNDED_HELD'],
    ['released', booking.releasedAt, 'RELEASED'],
    ['refunded', booking.refundedAt, 'REFUNDED'],
    ['cancelled', booking.cancelledAt, 'CANCELLED'],
  ];

  return milestones
    .filter(([, at]) => at !== null && at !== undefined)
    .sort((a, b) => (a[1] as Date).getTime() - (b[1] as Date).getTime())
    .map(([, at, state], index, all) => ({
      fromState: index === 0 ? null : all[index - 1][2],
      toState: state,
      at,
      actor: null,
      reason: null,
      // This booking predates the transition record. Inferred from the
      // milestone timestamps, which cover the common path and nothing else.
      reconstructed: true,
    }));
}

/**
 * Everything about one booking.
 *
 * The reconciliation is computed here rather than in the view, because a screen
 * that adds up money itself is a second implementation of the arithmetic — and
 * the one that disagrees with the ledger is the one people will read.
 */
async function bookingDetail(bookingId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      client: { include: { user: { select: { id: true, email: true, phone: true } } } },
      artist: { include: { user: { select: { id: true, email: true, phone: true } } } },
      checkIn: true,
      termsAcknowledgement: true,
      cancellation: true,
      disputes: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!booking) throw new AppError(404, 'Booking not found.');

  const [transitions, reconciliation] = await Promise.all([
    prisma.bookingStateTransition.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'asc' },
      include: { actor: { select: { email: true, role: true } } },
    }),
    ledgerService.reconcile(bookingId),
  ]);

  return {
    booking: {
      id: booking.id,
      escrowReference: booking.escrowReference,
      state: booking.state,
      amountKobo: booking.amountKobo,
      commissionRateBpsSnapshot: booking.commissionRateBpsSnapshot,
      cancellationTiersSnapshot: booking.cancellationTiersSnapshot,
      eventDate: booking.eventDate,
      eventEndAt: booking.eventEndAt,
      eventLocation: booking.eventLocation,
      createdAt: booking.createdAt,
      fundedAt: booking.fundedAt,
      releasedAt: booking.releasedAt,
      refundedAt: booking.refundedAt,
      cancelledAt: booking.cancelledAt,
      paidOutAt: booking.paidOutAt,
      clientConfirmedAt: booking.clientConfirmedAt,
      artistConfirmedAt: booking.artistConfirmedAt,
      autoReleaseAt: booking.autoReleaseAt,
      client: {
        displayName: booking.client?.displayName ?? null,
        email: booking.client?.user?.email ?? null,
        phone: booking.client?.user?.phone ?? null,
      },
      artist: {
        id: booking.artist?.id ?? null,
        stageName: booking.artist?.stageName ?? null,
        email: booking.artist?.user?.email ?? null,
        phone: booking.artist?.user?.phone ?? null,
      },
      awaitingPayout: booking.state === 'RELEASED' && booking.paidOutAt === null,
    },

    timeline: timeline(booking, transitions),

    // The primary evidence in any dispute, so it comes before the statements
    // rather than after them (docs/04 §2).
    checkIn: booking.checkIn
      ? {
          redeemedAt: booking.checkIn.redeemedAt,
          redeemedByUser: booking.checkIn.redeemedByUser,
          latitude: booking.checkIn.latitude,
          longitude: booking.checkIn.longitude,
          accuracyMeters: booking.checkIn.accuracyMeters,
        }
      : null,

    // What the client was actually shown, copied by value at the time — not the
    // current configuration. A deduction we cannot prove was disclosed is a
    // deduction we may not be able to defend (#16).
    termsAcknowledgement: booking.termsAcknowledgement
      ? {
          acknowledgedAt: booking.termsAcknowledgement.acknowledgedAt,
          commissionRateBpsAsDisplayed: booking.termsAcknowledgement.commissionRateBpsAsDisplayed,
          tiersAsDisplayed: booking.termsAcknowledgement.tiersAsDisplayed,
          ipAddress: booking.termsAcknowledgement.ipAddress,
          userAgent: booking.termsAcknowledgement.userAgent,
        }
      : null,

    cancellation: booking.cancellation,
    disputes: booking.disputes,

    /**
     * What a release WOULD pay, from the booking's own frozen snapshot.
     *
     * The ledger answers this once a release has happened; before that its
     * artist position is zero, and a screen reading that would offer to
     * "release ₦0". So the projection is computed here by the same function the
     * real release uses — the screen must never do this arithmetic itself, or
     * the number on the button can disagree with the number that moves.
     */
    projection: computeCompletion({
      amountKobo: booking.amountKobo,
      commissionBps: booking.commissionRateBpsSnapshot,
    }),

    ledger: {
      entries: reconciliation.entries.map((e: any) => ({
        id: e.id,
        entryType: e.entryType,
        party: e.party,
        amountKobo: e.amountKobo,
        description: e.description,
        // Named so a correction reads as a pair. The original stays visible
        // because the sequence is the record that matters (docs/01 §5).
        offsetsEntryId: e.offsetsEntryId,
        createdAt: e.createdAt,
      })),
      netByParty: reconciliation.byParty,
      sumKobo: reconciliation.sumKobo,
      // A settled booking's entries sum to zero. Shown rather than assumed:
      // `false` here on a concluded booking is a real problem, and hiding it
      // behind a screen that only displays entries would mean nobody sees it.
      balanced: reconciliation.balanced,
      entryCount: reconciliation.entryCount,
    },
  };
}

module.exports = {
  listBookings,
  bookingDetail,
  parseFilters,
  timeline,
  BOOKING_STATES,
};
