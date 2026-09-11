import test from 'node:test';
import assert from 'node:assert/strict';

import { formatNaira } from './currency.ts';

test('the acceptance criteria from issue #3', () => {
  assert.equal(formatNaira(20000000), '₦200,000');
  // Must not be an empty string, and must not be ₦NaN.
  assert.equal(formatNaira(0), '₦0');
});

test('formats whole Naira without decimals', () => {
  assert.equal(formatNaira(100), '₦1');
  assert.equal(formatNaira(150000000), '₦1,500,000');
});

test('renders kobo remainders to two places rather than rounding them away', () => {
  assert.equal(formatNaira(123456), '₦1,234.56');
  assert.equal(formatNaira(1), '₦0.01');
  assert.equal(formatNaira(99), '₦0.99');
});

test('the EscrowPay transaction bounds render correctly', () => {
  // docs/00-OVERVIEW.md §4 — the range a booking must sit inside.
  assert.equal(formatNaira(2000000), '₦20,000');
  assert.equal(formatNaira(300000000), '₦3,000,000');
});

test('negative amounts keep the sign outside the symbol', () => {
  assert.equal(formatNaira(-50000), '-₦500');
});

test('rejects anything that is not an integer number of kobo', () => {
  // Loud by design. A float or NaN here means a contract violation upstream,
  // and rendering a plausible-looking figure would hide a money bug.
  for (const bad of [1.5, NaN, Infinity, -Infinity]) {
    assert.throws(() => formatNaira(bad), TypeError, `should reject ${bad}`);
  }
});

test('never produces NaN or an empty string for any integer input', () => {
  for (let kobo = 0; kobo <= 100000; kobo += 997) {
    const out = formatNaira(kobo);
    assert.ok(out.length > 0, `empty output for ${kobo}`);
    assert.ok(!out.includes('NaN'), `NaN in output for ${kobo}`);
    assert.ok(out.startsWith('₦'), `missing symbol for ${kobo}`);
  }
});
