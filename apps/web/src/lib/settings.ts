/**
 * Settings validation and preview — issue #36.
 *
 * CLIENT-SIDE VALIDATION MIRRORS THE SERVER'S RULES; THE SERVER REMAINS
 * AUTHORITATIVE. This exists so a super-admin is told about a gap in a tier
 * table while they are typing rather than after submitting — not so the server
 * can trust it. A tier set with a hole must be unsaveable whichever path the
 * request arrives by, and #8's validator is what guarantees that.
 */

import { formatNaira } from './currency.ts';

export type Tier = {
  minDaysBefore: number;
  maxDaysBefore: number | null;
  clientRefundBps: number;
  artistCompensationBps: number;
};

export type Settings = {
  commission: { rateBasisPoints: number; editable: boolean };
  cancellationTiers: { versionId: string | null; tiers: Tier[]; editable: boolean };
  autoRelease: { graceHours: number; source: string; editable: boolean };
  strikes: { isDefault: boolean; rules: unknown[]; editable: boolean };
  enforcement: { isDefault: boolean; rules: unknown[]; editable: boolean };
  reputation: { windowMonths: number; minBookings: number; isDefault: boolean; editable: boolean };
};

/**
 * Every reason a tier set cannot be saved, in the order a person would find
 * them.
 *
 * Mirrors #8's validator. The messages NAME the offending bands rather than
 * saying "invalid", because a gap between 3 and 5 days is found by reading the
 * table and the reader should not have to.
 */
export function tierProblems(tiers: Tier[]): string[] {
  const problems: string[] = [];

  if (tiers.length === 0) return ['Add at least one cancellation band.'];

  for (const tier of tiers) {
    if (!Number.isInteger(tier.minDaysBefore) || tier.minDaysBefore < 0) {
      problems.push('Every band must start at a whole number of days, zero or more.');
      break;
    }
  }

  for (const tier of tiers) {
    const total = tier.clientRefundBps + tier.artistCompensationBps;
    if (total !== 10000) {
      problems.push(
        `The band from ${tier.minDaysBefore} days splits ${bps(tier.clientRefundBps)} / ` +
          `${bps(tier.artistCompensationBps)}, which is ${bps(total)} rather than 100%.`
      );
    }
  }

  const sorted = [...tiers].sort((a, b) => a.minDaysBefore - b.minDaysBefore);

  // Day 0 must be covered: a booking cancelled on the day has to have a rule.
  if (sorted[0].minDaysBefore !== 0) {
    problems.push(
      `Nothing covers the day of the event. The lowest band starts at ${sorted[0].minDaysBefore} days.`
    );
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const lower = sorted[i];
    const upper = sorted[i + 1];

    if (lower.maxDaysBefore === null) {
      problems.push(`The band from ${lower.minDaysBefore} days is open-ended but is not the last one.`);
      continue;
    }

    if (lower.maxDaysBefore >= upper.minDaysBefore) {
      problems.push(
        `The bands ${lower.minDaysBefore}–${lower.maxDaysBefore} and ` +
          `${upper.minDaysBefore}–${upper.maxDaysBefore ?? '∞'} overlap.`
      );
    } else if (lower.maxDaysBefore + 1 !== upper.minDaysBefore) {
      // A gap means a booking cancelled in that window has NO applicable rule,
      // and there is no safe default: refunding everything harms the artist,
      // refunding nothing is FCCPA exposure (docs/05 §5).
      problems.push(
        `Nothing covers ${lower.maxDaysBefore + 1}` +
          `${upper.minDaysBefore - lower.maxDaysBefore > 2 ? `–${upper.minDaysBefore - 1}` : ''} ` +
          'days before the event.'
      );
    }
  }

  if (sorted[sorted.length - 1].maxDaysBefore !== null) {
    problems.push('The highest band must be open-ended, so every future date is covered.');
  }

  return problems;
}

function bps(value: number): string {
  return `${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}%`;
}

/**
 * How a sample booking would be affected — the preview #36 asks for.
 *
 * A basis-point change is hard to reason about in the abstract and easy to
 * reason about as "this ₦200,000 booking would pay ₦188,000 instead of
 * ₦190,000" (docs/07 §6).
 */
export function commissionPreview(
  amountKobo: number,
  currentBps: number,
  proposedBps: number
): { current: string; proposed: string; difference: string; worse: boolean } {
  // Floors, matching applyBps — a preview that rounds differently from the
  // thing it previews is worse than none.
  const net = (b: number) => amountKobo - Math.floor((amountKobo * b) / 10000);

  const current = net(currentBps);
  const proposed = net(proposedBps);

  return {
    current: formatNaira(current),
    proposed: formatNaira(proposed),
    difference: formatNaira(Math.abs(proposed - current)),
    worse: proposed < current,
  };
}

/** Whether this viewer may change a given section. */
export function canEdit(settings: Settings, section: keyof Settings): boolean {
  return Boolean((settings[section] as { editable?: boolean })?.editable);
}
