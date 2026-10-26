/**
 * Are our fee constants still the provider's prices?
 *
 * WHY THIS EXISTS. EscrowPay changed two prices in October 2026 without notice —
 * the money-in fee above ₦250,000 gained a ₦100 fixed part, and the identity
 * check went from ₦50 to ₦70 — and nothing here noticed for two weeks. In that
 * time every large booking's ledger under-recorded the client's fee.
 *
 * Our arithmetic stays in feeService, as constants: fees are snapshot-able,
 * testable and reviewable that way, and a provider outage cannot change what a
 * booking costs mid-flight. What changes is that the constants are now CHECKED
 * against `GET /fees/configuration`, and a difference fails
 * `GET /admin/diagnostics` with a 503 that a monitor can alert on.
 */

const fee = require('./feeService.ts');
const escrowpay = require('../lib/escrowpay.ts');

type Tier = {
  up_to_minor: number | null;
  calculation_type: string;
  fixed_minor?: number | null;
  percentage_basis_points?: number | null;
  maximum_minor?: number | null;
};

type ProviderFee = {
  fee_type: string;
  payer: string;
  timing: string;
  calculation_type: string;
  fixed_minor?: number | null;
  percentage_basis_points?: number | null;
  tiers?: Tier[] | null;
  effective_from?: string;
  version?: number;
};

/** What our code assumes, written in the provider's own terms so it compares directly. */
function expectedSchedule() {
  const { VERIFICATION_COST_KOBO } = require('./verificationService.ts');
  return {
    escrow_service: {
      payer: 'payer',
      timing: 'at_funding',
      tiers: [
        {
          up_to_minor: fee.MONEY_IN_THRESHOLD_KOBO,
          calculation_type: 'fixed_plus_percentage',
          fixed_minor: fee.MONEY_IN_FLAT_KOBO,
          percentage_basis_points: fee.MONEY_IN_LOW_BPS,
          maximum_minor: fee.MONEY_IN_CAP_KOBO,
        },
        {
          up_to_minor: null,
          calculation_type: 'fixed_plus_percentage',
          fixed_minor: fee.MONEY_IN_FLAT_KOBO,
          percentage_basis_points: fee.MONEY_IN_HIGH_BPS,
          maximum_minor: null,
        },
      ],
    },
    payout: {
      payer: 'business',
      timing: 'at_payout',
      tiers: [
        { up_to_minor: fee.MONEY_OUT_THRESHOLD_KOBO, calculation_type: 'fixed', fixed_minor: fee.MONEY_OUT_LOW_KOBO, percentage_basis_points: 0, maximum_minor: null },
        { up_to_minor: null, calculation_type: 'fixed', fixed_minor: fee.MONEY_OUT_HIGH_KOBO, percentage_basis_points: 0, maximum_minor: null },
      ],
    },
    identity_verification: { fixed_minor: VERIFICATION_COST_KOBO },
  };
}

const naira = (kobo: number | null | undefined) => (kobo === null || kobo === undefined ? 'none' : `₦${(kobo / 100).toLocaleString('en-NG')}`);
const describeTier = (t: Partial<Tier>) =>
  `${t.up_to_minor === null || t.up_to_minor === undefined ? 'above' : `up to ${naira(t.up_to_minor)}`}: ` +
  `${naira(t.fixed_minor ?? 0)} + ${(t.percentage_basis_points ?? 0) / 100}%` +
  (t.maximum_minor ? `, capped at ${naira(t.maximum_minor)}` : '');

/**
 * Every difference between what we assume and what the provider says, as
 * sentences an operator can act on. Empty means the schedules agree.
 */
function driftAgainst(items: ProviderFee[]): string[] {
  const expected = expectedSchedule();
  const problems: string[] = [];
  const find = (type: string) => items.filter((i) => i.fee_type === type);

  for (const type of ['escrow_service', 'payout'] as const) {
    const theirs = find(type);
    if (theirs.length !== 1) {
      problems.push(`${type}: expected one configuration, the provider lists ${theirs.length}.`);
      continue;
    }
    const t = theirs[0];
    const ours = expected[type];
    if (t.payer !== ours.payer) problems.push(`${type}: we assume the ${ours.payer} pays; the provider charges the ${t.payer}.`);
    if (t.timing !== ours.timing) problems.push(`${type}: we assume ${ours.timing}; the provider charges ${t.timing}.`);

    const theirTiers = t.tiers ?? [];
    if (theirTiers.length !== ours.tiers.length) {
      problems.push(`${type}: we assume ${ours.tiers.length} tiers; the provider has ${theirTiers.length}.`);
      continue;
    }
    ours.tiers.forEach((o, i) => {
      const p = theirTiers[i];
      const same =
        (p.up_to_minor ?? null) === o.up_to_minor &&
        p.calculation_type === o.calculation_type &&
        (p.fixed_minor ?? 0) === (o.fixed_minor ?? 0) &&
        (p.percentage_basis_points ?? 0) === (o.percentage_basis_points ?? 0) &&
        (p.maximum_minor ?? null) === (o.maximum_minor ?? null);
      if (!same) problems.push(`${type} tier ${i + 1}: we assume ${describeTier(o)}; the provider charges ${describeTier(p)}.`);
    });
  }

  // One price per identity method; we record a single cost for either.
  const checks = items.filter((i) => i.fee_type.startsWith('identity_verification'));
  for (const c of checks) {
    if ((c.fixed_minor ?? 0) !== expected.identity_verification.fixed_minor || (c.percentage_basis_points ?? 0) !== 0) {
      problems.push(
        `${c.fee_type}: we record ${naira(expected.identity_verification.fixed_minor)}; the provider charges ${naira(c.fixed_minor ?? 0)}.`
      );
    }
  }

  // A fee type we have never seen is a cost nobody is accounting for.
  const known = new Set(['escrow_service', 'payout']);
  for (const i of items) {
    if (!known.has(i.fee_type) && !i.fee_type.startsWith('identity_verification')) {
      problems.push(`${i.fee_type}: a fee type our ledger does not account for (${i.payer} pays, ${i.timing}).`);
    }
  }

  return problems;
}

/** For GET /admin/diagnostics. Never throws. */
async function checkFeeSchedule(): Promise<{ ok: boolean; reachable: boolean; latencyMs: number; detail: string; drift: string[] }> {
  const startedAt = Date.now();
  try {
    const config = await escrowpay.feeConfiguration();
    const items: ProviderFee[] = Array.isArray(config) ? config : config?.items ?? [];
    const drift = driftAgainst(items);
    return {
      ok: drift.length === 0,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      detail: drift.length === 0 ? 'our fee constants match the provider' : `${drift.length} difference(s) from the provider`,
      drift,
    };
  } catch (err) {
    // Unreachable is NOT drift: the comparison could not be made, and the
    // provider being down is reported by the calls that actually need it.
    return {
      ok: true,
      reachable: false,
      latencyMs: Date.now() - startedAt,
      detail: `could not read the provider's fee configuration: ${(err as Error).message}`,
      drift: [],
    };
  }
}

module.exports = { expectedSchedule, driftAgainst, checkFeeSchedule };
