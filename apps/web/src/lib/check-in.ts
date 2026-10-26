/**
 * When an artist can check in, and what to say when they cannot — issue #39.
 *
 * The backend decides this: `redeem()` refuses unless the booking can transition
 * to `CHECKED_IN`, which only `FUNDED_HELD` can. This module exists so the artist
 * is told BEFORE typing an eight-character code at a venue door, which is the whole
 * point of #39 — being refused after the effort is the thing that feels broken.
 *
 * It is a mirror, not an authority. If the backend's transition map changes, the
 * test below fails rather than this quietly diverging.
 */

/** The only state a code can be redeemed from. Mirrors ALLOWED_TRANSITIONS. */
const REDEEMABLE = new Set(['FUNDED_HELD']);

export function canCheckIn(state: string): boolean {
  return REDEEMABLE.has(state);
}

/**
 * Why not, per state.
 *
 * Each one names a NEXT ACTION where there is one. "You cannot check in" leaves
 * an artist standing at a venue with no idea what to do; "ask the client to
 * complete payment" is something they can act on in the next minute.
 */
const WHY_NOT: Record<string, string> = {
  PENDING_PAYMENT:
    'This booking has not been paid for yet, so there is no code to check in with. Ask the client to complete their transfer — it usually clears in a few minutes.',
  CHECKED_IN:
    'You have already checked in for this booking. Nothing more is needed from you here.',
  AWAITING_CONFIRMATION:
    'The event window has closed and this booking is waiting to be confirmed. Confirm how it went instead.',
  DISPUTED:
    'This booking is under dispute, so the funds are held while it is settled. Checking in is not possible until then. Add anything that explains what happened.',
  RELEASED: 'This booking has been paid out already.',
  REFUNDED: 'This booking was refunded, so there is nothing to check in to.',
  CANCELLED: 'This booking was cancelled.',
  RESOLVED: 'This booking was settled by support.',
};

export function whyNotYet(state: string): string {
  return (
    WHY_NOT[state] ??
    // Never the bare state name. An artist should not be shown
    // `AWAITING_CONFIRMATION_V2` because we added a state and forgot a sentence.
    'Checking in is not available for this booking right now.'
  );
}

/**
 * The code's length, matching the backend's `CODE_LENGTH`.
 *
 * Eight characters, shown to the client as two groups of four — `ABCD-EFGH`.
 * This was 6 when #39 shipped, and the form told artists "the code is 6
 * characters" while rejecting every correct code before it reached the server:
 * the web check-in could not succeed at all. The e2e run redeemed codes through
 * the API, which is why it did not notice. A test now reads `CODE_LENGTH` from
 * the backend's source so the two cannot drift apart again.
 */
export const CODE_LENGTH = 8;

/**
 * The code as the backend will read it: upper-cased, with every separator gone.
 * Mirrors `normaliseCode` — the client is shown `ABCD-EFGH`, and an artist may
 * type it with the hyphen, with a space, or without either.
 */
export function normaliseCode(raw: string): string {
  return String(raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Whether a code is worth submitting.
 *
 * Length only, AFTER normalising. The backend's alphabet leaves out the
 * characters people confuse; a client-side character check that guessed at it
 * would reject a valid code typed correctly, which is worse than a round trip.
 */
export function codeProblem(raw: string): string | null {
  const code = normaliseCode(raw);
  if (code.length === 0) return 'The check-in code is needed.';
  if (code.length !== CODE_LENGTH) {
    return `The code is ${CODE_LENGTH} characters — two groups of four, like ABCD-EFGH. Check it with the client.`;
  }
  return null;
}
