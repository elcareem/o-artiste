/**
 * What a client or artist can do once the event is over — issue #47.
 *
 * Mirrors the backend's rules so nothing is offered that would be refused:
 * confirmation and no-show claims need the event to have ENDED and a booking
 * that is neither unpaid, settled nor already disputed; a no-show is the
 * client's to claim; a dispute can be raised on any funded, unsettled booking.
 * The backend still decides — this is about not offering a button that can
 * only fail.
 */

export type AfterEventBooking = {
  state: string;
  eventEndAt: string | null;
  eventDate: string;
  clientConfirmedAt: string | null;
  artistConfirmedAt: string | null;
  autoReleaseAt: string | null;
  checkedInAt: string | null;
  openDisputeId: string | null;
};

/** Mirrors assertActionable in services/confirmationService.ts. */
export const NOT_ACTIONABLE = ['RELEASED', 'REFUNDED', 'CANCELLED', 'RESOLVED', 'DISPUTED', 'PENDING_PAYMENT'];

export type AfterEventOptions = {
  ended: boolean;
  canConfirm: boolean;
  canClaimNoShow: boolean;
  canDispute: boolean;
  disputeId: string | null;
  /** Shown wherever the client is asked to act: silence has a consequence. */
  deadline: string | null;
  alreadyConfirmed: boolean;
  /**
   * An artist with no check-in on record. Their confirmation is still accepted,
   * but without a check-in the money never releases on silence — payment
   * depends on the client confirming. Checking in, while the window is open,
   * is what protects them (#22, #25).
   */
  artistMissingCheckIn: boolean;
};

export function afterEventOptions(b: AfterEventBooking, role: 'CLIENT' | 'ARTIST', now: Date = new Date()): AfterEventOptions {
  const endsAt = new Date(b.eventEndAt ?? b.eventDate).getTime();
  const ended = now.getTime() >= endsAt;
  const actionable = !NOT_ACTIONABLE.includes(b.state);
  const alreadyConfirmed = Boolean(role === 'CLIENT' ? b.clientConfirmedAt : b.artistConfirmedAt);

  return {
    ended,
    canConfirm: ended && actionable && !alreadyConfirmed,
    // Never over a check-in on record: the artist demonstrably arrived, and a
    // claim otherwise is a false one — which carries a strike (#33). Something
    // that went wrong after they arrived is a dispute.
    canClaimNoShow: role === 'CLIENT' && ended && actionable && !alreadyConfirmed && !b.checkedInAt,
    canDispute: ended && actionable && !b.openDisputeId,
    disputeId: b.openDisputeId,
    deadline: role === 'CLIENT' && b.autoReleaseAt && ended && actionable && !alreadyConfirmed ? b.autoReleaseAt : null,
    alreadyConfirmed,
    artistMissingCheckIn: role === 'ARTIST' && ended && actionable && !b.checkedInAt,
  };
}
