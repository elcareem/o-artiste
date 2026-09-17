/**
 * Dispute display logic — issue #32.
 *
 * Pure, so the parts that matter — what an admin is shown before deciding, and
 * whether a split is arithmetically possible — are testable without a browser.
 */

import { formatNaira } from './currency.ts';

export type DisputeOutcome = 'RELEASE' | 'REFUND' | 'SPLIT';

export type QueueEntry = {
  id: string;
  bookingId: string;
  state: string;
  openedAt: string;
  ageDays: number;
  amountKobo: number;
  artist: string;
  client: string;
  hasCheckIn: boolean;
  evidenceCount: number;
  openedReason: string;
};

export type DisputeDetail = {
  id: string;
  state: string;
  openedAt: string;
  openedReason: string;
  openedBy: 'CLIENT' | 'ARTIST' | null;
  checkIn: {
    redeemedAt: string;
    hasLocation: boolean;
    latitude: string | null;
    longitude: string | null;
    accuracyMeters: string | null;
  } | null;
  booking: {
    id: string;
    amountKobo: number;
    commissionRateBpsSnapshot: number;
    eventDate: string;
    eventEndAt: string;
    state: string;
    artist: string;
    client: string;
    clientConfirmedAt: string | null;
    artistConfirmedAt: string | null;
    clientNoShowClaimedAt: string | null;
    clientNoShowReason: string | null;
  };
  evidence: {
    id: string;
    party: 'CLIENT' | 'ARTIST' | null;
    statement: string | null;
    fileUrl: string | null;
    createdAt: string;
  }[];
  resolvedAt: string | null;
  resolutionReason: string | null;
  splitClientKobo: number | null;
  splitArtistKobo: number | null;
  externalMediatorOpinion: string | null;
};

/**
 * What the check-in says, in one line.
 *
 * THE COMMON DISPUTE IS "DID THE EVENT HAPPEN", and this reduces it to a
 * timestamped fact. Returned as a sentence rather than a data blob because an
 * admin reading a queue at speed needs a claim, not a record to interpret.
 */
export function checkInVerdict(dispute: DisputeDetail): string {
  if (!dispute.checkIn) {
    return 'No check-in was recorded. Nobody has evidence the artist was at the event.';
  }

  const when = new Date(dispute.checkIn.redeemedAt).toLocaleString('en-NG', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const base = `The artist redeemed the client's code at ${when}, which the client handed over in person.`;

  return dispute.checkIn.hasLocation
    ? `${base} A location was captured, as supporting detail only.`
    : base;
}

/**
 * Whether the check-in contradicts the client's own claim.
 *
 * This is the case the code exists to catch, and calling it out is worth more
 * than any amount of evidence: one of the two parties is not telling the truth,
 * and the record says which.
 */
export function contradictsNoShowClaim(dispute: DisputeDetail): boolean {
  return Boolean(dispute.checkIn && dispute.booking.clientNoShowClaimedAt);
}

/**
 * The two halves of a split, previewed before it is issued.
 *
 * THE ARTIST'S SHARE IS THE RESIDUAL, exactly as the backend computes it, so
 * the figures an admin is shown are the figures that execute. A second
 * calculation here that rounded differently would show one number and move
 * another.
 */
export function previewSplit(
  amountKobo: number,
  clientKobo: number,
  commissionBps: number
): { clientKobo: number; artistKobo: number; commissionKobo: number; artistNetKobo: number } {
  const artistKobo = amountKobo - clientKobo;
  // Floor, like `applyBps` — percentages always round down (docs/05 §4 R1).
  const commissionKobo = Math.floor((artistKobo * commissionBps) / 10000);

  return { clientKobo, artistKobo, commissionKobo, artistNetKobo: artistKobo - commissionKobo };
}

/** Why a split cannot be issued as entered, or null. */
export function splitProblem(amountKobo: number, clientKobo: unknown): string | null {
  if (clientKobo === '' || clientKobo === null || clientKobo === undefined) {
    return 'Enter how much of the booking the client should receive.';
  }

  const value = Number(clientKobo);
  if (!Number.isInteger(value)) return 'Enter a whole number of kobo.';
  if (value < 0) return 'The client’s share cannot be negative.';
  if (value > amountKobo) {
    return `The client’s share cannot exceed the booking total of ${formatNaira(amountKobo)}.`;
  }
  return null;
}

/** What each verdict does, said plainly, before it is issued. */
export function outcomeDescription(outcome: DisputeOutcome, dispute: DisputeDetail): string {
  const amount = formatNaira(dispute.booking.amountKobo);

  switch (outcome) {
    case 'RELEASE':
      return `Pays the artist for the booking in full. The client receives nothing back from the ${amount} held.`;
    case 'REFUND':
      return `Returns everything to the client, including the fee they paid when funding. The artist is paid nothing and owes the bank charges, taken from their next payout.`;
    case 'SPLIT':
      return `Divides the ${amount} between them. Commission applies to the artist's share afterwards.`;
  }
}

/** Whether this verdict records a finding against one of the parties. */
export function strikesSomeone(outcome: DisputeOutcome): boolean {
  // A split is not a finding against either party, so nobody is struck.
  return outcome !== 'SPLIT';
}

/** The queue, ordered the way an admin should work through it. */
export function triage(entries: QueueEntry[]): QueueEntry[] {
  // Oldest first: money held from two people who both believe it is theirs, and
  // how long that has been true is the thing to act on. Ties broken by value,
  // because the larger sum is the one costing more to sit on.
  return [...entries].sort(
    (a, b) => b.ageDays - a.ageDays || b.amountKobo - a.amountKobo
  );
}
