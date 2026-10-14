/**
 * Are our fee constants still the provider's prices? — the drift check.
 *
 * Built after EscrowPay changed two prices in October 2026 without notice.
 * The fixture is the provider's live configuration as read on 14 October 2026.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { driftAgainst } = require('../src/services/feeScheduleService.ts');

/** GET /fees/configuration, 14 October 2026, trimmed to the fields compared. */
const LIVE_V2 = [
  {
    fee_type: 'escrow_service', payer: 'payer', timing: 'at_funding', calculation_type: 'tiered', version: 2,
    tiers: [
      { up_to_minor: 25000000, calculation_type: 'fixed_plus_percentage', fixed_minor: 10000, percentage_basis_points: 150, maximum_minor: 200000 },
      { up_to_minor: null, calculation_type: 'fixed_plus_percentage', fixed_minor: 10000, percentage_basis_points: 80, maximum_minor: null },
    ],
  },
  {
    fee_type: 'payout', payer: 'business', timing: 'at_payout', calculation_type: 'tiered', version: 2,
    tiers: [
      { up_to_minor: 5000000, calculation_type: 'fixed', fixed_minor: 4000, percentage_basis_points: 0, maximum_minor: null },
      { up_to_minor: null, calculation_type: 'fixed', fixed_minor: 7000, percentage_basis_points: 0, maximum_minor: null },
    ],
  },
  { fee_type: 'identity_verification_nin', payer: 'business', timing: 'at_funding', calculation_type: 'fixed', fixed_minor: 7000, percentage_basis_points: 0 },
  { fee_type: 'identity_verification_bvn', payer: 'business', timing: 'at_funding', calculation_type: 'fixed', fixed_minor: 7000, percentage_basis_points: 0 },
];

const clone = () => JSON.parse(JSON.stringify(LIVE_V2));

test('our constants match the provider as it stands', () => {
  assert.deepEqual(driftAgainst(LIVE_V2), []);
});

test('the change that went unnoticed for two weeks would now be reported', () => {
  // v1: the upper money-in tier had no fixed part, and identity checks were ₦50.
  const v1 = clone();
  v1[0].tiers[1].fixed_minor = 0;
  v1[2].fixed_minor = 5000;
  v1[3].fixed_minor = 5000;

  const drift = driftAgainst(v1);
  assert.equal(drift.length, 3);
  assert.match(drift[0], /escrow_service tier 2: we assume above: ₦100 \+ 0\.8%; the provider charges above: ₦0 \+ 0\.8%/);
  assert.match(drift.join('\n'), /identity_verification_nin: we record ₦70; the provider charges ₦50/);
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
