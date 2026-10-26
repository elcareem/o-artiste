/** The client's check-in code — issue #48. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { codeGuidance, shouldFetchCode } from './check-in-code.ts';

test('only the client is ever asked for the code, and only while it can be used', () => {
  assert.equal(shouldFetchCode('FUNDED_HELD', 'CLIENT'), true);
  assert.equal(shouldFetchCode('CHECKED_IN', 'CLIENT'), true);
  // The artist must get it from the client's hand, never from a screen.
  for (const state of ['FUNDED_HELD', 'CHECKED_IN']) assert.equal(shouldFetchCode(state, 'ARTIST'), false);
  for (const state of ['PENDING_PAYMENT', 'AWAITING_CONFIRMATION', 'RELEASED', 'REFUNDED', 'CANCELLED', 'DISPUTED']) {
    assert.equal(shouldFetchCode(state, 'CLIENT'), false, state);
  }
});

test('the client is told when to hand it over, and why', () => {
  const g = codeGuidance({ reason: null }, 'Burna');
  assert.match(g.detail, /Give this to Burna when they arrive — not before/);
  assert.match(g.detail, /releases their payment/);
});

test('a used code and an expired one read differently', () => {
  assert.match(codeGuidance({ reason: 'already_redeemed' }, 'Burna').headline, /checked in/);
  assert.match(codeGuidance({ reason: 'expired' }, 'Burna').headline, /expired/);
});
