/** "My bookings" links — issue #45. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { hrefFor } from './my-bookings.ts';

test('each action leads to the page that does it', () => {
  assert.equal(hrefFor({ id: 'b1', action: { code: 'CHECK_IN', label: '' } }), '/check-in/b1');
  assert.equal(hrefFor({ id: 'b1', action: { code: 'ACCEPT_TERMS', label: '' } }), '/bookings/b1/terms');
  for (const code of ['PAY', 'CONFIRM', 'DISPUTE_OPEN']) {
    assert.equal(hrefFor({ id: 'b1', action: { code, label: '' } }), '/booking-status/b1', code);
  }
  assert.equal(hrefFor({ id: 'b1', action: null }), '/booking-status/b1');
});
