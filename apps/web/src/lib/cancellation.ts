/**
 * Cancellation copy and consequences — issue #30.
 *
 * THE DISCLOSURE REQUIREMENT LIVES HERE. `docs/00` §10 exists because a Lagos
 * venue's 15% cancellation deduction, discovered after the fact, became a public
 * dispute. The figure is not the problem; finding out afterwards is. So the
 * exact numbers are turned into sentences a person can act on, and nothing in
 * this module hides a zero.
 *
 * Pure and DOM-free on purpose: every acceptance criterion in #30 is about what
 * a person is told, and none of them needs a browser to check.
 */

// The explicit extension is required: this module is exercised by node:test,
// whose ESM loader does not guess one. Next resolves it the same way.
import { formatNaira } from './currency.ts';

/** One party's outcome, as the backend computes it. All figures are kobo. */
export type CancellationPreview = {
  bookingId: string;
  state: string;
  cancellable: boolean;
  daysBeforeEvent: number;
  amountKobo: number;
  appliedTier: {
    minDaysBefore: number;
    maxDaysBefore: number | null;
    clientRefundBps: number;
    artistCompensationBps: number;
  } | null;

  // If the client cancels.
  clientRefundKobo: number;
  artistCompensationKobo: number;
  commissionKobo: number;
  clientSunkFeeKobo: number;
  moneyOutFeeKobo: number;
  unrecoveredShortfallKobo: number;

  // If the artist cancels.
  ifArtistCancels: {
    clientRefundKobo: number;
    clientFeeReimbursementKobo: number;
    clientTotalReturnedKobo: number;
    artistCompensationKobo: number;
    feeLiabilityKobo: number;
    consequence: {
      trigger: string | null;
      weight: number;
      summary: string;
      suspends: boolean;
      publishesRate: boolean;
    };
  };
};

export type Party = 'CLIENT' | 'ARTIST';

/** A line of the figures table, already formatted for display. */
export type Figure = { label: string; value: string; emphasis?: boolean; note?: string };

/**
 * What the client gets back, as a sentence.
 *
 * A ₦0 OUTCOME IS STATED, NEVER IMPLIED. An empty field or a bare "₦0" reads as
 * a rendering fault, and a reader who thinks the page is broken has not been
 * told anything — which is the same position as not showing it at all.
 */
export function refundSentence(preview: CancellationPreview): string {
  const refund = preview.clientRefundKobo;

  if (refund <= 0) {
    return (
      'You will not receive a refund for this booking. ' +
      `Cancelling ${describeTiming(preview.daysBeforeEvent)} means the full amount goes to the artist, ` +
      'because they can no longer fill the date.'
    );
  }

  return (
    `You will receive ${formatNaira(refund)} back, ` +
    `out of the ${formatNaira(preview.amountKobo)} you paid.`
  );
}

/**
 * The fee the client already paid and will not get back.
 *
 * Named separately because it is the figure most likely to feel like a hidden
 * deduction: it was paid at funding, on top of the booking amount, and it is
 * consumed whether or not the event happens.
 */
export function sunkFeeSentence(preview: CancellationPreview): string | null {
  if (preview.clientSunkFeeKobo <= 0) return null;

  return (
    `The ${formatNaira(preview.clientSunkFeeKobo)} payment fee you paid when funding this booking ` +
    'is not refundable. It was charged by the bank at the time, not by us.'
  );
}

/** The client's figures, in the order they should be read. */
export function clientFigures(preview: CancellationPreview): Figure[] {
  const figures: Figure[] = [
    { label: 'You paid', value: formatNaira(preview.amountKobo) },
    {
      label: 'You get back',
      value: formatNaira(preview.clientRefundKobo),
      emphasis: true,
    },
  ];

  if (preview.artistCompensationKobo > 0) {
    figures.push({
      label: 'Goes to the artist',
      value: formatNaira(preview.artistCompensationKobo),
      note: 'They have held this date and can no longer fill it.',
    });
  }

  if (preview.clientSunkFeeKobo > 0) {
    figures.push({
      label: 'Payment fee already paid',
      value: formatNaira(preview.clientSunkFeeKobo),
      note: 'Charged at funding. Not refundable.',
    });
  }

  return figures;
}

/**
 * The artist's figures.
 *
 * Both consequences, because both are things they should weigh before deciding
 * rather than discover on their next payout.
 */
export function artistFigures(preview: CancellationPreview): Figure[] {
  const outcome = preview.ifArtistCancels;

  return [
    {
      label: 'The client gets back',
      value: formatNaira(outcome.clientTotalReturnedKobo),
      note: 'Everything they paid, including the payment fee.',
    },
    { label: 'You receive', value: formatNaira(outcome.artistCompensationKobo) },
    {
      label: 'You will owe',
      value: formatNaira(outcome.feeLiabilityKobo),
      emphasis: true,
      note: 'Taken from your next payout. Not billed separately.',
    },
  ];
}

/**
 * What cancelling costs the artist's standing.
 *
 * Returned even when it is nothing, so the caller renders a sentence rather
 * than deciding whether to show anything — an absent consequence and an
 * unmentioned one look identical to a reader.
 */
export function artistConsequenceSentence(preview: CancellationPreview): string {
  return preview.ifArtistCancels.consequence.summary;
}

/** Whether the artist's consequence is severe enough to want extra friction. */
export function isSevereForArtist(preview: CancellationPreview): boolean {
  return preview.ifArtistCancels.consequence.suspends;
}

/** The figures for whoever is looking. */
export function figuresFor(preview: CancellationPreview, party: Party): Figure[] {
  return party === 'ARTIST' ? artistFigures(preview) : clientFigures(preview);
}

/**
 * The headline, phrased for the party reading it.
 *
 * Never "are you sure?" alone. The question a person needs answered at this
 * moment is what it will cost, and a confirmation that does not say is asking
 * them to agree to something unstated.
 */
export function headlineFor(preview: CancellationPreview, party: Party): string {
  if (party === 'ARTIST') {
    return `Cancel this booking ${describeTiming(preview.daysBeforeEvent)}?`;
  }
  return `Cancel this booking ${describeTiming(preview.daysBeforeEvent)}?`;
}

/** "today", "tomorrow", "in 5 days" — how a person says it. */
export function describeTiming(daysBeforeEvent: number): string {
  if (daysBeforeEvent <= 0) return 'on the day of the event';
  if (daysBeforeEvent === 1) return 'the day before the event';
  return `${daysBeforeEvent} days before the event`;
}

/**
 * Whether the confirm action may be offered at all.
 *
 * STRUCTURAL, NOT COSMETIC. #30's first criterion is that no cancellation can
 * complete without the exact figures having been displayed, and the way to
 * guarantee that is for the confirm step to be unreachable without a preview
 * in hand — not to remember to check.
 */
export function canConfirm(preview: CancellationPreview | null): preview is CancellationPreview {
  return Boolean(preview && preview.cancellable);
}

/**
 * Why cancelling is not available, when it is not.
 *
 * A disabled button with no explanation is a dead end. Every branch here names
 * something the reader can do or understand instead.
 */
export function unavailableReason(preview: CancellationPreview | null): string | null {
  if (!preview) return null;
  if (preview.cancellable) return null;

  if (preview.daysBeforeEvent < 0) {
    return 'This event has already taken place, so it can no longer be cancelled.';
  }

  switch (preview.state) {
    case 'CHECKED_IN':
      return 'The artist has already checked in at the event, so this booking can no longer be cancelled.';
    case 'AWAITING_CONFIRMATION':
      return 'This booking is waiting to be confirmed. Confirm it, or report a no-show if the artist did not perform.';
    case 'RELEASED':
      return 'This booking has already been paid out.';
    case 'REFUNDED':
      return 'This booking has already been refunded.';
    case 'CANCELLED':
      return 'This booking was already cancelled.';
    case 'DISPUTED':
      return 'This booking is under dispute. Support will decide it.';
    case 'RESOLVED':
      return 'This booking was settled by support and is closed.';
    default:
      return 'This booking cannot be cancelled right now.';
  }
}
