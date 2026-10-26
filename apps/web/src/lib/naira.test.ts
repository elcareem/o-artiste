/** Naira into kobo — issue #44. The only place money changes notation on the way in. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { koboToNairaInput, parseNairaToKobo } from './naira.ts';

const kobo = (raw: string) => {
  const r = parseNairaToKobo(raw);
  assert.ok(r.ok, `${raw}: ${!r.ok && r.problem}`);
  return r.ok ? r.kobo : NaN;
};

test('the acceptance figure: ₦200,000.50 is exactly 20000050 kobo', () => {
  assert.equal(kobo('₦200,000.50'), 20000050);
});

test('every way a person writes the same amount gives the same kobo', () => {
  for (const typed of ['200000', '200,000', '₦200,000', 'N200000', 'NGN 200,000', ' 200 000 ', '200000.00', '200000.0']) {
    assert.equal(kobo(typed), 20000000, typed);
  }
  assert.equal(kobo('200000.5'), 20000050, 'one decimal place is tenths of a naira');
});

test('amounts a float would get wrong come out exact', () => {
  // Math.round(parseFloat('0.29') * 100) happens to round back to 29, but
  // parseFloat('1.005') * 100 is 100.49999999999999. The point is that no float
  // is involved, so no case has to be checked.
  assert.equal(kobo('0.29'), 29);
  assert.equal(kobo('1.01'), 101);
  assert.equal(kobo('19999.99'), 1999999);
  assert.equal(kobo('3,000,000.00'), 300000000);
});

test('a third decimal place is refused, not rounded', () => {
  const r = parseNairaToKobo('₦200,000.505');
  assert.equal(r.ok, false);
  assert.match((r as { problem: string }).problem, /two decimal places/);
});

test('anything that is not an amount is refused inline', () => {
  for (const typed of ['abc', '1e5', '20O000', '200,00', '1,2,3', '200000.', '.50', '₦']) {
    assert.equal(parseNairaToKobo(typed).ok, false, typed);
  }
  const negative = parseNairaToKobo('-200');
  assert.equal(negative.ok, false);
  assert.match((negative as { problem: string }).problem, /negative/);
  assert.match((parseNairaToKobo('') as { problem: string }).problem, /needed/);
});

test('the message names the field', () => {
  assert.match((parseNairaToKobo('', 'Your rate') as { problem: string }).problem, /^Your rate is needed/);
});

test('kobo goes back into a field the way it would be typed', () => {
  assert.equal(koboToNairaInput(20000050), '200000.50');
  assert.equal(koboToNairaInput(20000000), '200000');
  assert.equal(koboToNairaInput(5), '0.05');
  assert.equal(koboToNairaInput(null), '');
});

test('parse and print round-trip for every kobo remainder', () => {
  for (let k = 20000000; k < 20000100; k++) {
    assert.equal(kobo(koboToNairaInput(k)), k);
  }
});
