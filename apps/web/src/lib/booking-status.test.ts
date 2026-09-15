import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  isTerminal,
  isPayable,
  pollDelayMs,
  statusCopy,
  POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
} from './booking-status.ts';

/**
 * The backend's own state machine, read from source.
 *
 * Duplicating the state list here by hand is how the page ends up polling a
 * finished booking forever: the backend adds a terminal state, nothing in the
 * frontend fails, and the bug shows up as a phone battery complaint.
 */
function backendStates(): { all: string[]; terminal: string[] } {
  const source = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      '../../../backend/src/services/bookingService.ts'
    ),
    'utf8'
  );
  // Tolerant of a type annotation between the name and the `=`: the backend is
  // TypeScript, and this test failing because a declaration gained a type would
  // be noise rather than signal.
  const start = source.indexOf('ALLOWED_TRANSITIONS');
  const open = source.indexOf('Object.freeze({', start);
  if (start === -1 || open === -1) {
    throw new Error('Could not find ALLOWED_TRANSITIONS in bookingService — has it been renamed?');
  }
  const map = source.slice(open).split('});')[0];

  const all: string[] = [];
  const terminal: string[] = [];
  for (const line of map.split('\n')) {
    const match = line.match(/^\s*([A-Z_]+):\s*\[(.*)\],?\s*$/);
    if (!match) continue;
    all.push(match[1]);
    if (match[2].trim().length === 0) terminal.push(match[1]);
  }
  return { all, terminal };
}

test('terminal states match the backend state machine exactly', () => {
  const { all, terminal } = backendStates();

  assert.equal(all.length, 9, 'docs/01 §4 defines nine states');
  assert.ok(terminal.length > 0);

  for (const state of all) {
    assert.equal(
      isTerminal(state),
      terminal.includes(state),
      `${state}: frontend says terminal=${isTerminal(state)}, backend says ${terminal.includes(state)}`
    );
  }
});

test('polling stops on every terminal state and continues on every live one', () => {
  for (const state of ['RELEASED', 'REFUNDED', 'CANCELLED', 'RESOLVED']) {
    assert.equal(isTerminal(state), true, `${state} should stop polling`);
  }
  for (const state of [
    'PENDING_PAYMENT',
    'FUNDED_HELD',
    'CHECKED_IN',
    'AWAITING_CONFIRMATION',
    'DISPUTED',
  ]) {
    assert.equal(isTerminal(state), false, `${state} should keep polling`);
  }
});

test('an unknown state keeps polling rather than freezing the page', () => {
  // Stopping too early leaves a client staring at stale information. Polling
  // too long costs a request.
  assert.equal(isTerminal('SOME_NEW_STATE'), false);
  assert.equal(isTerminal(''), false);
});

test('a failed poll backs off, and recovery resets it', () => {
  assert.equal(pollDelayMs(0), POLL_INTERVAL_MS);
  assert.equal(pollDelayMs(1), 10_000);
  assert.equal(pollDelayMs(2), 20_000);
  assert.equal(pollDelayMs(3), 40_000);

  // A page left open on a phone against a backend that is down must not ask
  // every five seconds for hours.
  assert.equal(pollDelayMs(4), MAX_POLL_INTERVAL_MS);
  assert.equal(pollDelayMs(50), MAX_POLL_INTERVAL_MS);
});

test('every state has copy, and none of it leaks system vocabulary', () => {
  const { all } = backendStates();
  const jargon = /escrow|webhook|state machine|kobo|bps|basis point|null|undefined|API|HTTP|\d{3} error/i;

  for (const state of all) {
    const copy = statusCopy(state);
    assert.ok(copy.label.length > 0, `${state} has no label`);
    assert.ok(copy.headline.length > 0, `${state} has no headline`);
    assert.ok(copy.detail.length > 0, `${state} has no detail`);

    const text = `${copy.label} ${copy.headline} ${copy.detail}`;
    assert.doesNotMatch(text, jargon, `${state} copy leaks system vocabulary: "${text}"`);

    // The raw enum name must never reach the reader.
    assert.doesNotMatch(text, /[A-Z]{3,}_[A-Z]/, `${state} copy contains a raw state name`);
  }
});

test('an unrecognised state gets truthful copy, not a crash or a raw enum', () => {
  const copy = statusCopy('AWAITING_CONFIRMATION_V2');
  assert.ok(copy.headline.length > 0);
  assert.doesNotMatch(copy.headline, /V2|_/);
  assert.doesNotMatch(copy.detail, /V2|_/);
});

test('a masked account number is never presented as payable', () => {
  // #18 found that the provider's payment-accounts endpoint returns the
  // destination masked (****4680), which nobody can transfer to. Only the
  // checkout session carries the full number. This is the last guard before a
  // client is asked to type it into their banking app.
  const base = { accountName: 'O-artist', bankCode: '090175', provider: 'rubies', expiresAt: null };

  assert.equal(isPayable({ ...base, accountNumber: '8881754743' }), true);
  assert.equal(isPayable({ ...base, accountNumber: '****4680' }), false);
  assert.equal(isPayable({ ...base, accountNumber: '888175****' }), false);
  assert.equal(isPayable({ ...base, accountNumber: '' }), false);
  assert.equal(isPayable({ ...base, accountNumber: '8881 754743' }), false);
  assert.equal(isPayable(null), false);
  assert.equal(isPayable(undefined), false);
});
