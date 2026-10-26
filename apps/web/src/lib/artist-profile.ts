/**
 * Whether an artist can be found and booked yet, and why not — issue #44.
 *
 * Mirrors the backend's `listabilityFilter`: a complete profile, a verified
 * identity, and an account in good standing. The backend decides; this exists
 * so the page can say WHICH of those is missing, because "you are not visible
 * yet" with no reason is the message that makes someone give up.
 */

/** Mirrors REQUIRED_FOR_COMPLETE in services/artistService.ts. */
export const REQUIRED_FOR_LISTING = ['stageName', 'category', 'location', 'baseRateKobo'] as const;

const FIELD_LABEL: Record<(typeof REQUIRED_FOR_LISTING)[number], string> = {
  stageName: 'a stage name',
  category: 'what you perform',
  location: 'where you are based',
  baseRateKobo: 'your rate',
};

export type ListingFacts = {
  stageName?: string | null;
  category?: string | null;
  location?: string | null;
  baseRateKobo?: number | null;
  verificationStatus?: string | null;
  accountStanding?: string | null;
  payoutRegistered?: boolean;
};

export function listingStatus(facts: ListingFacts): { listable: boolean; missing: string[]; warnings: string[] } {
  const missing: string[] = [];

  const absentFields = REQUIRED_FOR_LISTING.filter((f) => {
    const v = facts[f];
    return v === null || v === undefined || String(v).trim() === '';
  });
  if (absentFields.length > 0) {
    missing.push(`Add ${absentFields.map((f) => FIELD_LABEL[f]).join(', ')}.`);
  }

  if (facts.verificationStatus !== 'VERIFIED') missing.push('Verify your identity.');

  if (facts.accountStanding === 'SUSPENDED' || facts.accountStanding === 'REMOVED') {
    missing.push('Your account is under review, so clients cannot find you. Contact support.');
  }

  const warnings: string[] = [];
  if (!facts.payoutRegistered) {
    // Not a listing requirement — the backend lists an artist without one — but
    // the one gap that bites AFTER the event: the client has paid, the artist
    // has performed, and the payout has nowhere to go.
    warnings.push('Add your bank account. You can be booked without one, but you cannot be paid until it is on file.');
  }

  return { listable: missing.length === 0, missing, warnings };
}

/** Suggestions only — any category can be typed. */
export const CATEGORY_SUGGESTIONS = [
  'Afrobeats', 'Amapiano', 'DJ', 'Fuji', 'Gospel', 'Highlife', 'Hip-hop', 'Jùjú',
  'Live band', 'MC / Host', 'Comedy', 'Saxophonist', 'Spoken word',
];
