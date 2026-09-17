import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { shouldShowRate } from './reputation.ts';

/**
 * The below-threshold case — docs/06 §6, issue #35.
 *
 * The rule is that nothing renders. Not "0%", not "N/A", not "No data" — all of
 * which imply something the record does not support.
 */

test('null is not zero, and only one of them is shown', () => {
  // `null` means "not enough bookings to say anything". Zero, once the
  // threshold is met, is a fact: enough bookings concluded and none cancelled.
  assert.equal(shouldShowRate(null), false);
  assert.equal(shouldShowRate(undefined), false);

  assert.equal(shouldShowRate(0), true);
  assert.equal(shouldShowRate(20), true);
  assert.equal(shouldShowRate(100), true);

  // A figure that is not a figure is not a fact either.
  assert.equal(shouldShowRate(NaN), false);
  assert.equal(shouldShowRate(Infinity), false);
});

test('the component defers to the rule rather than re-deciding it', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../components/cancellation-rate.tsx'),
    'utf8'
  );

  // A second copy of the condition inside the component is a second place it
  // can drift from what is tested here.
  assert.match(source, /shouldShowRate/);
  assert.match(source, /return null/);
});

test('the stat sits above the booking action on the profile', () => {
  // docs/06 §7: it exists so a client can factor reliability into the decision,
  // which requires seeing it BEFORE committing — not in a footer, not on a
  // review page afterwards. Asserted against the source because the ordering is
  // the requirement, and it must survive any styling change.
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../app/artists/[id]/page.tsx'),
    'utf8'
  );

  const stat = source.indexOf('<CancellationRate');
  const cta = source.indexOf('data-testid="booking-cta"');

  assert.ok(stat !== -1, 'the profile no longer renders the cancellation rate');
  assert.ok(cta !== -1, 'the booking call to action has been renamed');
  assert.ok(stat < cta, 'the cancellation rate is rendered after the booking action');
});

test('the copy never describes the absence of a rate', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../components/cancellation-rate.tsx'),
    'utf8'
  );

  // "N/A" and "No data" draw attention to an absence and read as a warning. An
  // artist with two completed bookings should look neutral, because they are.
  const rendered = source.split('return (')[1] ?? '';
  assert.doesNotMatch(rendered, /N\/A|No data|Not available|unknown/i);
});
