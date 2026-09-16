/**
 * Disputes — docs/04-CONFIRMATION-AND-DISPUTES.md §5, issue #31.
 *
 * THE FUNDS STAY HELD, AND NOTHING RESOLVES ON A TIMER.
 *
 * That is the whole design. Any default outcome is gameable: whichever party it
 * favours simply waits for the clock. So a dispute has no expiry, no automatic
 * release, no automatic refund — it sits until a person decides, and the money
 * sits with it.
 *
 * `OPEN → UNDER_REVIEW → RESOLVED_RELEASE | RESOLVED_REFUND | RESOLVED_SPLIT`
 *
 * This module opens disputes and accepts evidence. It cannot resolve one: the
 * money-moving half is #32, and keeping it out of here is what makes "a dispute
 * cannot reach a resolved state without an admin action" a property of the
 * code rather than a rule someone has to remember.
 */

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const { transition, canTransition } = require('./bookingService.ts');
const { recordAudit } = require('../lib/audit.ts');

/** The states a dispute may move between — docs/04 §5. */
const ALLOWED_DISPUTE_TRANSITIONS: Readonly<Record<DisputeState, readonly DisputeState[]>> =
  Object.freeze({
    OPEN: ['UNDER_REVIEW', 'RESOLVED_RELEASE', 'RESOLVED_REFUND', 'RESOLVED_SPLIT'],
    UNDER_REVIEW: ['RESOLVED_RELEASE', 'RESOLVED_REFUND', 'RESOLVED_SPLIT'],
    RESOLVED_RELEASE: [],
    RESOLVED_REFUND: [],
    RESOLVED_SPLIT: [],
  });

const RESOLVED_STATES: readonly DisputeState[] = Object.freeze([
  'RESOLVED_RELEASE',
  'RESOLVED_REFUND',
  'RESOLVED_SPLIT',
]);

/** Whether a dispute has been decided. */
function isResolved(state: DisputeState): boolean {
  return RESOLVED_STATES.includes(state);
}

function assertDisputeTransition(from: DisputeState, to: DisputeState): void {
  if (!(from in ALLOWED_DISPUTE_TRANSITIONS)) {
    throw new AppError(500, `Unknown dispute state: ${from}.`);
  }
  if (!ALLOWED_DISPUTE_TRANSITIONS[from].includes(to)) {
    throw new AppError(
      409,
      isResolved(from)
        ? 'This dispute has already been decided and cannot change.'
        : 'That is not a step this dispute can take.'
    );
  }
}

/**
 * Opens a dispute over a booking.
 *
 * Called by #24 automatically when a no-show claim is contradicted by a
 * check-in, and by either party manually. The two paths differ only in who
 * `openedByUserId` names.
 *
 * THE CHECK-IN IS ATTACHED WHERE ONE EXISTS. It reduces the commonest dispute —
 * "did the event happen?" — to a timestamped fact, and an admin should not have
 * to go looking for the one piece of evidence that settles it.
 *
 * Idempotent: a booking with an open dispute returns it rather than opening a
 * second. Two disputes over one booking is two people deciding the same money.
 */
async function openDispute(
  tx: PrismaTx,
  { bookingId, openedByUserId, reason }: OpenDisputeInput
): Promise<DisputeRow> {
  if (!reason || !String(reason).trim()) {
    throw new AppError(400, 'Say what the dispute is about.');
  }

  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: { checkIn: true, disputes: true },
  });

  if (!booking) throw new AppError(404, 'Booking not found.');

  const existing = booking.disputes.find((d: DisputeRow) => !isResolved(d.state));
  if (existing) return existing;

  const dispute = await tx.dispute.create({
    data: {
      bookingId: booking.id,
      openedByUserId,
      openedReason: String(reason).slice(0, 2000),
      checkInId: booking.checkIn?.id ?? null,
    },
  });

  // The booking moves too, so that every other path — auto-release, release,
  // refund — sees a disputed booking and refuses.
  if (canTransition(booking.state, 'DISPUTED')) {
    await transition({ bookingId: booking.id, to: 'DISPUTED', client: tx });
  }

  await recordAudit(tx, {
    actorUserId: openedByUserId,
    action: 'DISPUTE_OPENED',
    entityType: 'Dispute',
    entityId: dispute.id,
    reason: String(reason).slice(0, 2000),
    after: { bookingId: booking.id, checkInId: dispute.checkInId },
  });

  return dispute;
}

/**
 * Opens a dispute from a request, then stops the clock on the money.
 *
 * THE AUTO-RELEASE JOB IS CANCELLED HERE. Without it a dispute raised near the
 * grace boundary could be overtaken by an automatic release while under review
 * — money gone, mid-review, in favour of whichever party the timer happened to
 * suit. The job also re-checks for an open dispute when it wakes, so this is
 * the second of two guards rather than the only one.
 */
async function raise({
  bookingId,
  userId,
  reason,
}: {
  bookingId: string;
  userId: string;
  reason: string;
}): Promise<DisputeView> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { client: true, artist: true },
  });

  if (!booking) throw new AppError(404, 'Booking not found.');

  const party = partyOf(booking, userId);
  // 404 rather than 403 — confirming a booking exists is itself information.
  if (!party) throw new AppError(404, 'Booking not found.');

  if (booking.state === 'PENDING_PAYMENT') {
    throw new AppError(
      409,
      'This booking has not been paid for, so there is nothing to dispute. Cancel it instead.'
    );
  }

  if (['RELEASED', 'REFUNDED', 'CANCELLED', 'RESOLVED'].includes(booking.state)) {
    throw new AppError(
      409,
      'This booking is closed. Contact support if you think the outcome was wrong.'
    );
  }

  const dispute = await prisma.$transaction((tx: PrismaTx) =>
    openDispute(tx, { bookingId, openedByUserId: userId, reason })
  );

  // After the commit: a job cancelled against a transaction that then rolled
  // back would leave a dispute with no protection at all.
  await require('../jobs/autoReleaseJob.ts').cancel(bookingId);

  console.log(`[dispute] ${dispute.id} opened on booking ${bookingId} by the ${party.toLowerCase()}`);

  return view(await load(dispute.id), userId);
}

/**
 * Attaches a statement or a file to a dispute.
 *
 * BOTH PARTIES, THE SAME DISPUTE. A dispute where only one side can speak is
 * not a dispute, and separate records per party would let an admin read one
 * without the other.
 *
 * Evidence is accepted while a dispute is open or under review, and refused
 * once it is decided — after a ruling there is nothing for it to inform, and
 * accepting it would imply a reconsideration that is not going to happen.
 */
async function submitEvidence({
  disputeId,
  userId,
  statement,
  fileUrl,
}: SubmitEvidenceInput): Promise<DisputeView> {
  const hasStatement = Boolean(statement && String(statement).trim());
  const hasFile = Boolean(fileUrl && String(fileUrl).trim());

  if (!hasStatement && !hasFile) {
    throw new AppError(400, 'Add a statement or a file.');
  }

  if (hasFile) assertSafeFileUrl(String(fileUrl));

  const dispute = await load(disputeId);
  if (!dispute) throw new AppError(404, 'Dispute not found.');

  const party = partyOf(dispute.booking, userId);
  if (!party) throw new AppError(404, 'Dispute not found.');

  if (isResolved(dispute.state)) {
    throw new AppError(
      409,
      'This dispute has already been decided, so no more evidence can be added.'
    );
  }

  await prisma.$transaction(async (tx: PrismaTx) => {
    await tx.disputeEvidence.create({
      data: {
        disputeId,
        submittedByUserId: userId,
        statement: hasStatement ? String(statement).slice(0, 5000) : null,
        fileUrl: hasFile ? String(fileUrl).trim() : null,
      },
    });

    // The first evidence after opening moves it along, so an admin queue can
    // tell "nobody has said anything yet" from "both sides have made their
    // case". Nothing here can reach a resolved state.
    if (dispute.state === 'OPEN') {
      assertDisputeTransition(dispute.state, 'UNDER_REVIEW');
      await tx.dispute.update({ where: { id: disputeId }, data: { state: 'UNDER_REVIEW' } });
    }
  });

  return view(await load(disputeId), userId);
}

/**
 * Rejects a file reference that is not a plain web URL.
 *
 * `fileUrl` is rendered in the admin queue, so a `javascript:` or `data:` value
 * is a script running in the browser of the person deciding the case. The
 * allowlist is two schemes long on purpose.
 */
function assertSafeFileUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, 'That file link is not a valid web address.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError(400, 'File links must start with https://.');
  }
}

/** One dispute, for a party to read. */
async function forParty({ disputeId, userId }: { disputeId: string; userId: string }): Promise<DisputeView> {
  const dispute = await load(disputeId);
  if (!dispute) throw new AppError(404, 'Dispute not found.');

  if (!partyOf(dispute.booking, userId)) throw new AppError(404, 'Dispute not found.');

  return view(dispute, userId);
}

function load(disputeId: string) {
  return prisma.dispute.findUnique({
    where: { id: disputeId },
    include: {
      booking: { include: { client: true, artist: true } },
      checkIn: true,
      evidence: { orderBy: { createdAt: 'asc' } },
    },
  });
}

/** Which side of the booking this user is on, or null. */
function partyOf(
  booking: { client: ClientRow; artist: ArtistRow },
  userId: string
): 'CLIENT' | 'ARTIST' | null {
  if (booking.client.userId === userId) return 'CLIENT';
  if (booking.artist.userId === userId) return 'ARTIST';
  return null;
}

/**
 * The dispute as a party sees it.
 *
 * BOTH SIDES SEE BOTH SUBMISSIONS. Evidence is shown with who filed it — a
 * statement whose author is unclear is not evidence — and the other party's
 * case is visible so they can answer it rather than guess at it.
 */
function view(dispute: any, viewerUserId: string): DisputeView {
  const viewer = partyOf(dispute.booking, viewerUserId);

  return {
    id: dispute.id,
    bookingId: dispute.bookingId,
    state: dispute.state,
    openedReason: dispute.openedReason,
    openedByYou: dispute.openedByUserId === viewerUserId,
    createdAt: dispute.createdAt,

    // The fact that settles most of these, surfaced rather than buried.
    checkIn: dispute.checkIn
      ? { redeemedAt: dispute.checkIn.redeemedAt, hasLocation: dispute.checkIn.latitude !== null }
      : null,

    resolvedAt: dispute.resolvedAt,
    resolutionReason: dispute.resolutionReason,

    evidence: dispute.evidence.map((e: DisputeEvidenceRow) => ({
      id: e.id,
      byYou: e.submittedByUserId === viewerUserId,
      // The role rather than the identity: an admin needs to know which side
      // filed it, and neither party needs the other's user id.
      party: partyOf(dispute.booking, e.submittedByUserId),
      statement: e.statement,
      fileUrl: e.fileUrl,
      createdAt: e.createdAt,
    })),

    viewerParty: viewer,
  };
}

module.exports = {
  openDispute,
  raise,
  submitEvidence,
  forParty,
  view,
  partyOf,
  isResolved,
  assertDisputeTransition,
  assertSafeFileUrl,
  ALLOWED_DISPUTE_TRANSITIONS,
  RESOLVED_STATES,
};
