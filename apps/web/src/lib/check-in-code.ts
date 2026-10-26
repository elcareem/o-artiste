/**
 * The client's check-in code, on their booking — issue #48.
 *
 * The code was delivered by SMS only, and with no SMS provider configured no
 * client ever received it: no artist could check in, and nothing released on
 * silence. It now shows on the booking page as well.
 *
 * It is the CLIENT's to see and nobody else's. The backend refuses anyone else;
 * this decides when the page asks at all.
 */

export type CodeView = {
  code: string;
  qrDataUrl: string | null;
  validFrom: string | null;
  validTo: string | null;
  valid: boolean;
  reason: 'already_redeemed' | 'too_early' | 'expired' | null;
  message: string | null;
};

/** From funding until it has been used — the only window it means anything. */
export function shouldFetchCode(state: string, party: 'CLIENT' | 'ARTIST'): boolean {
  return party === 'CLIENT' && (state === 'FUNDED_HELD' || state === 'CHECKED_IN');
}

/** What the client is told alongside the code. */
export function codeGuidance(view: Pick<CodeView, 'reason'>, artistName: string): { headline: string; detail: string } {
  if (view.reason === 'already_redeemed') {
    return {
      headline: 'Used — the artist has checked in',
      detail: `${artistName} gave us this code on arrival. Nothing more is needed from you until the event ends.`,
    };
  }
  if (view.reason === 'expired') {
    return {
      headline: 'This code has expired',
      detail: 'The window for checking in has passed. If the artist did not come, tell us from this page once the event has ended.',
    };
  }
  return {
    headline: 'Your check-in code',
    // The whole mechanism rests on the artist being unable to get this except
    // from the client's hand, at the venue (docs/04 §1).
    detail: `Give this to ${artistName} when they arrive — not before. It is how we know they turned up, and it is what releases their payment.`,
  };
}
