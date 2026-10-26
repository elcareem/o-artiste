/**
 * Check-in availability and its copy — issue #39.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CODE_LENGTH, canCheckIn, codeProblem, normaliseCode, whyNotYet } from './check-in.ts';
import { isPresentable } from './error-messages.ts';

const STATES = [
  'PENDING_PAYMENT',
  'FUNDED_HELD',
  'CHECKED_IN',
  'AWAITING_CONFIRMATION',
  'DISPUTED',
  'RELEASED',
  'REFUNDED',
  'CANCELLED',
  'RESOLVED',
];

test('only a funded booking can be checked in', () => {
  // Mirrors the backend: `redeem()` refuses unless the booking can transition to
  // CHECKED_IN, and only FUNDED_HELD can. If that map changes, this fails rather
  // than the two quietly diverging.
  assert.equal(canCheckIn('FUNDED_HELD'), true);

  for (const state of STATES.filter((s) => s !== 'FUNDED_HELD')) {
    assert.equal(canCheckIn(state), false, state);
  }
});

test('every state has a sentence saying why not', () => {
  for (const state of STATES.filter((s) => s !== 'FUNDED_HELD')) {
    const why = whyNotYet(state);
    assert.ok(why.length > 0, state);
    // Never the bare state name — an artist should not be shown a database
    // constant because we added a state and forgot a sentence.
    assert.doesNotMatch(why, /[A-Z]{2,}_[A-Z]/, `${state}: ${why}`);
    assert.equal(isPresentable(why), true, state);
  }
});

test('an unknown state gets a truthful placeholder, not a crash', () => {
  const why = whyNotYet('SOME_FUTURE_STATE');
  assert.match(why, /not available/i);
  assert.doesNotMatch(why, /SOME_FUTURE_STATE/);
});

test('the states an artist is most likely to hit name a next action', () => {
  // These three are the ones an artist reaches by opening the link early, twice,
  // or after the window. "You cannot check in" strands them at a venue.
  assert.match(whyNotYet('PENDING_PAYMENT'), /Ask the client/);
  assert.match(whyNotYet('CHECKED_IN'), /already checked in/i);
  assert.match(whyNotYet('AWAITING_CONFIRMATION'), /Confirm how it went/);
});

test('an already-checked-in booking reads differently from a disputed one', () => {
  // #39's second criterion in the shape it takes BEFORE the form is submitted.
  assert.notEqual(whyNotYet('CHECKED_IN'), whyNotYet('DISPUTED'));
  assert.match(whyNotYet('DISPUTED'), /held/);
});

test('a correct code is accepted in every form the client might read it out', () => {
  // The client is shown ABCD-EFGH. An artist may type it with the hyphen, with
  // a space, without either, or in lower case — the backend accepts all of them.
  //
  // THIS TEST DID NOT EXIST WHEN #39 SHIPPED, and the form then rejected every
  // one of these: it counted raw characters against a length of 6. No artist
  // could check in through the web app.
  for (const typed of ['ABCD-EFGH', 'ABCDEFGH', 'abcd-efgh', 'ABCD EFGH', '  ABCD-EFGH  ', 'abcd efgh']) {
    assert.equal(codeProblem(typed), null, `rejected a correct code typed as "${typed}"`);
  }
});

test('normalising matches the backend: upper case, separators gone', () => {
  assert.equal(normaliseCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normaliseCode(' AB CD-EF GH '), 'ABCDEFGH');
});

test('a code of the wrong length is caught before a round trip', () => {
  assert.match(codeProblem('') as string, /needed/);
  assert.match(codeProblem('---') as string, /needed/, 'separators alone are not a code');
  assert.match(codeProblem('ABCD-EFG') as string, /8 characters/);
  assert.match(codeProblem('ABCD-EFGHJ') as string, /8 characters/);
  // And it says what a code looks like, because "wrong length" alone does not
  // help someone holding a phone at a venue door.
  assert.match(codeProblem('ABC') as string, /ABCD-EFGH/);
});

test('the client check does not guess at the alphabet', () => {
  // The backend's ALPHABET excludes characters people confuse. A client-side
  // character check that guessed at it would reject a valid code typed
  // correctly, which is worse than a round trip.
  assert.equal(codeProblem('0OI1-L5QU'), null);
});

/** Reads a constant or a pattern out of the backend's check-in service. */
function backendCheckInSource(): string {
  return fs.readFileSync(
    path.resolve(import.meta.dirname, '../../../backend/src/services/checkInService.ts'),
    'utf8'
  );
}

test('CODE_LENGTH matches the backend exactly', () => {
  // The mirror that was missing. A hard-coded length on this side and a
  // different one on the other is precisely the bug #41 found.
  const match = backendCheckInSource().match(/const CODE_LENGTH\s*=\s*(\d+)/);
  assert.ok(match, 'could not find CODE_LENGTH in checkInService — has it been renamed?');
  assert.equal(CODE_LENGTH, Number(match![1]));
});

test('normaliseCode strips exactly what the backend strips', () => {
  const source = backendCheckInSource();
  const body = source.slice(source.indexOf('function normaliseCode'));
  assert.ok(body.includes('.toUpperCase()'), 'the backend no longer upper-cases');
  assert.ok(body.includes('/[^0-9A-Z]/g'), 'the backend strips a different set of characters now');
});

/**
 * The states the BACKEND will accept a redemption from, read from its own
 * transition map.
 *
 * `canCheckIn` is a mirror, and a commented mirror is one that diverges. This
 * reads the source of truth so a change to the map fails here instead of
 * producing a form an artist can fill in and a backend that refuses it.
 *
 * The same approach as booking-status.test.ts, for the same reason.
 */
function statesThatCanCheckIn(): string[] {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../../backend/src/services/bookingService.ts'),
    'utf8'
  );

  const start = source.indexOf('ALLOWED_TRANSITIONS');
  const open = source.indexOf('Object.freeze({', start);
  if (start === -1 || open === -1) {
    throw new Error('Could not find ALLOWED_TRANSITIONS in bookingService — has it been renamed?');
  }
  const map = source.slice(open).split('});')[0];

  const allowed: string[] = [];
  for (const line of map.split('\n')) {
    const match = line.match(/^\s*([A-Z_]+):\s*\[(.*)\],?\s*$/);
    if (!match) continue;
    if (match[2].includes("'CHECKED_IN'")) allowed.push(match[1]);
  }
  return allowed;
}

test('canCheckIn matches the backend transition map exactly', () => {
  const allowed = statesThatCanCheckIn();

  assert.ok(allowed.length > 0, 'no state can reach CHECKED_IN — the map was misread');

  for (const state of STATES) {
    assert.equal(
      canCheckIn(state),
      allowed.includes(state),
      `${state}: the form and the backend disagree about whether a code can be redeemed`
    );
  }
});
