/**
 * Making the ledger legible — issue #37, docs/07 §7.
 *
 * A list of raw entries is not an answer. When a client asks why they received
 * ₦137,860 instead of ₦140,000, the answer is a sequence of amounts with
 * reasons attached, summing to a net position — and the arithmetic has to be the
 * backend's, not a second implementation living here.
 *
 * So nothing in this file adds money up. `sumKobo` and `netByParty` arrive
 * computed from `ledgerService.reconcile`; this module decides how to ORDER and
 * LABEL them. A screen that recomputes the totals is a screen that can disagree
 * with the ledger, and the one people read is the one that is wrong.
 */

export type LedgerParty = 'CLIENT' | 'ARTIST' | 'PLATFORM' | 'PROVIDER';

export type LedgerEntry = {
  id: string;
  entryType: string;
  party: LedgerParty;
  amountKobo: number;
  description: string | null;
  offsetsEntryId: string | null;
  createdAt: string;
};

export type Reconciliation = {
  entries: LedgerEntry[];
  netByParty: Record<LedgerParty, number>;
  sumKobo: number;
  balanced: boolean;
  entryCount: number;
};

/**
 * Who each party is, said as a person would say it.
 *
 * `PROVIDER` is the one worth spelling out: it is not a counterparty we chose to
 * pay, it is the bank's fee, and labelling it "Provider" leaves the reader to
 * work that out.
 */
const PARTY_LABELS: Record<LedgerParty, string> = {
  CLIENT: 'Client',
  ARTIST: 'Artist',
  PLATFORM: 'Platform',
  PROVIDER: 'Bank fees',
};

export function partyLabel(party: string): string {
  return PARTY_LABELS[party as LedgerParty] ?? 'Other';
}

/**
 * What each entry type means.
 *
 * The raw name must never reach the screen. `COMMISSION` is close enough to
 * English to tempt you into rendering it directly, and then `FEE_LIABILITY_
 * SETTLEMENT` arrives and the reader is looking at a database constant.
 */
const TYPE_LABELS: Record<string, string> = {
  FUNDING: 'Client payment received',
  ESCROW_FEE: 'Bank fee on the payment in',
  RELEASE: 'Paid to artist',
  COMMISSION: 'Platform commission',
  PAYOUT_FEE: 'Bank fee on the payout',
  REFUND: 'Refunded to client',
  ARTIST_COMPENSATION: 'Compensation to artist',
  CANCELLATION_FEE: 'Cancellation charge',
  CORRECTION: 'Correction',
  FEE_LIABILITY_SETTLEMENT: 'Outstanding fee recovered',
  DISPUTE_SPLIT: 'Split by dispute decision',
};

export function entryTypeLabel(entryType: string): string {
  return (
    TYPE_LABELS[entryType] ??
    // Never the bare constant. An unrecognised type is a gap in this map, and
    // showing `SOME_NEW_TYPE` tells the reader nothing while looking like a bug
    // in their booking rather than in our labels.
    entryType
      .toLowerCase()
      .split('_')
      .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
      .join(' ')
  );
}

/**
 * One line, ready to render.
 *
 * `direction` exists because a signed integer is not a readable amount: -200000
 * against the client is money they parted with, and the screen says so in words
 * rather than leaving a minus sign to carry the meaning.
 */
export type LedgerLine = {
  entry: LedgerEntry;
  label: string;
  party: string;
  direction: 'in' | 'out';
  /** True where another entry offsets this one — shown as struck through. */
  reversed: boolean;
  /** True where this entry is itself the offset. */
  isCorrection: boolean;
  /** The entry this one offsets, where that entry is in view. */
  offsets: LedgerEntry | null;
};

/**
 * Orders the entries for reading, and pairs each correction with its original.
 *
 * Chronological, because the sequence IS the explanation — "charged, then
 * reversed, and why" (docs/01 §5). Grouping by party would hide that; grouping
 * corrections next to their originals and dropping the chronology would hide
 * when the reversal happened, which is the part a questioned decision turns on.
 */
export function ledgerLines(entries: LedgerEntry[]): LedgerLine[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const reversedIds = new Set(
    entries.map((e) => e.offsetsEntryId).filter((id): id is string => id !== null)
  );

  return [...entries]
    .sort((a, b) => {
      const at = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      // Entries written inside one transaction share a timestamp to the
      // millisecond. Falling back to id keeps the order stable rather than
      // letting it shuffle between renders of the same booking.
      return at !== 0 ? at : a.id.localeCompare(b.id);
    })
    .map((entry) => ({
      entry,
      label: entryTypeLabel(entry.entryType),
      party: partyLabel(entry.party),
      direction: entry.amountKobo >= 0 ? ('in' as const) : ('out' as const),
      reversed: reversedIds.has(entry.id),
      isCorrection: entry.offsetsEntryId !== null,
      offsets: entry.offsetsEntryId ? byId.get(entry.offsetsEntryId) ?? null : null,
    }));
}

/**
 * The net position per party, in a fixed order, as the backend computed it.
 *
 * Fixed order rather than object key order: the client is the question's
 * subject, the artist is who got paid, and the two fee lines explain the gap.
 * Reading it in that sequence is what answers "where did the rest go".
 */
export function netPositions(
  netByParty: Record<string, number>
): { party: string; label: string; amountKobo: number }[] {
  return (['CLIENT', 'ARTIST', 'PLATFORM', 'PROVIDER'] as LedgerParty[]).map((party) => ({
    party,
    label: partyLabel(party),
    amountKobo: netByParty?.[party] ?? 0,
  }));
}

/**
 * Whether to warn that the booking does not reconcile.
 *
 * A booking still in flight legitimately does not sum to zero — money is held
 * and nothing has been paid out. Only a CONCLUDED booking failing to balance is
 * a problem, and conflating the two would put a red banner on every healthy
 * booking until it settled, which is how a real warning gets ignored.
 */
const CONCLUDED = new Set(['RELEASED', 'REFUNDED', 'CANCELLED', 'RESOLVED']);

export function reconciliationProblem(
  state: string,
  reconciliation: Pick<Reconciliation, 'balanced' | 'sumKobo' | 'entryCount'>
): string | null {
  if (!CONCLUDED.has(state)) return null;
  if (reconciliation.entryCount === 0) {
    return 'This booking has concluded with no ledger entries at all. That should not be possible.';
  }
  if (reconciliation.balanced) return null;

  return 'The entries for this booking do not sum to zero. Do not act on these figures — raise it before moving any money.';
}

/** Whether the money has actually reached the artist, which the state does not say. */
export function payoutProblem(state: string, paidOutAt: string | null): string | null {
  if (state !== 'RELEASED' || paidOutAt) return null;
  // RELEASED means the funds left escrow into our wallet, not that the artist
  // has them. Money sitting with us that is not ours (#26).
  return 'Released but not yet paid out — this money is in our wallet and belongs to the artist.';
}
