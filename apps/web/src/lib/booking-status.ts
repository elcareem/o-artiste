/**
 * Booking status — issue #21.
 *
 * The decisions the status page makes, kept out of the component so they can be
 * tested directly: which states are terminal, how long to wait between polls,
 * and what a state means to the person reading it.
 *
 * Money here is integer kobo, as everywhere. `formatNaira()` converts, at
 * render, and only there.
 */

/** The nine booking states — docs/01-DATA-MODEL.md §4. */
export type BookingState =
  | 'PENDING_PAYMENT'
  | 'FUNDED_HELD'
  | 'CHECKED_IN'
  | 'AWAITING_CONFIRMATION'
  | 'DISPUTED'
  | 'RELEASED'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'RESOLVED';

/**
 * States from which a booking cannot move — docs/01 §4.
 *
 * Kept in step with the backend's own map by a test that drives every state
 * through it, because a state missing here is a page that polls a finished
 * booking forever.
 */
const TERMINAL: ReadonlySet<BookingState> = new Set<BookingState>([
  'RELEASED',
  'REFUNDED',
  'CANCELLED',
  'RESOLVED',
]);

/**
 * Whether polling should stop.
 *
 * An unknown state counts as NOT terminal. A backend that adds a state should
 * leave this page still updating rather than silently frozen on stale
 * information — the failure of polling too long is a wasted request, and the
 * failure of stopping too early is a client staring at the wrong answer.
 */
export function isTerminal(state: string): boolean {
  return TERMINAL.has(state as BookingState);
}

/** How long the page waits before asking again. */
export const POLL_INTERVAL_MS = 5000;

/**
 * Backoff after a failed poll.
 *
 * A backend that is down does not recover faster for being asked every five
 * seconds, and a page left open on a phone would keep asking for hours. The
 * interval doubles per consecutive failure up to a minute, and resets on the
 * first success.
 */
export const MAX_POLL_INTERVAL_MS = 60_000;

export function pollDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return POLL_INTERVAL_MS;
  return Math.min(POLL_INTERVAL_MS * 2 ** consecutiveFailures, MAX_POLL_INTERVAL_MS);
}

export type StatusTone = 'waiting' | 'holding' | 'settled' | 'attention';

export type StatusCopy = {
  /** Short label for the status chip. */
  label: string;
  /** A sentence saying what is true now. */
  headline: string;
  /** What happens next, or what the reader should do. */
  detail: string;
  tone: StatusTone;
};

/**
 * What each state means, written for the client.
 *
 * Deliberately in the client's terms and not the system's: "escrow", "webhook"
 * and "state machine" appear nowhere. Someone who has just transferred ₦202,000
 * wants to know whether their money is safe and what happens next.
 */
const COPY: Record<BookingState, StatusCopy> = {
  PENDING_PAYMENT: {
    label: 'Awaiting payment',
    headline: 'Waiting for your transfer',
    detail:
      'Transfer the exact amount to the account below. This page updates on its own once the money arrives — usually within a few minutes. You do not need to refresh it.',
    tone: 'waiting',
  },
  FUNDED_HELD: {
    label: 'Payment held',
    headline: 'Your payment is being held safely',
    detail:
      'The money is held by a licensed bank, not by us and not by the artist. It is released only after the event, once both of you confirm it went ahead.',
    tone: 'holding',
  },
  CHECKED_IN: {
    label: 'Artist checked in',
    headline: 'The artist has checked in at your event',
    detail: 'Confirm the performance went ahead once it is finished, and the payment will be released.',
    tone: 'holding',
  },
  AWAITING_CONFIRMATION: {
    label: 'Awaiting confirmation',
    headline: 'Confirm how the event went',
    detail:
      'Your payment is still held. Confirm the performance went ahead to release it, or raise a problem if it did not.',
    tone: 'attention',
  },
  DISPUTED: {
    label: 'Under review',
    headline: 'This booking is under review',
    detail:
      'Your payment stays held while we look into it. We will contact you — you do not need to do anything right now.',
    tone: 'attention',
  },
  RELEASED: {
    label: 'Completed',
    headline: 'Payment released to the artist',
    detail: 'This booking is complete. Thank you.',
    tone: 'settled',
  },
  REFUNDED: {
    label: 'Refunded',
    headline: 'Your refund is on its way',
    detail: 'The refund has been issued to the account you paid from. Bank transfers can take a little time to land.',
    tone: 'settled',
  },
  CANCELLED: {
    label: 'Cancelled',
    headline: 'This booking was cancelled',
    detail: 'No further action is needed.',
    tone: 'settled',
  },
  RESOLVED: {
    label: 'Resolved',
    headline: 'The review is finished',
    detail: 'This booking has been resolved and closed.',
    tone: 'settled',
  },
};

/**
 * Copy for a state.
 *
 * An unrecognised state gets a truthful placeholder rather than a crash or a
 * raw enum name. A client should never be shown `AWAITING_CONFIRMATION_V2`.
 */
export function statusCopy(state: string): StatusCopy {
  return (
    COPY[state as BookingState] ?? {
      label: 'In progress',
      headline: 'This booking is in progress',
      detail: 'Your payment is held safely. Check back shortly.',
      tone: 'holding',
    }
  );
}

export type BankTransfer = {
  accountNumber: string;
  accountName: string;
  bankCode: string | null;
  provider: string | null;
  expiresAt: string | null;
};

export type FundingInstruction = {
  bookingId: string;
  escrowReference: string;
  escrowId: string | null;
  state: string;
  escrowState: string | null;
  bookingAmountKobo: number;
  providerFeeKobo: number;
  amountToTransferKobo: number;
  channels: string[];
  bankTransfer: BankTransfer | null;
};

export type Booking = {
  id: string;
  state: string;
  amountKobo: number;
  eventDate: string;
  eventLocation: string | null;
  escrowReference: string;
};

/**
 * Whether a funding instruction can actually be paid.
 *
 * A masked account number is not payable, and the provider returns one from the
 * payment-accounts endpoint (`****4680`). #18 established that only the checkout
 * session carries the full number; this is the last guard before a client is
 * asked to type it into their banking app.
 */
export function isPayable(bank: BankTransfer | null | undefined): bank is BankTransfer {
  if (!bank) return false;
  const digits = bank.accountNumber ?? '';
  return digits.length > 0 && !digits.includes('*') && /^\d+$/.test(digits);
}
