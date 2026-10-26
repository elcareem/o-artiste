/**
 * Are our fee constants still the provider's prices? — the drift check.
 *
 * Built after EscrowPay changed two prices in October 2026 without notice, and
 * proved when it changed them again (v4, 16 October 2026). The fixture is the
 * provider's live configuration as read on 26 October 2026.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { driftAgainst } = require('../src/services/feeScheduleService.ts');

/** GET /fees/configuration, 26 October 2026 (v4), trimmed to the fields compared. */
const LIVE_V4 = [
  {
    fee_type: 'escrow_service', payer: 'payer', timing: 'at_funding', calculation_type: 'tiered', version: 4,
    tiers: [
      { up_to_minor: 25000000, calculation_type: 'fixed_plus_percentage', fixed_minor: 15000, percentage_basis_points: 150, maximum_minor: 300000 },
      { up_to_minor: 5000000000, calculation_type: 'fixed_plus_percentage', fixed_minor: 15000, percentage_basis_points: 125, maximum_minor: null },
    ],
  },
  {
    fee_type: 'payout', payer: 'business', timing: 'at_payout', calculation_type: 'tiered', version: 4,
    tiers: [
      { up_to_minor: 5000000, calculation_type: 'fixed', fixed_minor: 4000, percentage_basis_points: 0, maximum_minor: null },
      { up_to_minor: null, calculation_type: 'fixed', fixed_minor: 7000, percentage_basis_points: 0, maximum_minor: null },
    ],
  },
  { fee_type: 'identity_verification_nin', payer: 'business', timing: 'at_funding', calculation_type: 'fixed', fixed_minor: 8000, percentage_basis_points: 0 },
  { fee_type: 'identity_verification_bvn', payer: 'business', timing: 'at_funding', calculation_type: 'fixed', fixed_minor: 8000, percentage_basis_points: 0 },
];

const clone = () => JSON.parse(JSON.stringify(LIVE_V4));

test('our constants match the provider as it stands', () => {
  assert.deepEqual(driftAgainst(LIVE_V4), []);
});

test('the v2 → v4 change would be reported, every part of it', () => {
  // v2 (8 October 2026): ₦100 fixed, ₦2,000 cap, 0.8% above ₦250,000, an
  // unbounded top tier, and identity checks at ₦70.
  const v2 = clone();
  v2[0].tiers[0].fixed_minor = 10000;
  v2[0].tiers[0].maximum_minor = 200000;
  v2[0].tiers[1] = { ...v2[0].tiers[1], up_to_minor: null, fixed_minor: 10000, percentage_basis_points: 80 };
  v2[2].fixed_minor = 7000;
  v2[3].fixed_minor = 7000;

  const drift = driftAgainst(v2).join('\n');
  assert.equal(driftAgainst(v2).length, 4);
  assert.match(drift, /escrow_service tier 1/);
  assert.match(drift, /escrow_service tier 2/);
  assert.match(drift, /identity_verification_nin: we record ₦80; the provider charges ₦70/);
  assert.match(drift, /identity_verification_bvn/);
});

test('a bounded top tier is the same as ours only if no booking can reach the bound', () => {
  // v4 bounds the top tier at ₦50,000,000; ours is open-ended because bookings
  // stop at ₦3,000,000. A bound inside our range would be a real difference.
  const low = clone();
  low[0].tiers[1].up_to_minor = 100000000; // ₦1,000,000
  assert.match(driftAgainst(low).join('\n'), /escrow_service tier 2/);
});

test('who pays is checked, not only how much', () => {
  // The fee-bearer model is the whole of #18. A provider switching the money-in
  // fee to the business would silently move it onto our side of the ledger.
  const moved = clone();
  moved[0].payer = 'business';
  assert.match(driftAgainst(moved).join('\n'), /we assume the payer pays; the provider charges the business/);
});

test('a new fee type nobody accounts for is reported', () => {
  // This is how a refund fee — open item 11.1 — would first show up.
  const extra = [...clone(), { fee_type: 'refund', payer: 'business', timing: 'at_refund', calculation_type: 'fixed', fixed_minor: 5000 }];
  assert.match(driftAgainst(extra).join('\n'), /refund: a fee type our ledger does not account for/);
});

test('a missing configuration is reported rather than passing as "no difference"', () => {
  const missing = clone().filter((i: any) => i.fee_type !== 'payout');
  assert.match(driftAgainst(missing).join('\n'), /payout: expected one configuration, the provider lists 0/);
});

test('a changed tier boundary is reported', () => {
  const moved = clone();
  moved[1].tiers[0].up_to_minor = 10000000;
  assert.match(driftAgainst(moved).join('\n'), /payout tier 1/);
});
