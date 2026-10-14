/** After the event — issue #47. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { NOT_ACTIONABLE, afterEventOptions } from './after-event.ts';

const now = new Date('2026-11-04T10:00:00Z');
const ended = {
  state: 'AWAITING_CONFIRMATION',
  eventDate: '2026-11-03T19:00:00Z',
  eventEndAt: '2026-11-03T23:00:00Z',
  clientConfirmedAt: null,
  artistConfirmedAt: null,
  autoReleaseAt: '2026-11-05T23:00:00Z',
  checkedInAt: '2026-11-03T18:40:00Z',
  openDisputeId: null,
};

test('after the event the client can confirm or dispute, and is told the deadline', () => {
  const o = afterEventOptions(ended, 'CLIENT', now);
  assert.equal(o.canConfirm, true);
  assert.equal(o.canDispute, true);
  assert.equal(o.deadline, '2026-11-05T23:00:00Z');
});

test('nothing is offered before the event has ended', () => {
  const o = afterEventOptions({ ...ended, state: 'FUNDED_HELD', eventEndAt: '2026-11-04T23:00:00Z' }, 'CLIENT', now);
  assert.deepEqual([o.canConfirm, o.canClaimNoShow, o.canDispute], [false, false, false]);
});

test('an artist is never offered a no-show claim', () => {
  assert.equal(afterEventOptions({ ...ended, checkedInAt: null, state: 'FUNDED_HELD' }, 'ARTIST', now).canClaimNoShow, false);
});

test('a client is not offered a no-show over a check-in on record', () => {
  // The artist demonstrably arrived. A no-show claim would be false — and
  // carries a strike. What went wrong after arrival is a dispute.
  assert.equal(afterEventOptions(ended, 'CLIENT', now).canClaimNoShow, false);
  assert.equal(afterEventOptions({ ...ended, checkedInAt: null, state: 'FUNDED_HELD' }, 'CLIENT', now).canClaimNoShow, true);
});

test('someone who has confirmed is not asked again, nor shown the deadline', () => {
  const o = afterEventOptions({ ...ended, clientConfirmedAt: '2026-11-04T08:00:00Z' }, 'CLIENT', now);
  assert.equal(o.canConfirm, false);
  assert.equal(o.deadline, null);
});

test('an open dispute is linked to, not opened twice', () => {
  const o = afterEventOptions({ ...ended, state: 'DISPUTED', openDisputeId: 'd1' }, 'ARTIST', now);
  assert.equal(o.canDispute, false);
  assert.equal(o.canConfirm, false);
  assert.equal(o.disputeId, 'd1');
});

test('a settled booking offers nothing', () => {
  for (const state of ['RELEASED', 'REFUNDED', 'CANCELLED', 'RESOLVED']) {
    const o = afterEventOptions({ ...ended, state }, 'CLIENT', now);
    assert.deepEqual([o.canConfirm, o.canClaimNoShow, o.canDispute], [false, false, false], state);
  }
});

test('the states offered nothing match the backend exactly', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../../backend/src/services/confirmationService.ts'), 'utf8');
  const block = src.slice(src.indexOf('function assertActionable'));
  const backend = [...block.slice(0, block.indexOf('};')).matchAll(/^\s+([A-Z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual([...NOT_ACTIONABLE].sort(), backend.sort());
});

test('an artist who never checked in is told what that means for payment', () => {
  const noCheckIn = { ...ended, checkedInAt: null, state: 'FUNDED_HELD' };
  assert.equal(afterEventOptions(noCheckIn, 'ARTIST', now).artistMissingCheckIn, true);
  assert.equal(afterEventOptions(ended, 'ARTIST', now).artistMissingCheckIn, false);
  assert.equal(afterEventOptions(noCheckIn, 'CLIENT', now).artistMissingCheckIn, false, 'the client is not told to check in');
});
