/** Booking requests and their terms — issue #46. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MAX_BOOKING_KOBO, MIN_BOOKING_KOBO, bandSentences, eventWindow, lagosToIso, requestProblems } from './booking-request.ts';

test('8pm in Lagos is 7pm UTC, whatever timezone the browser is in', () => {
  assert.equal(lagosToIso('2026-12-24', '20:00'), '2026-12-24T19:00:00.000Z');
});

test('an event that ends after midnight ends the next morning, and says so', () => {
  const w = eventWindow('2026-12-24', '20:00', '02:00')!;
  assert.equal(w.startIso, '2026-12-24T19:00:00.000Z');
  assert.equal(w.endIso, '2026-12-25T01:00:00.000Z');
  assert.equal(w.crossesMidnight, true);

  const same = eventWindow('2026-12-24', '18:00', '22:00')!;
  assert.equal(same.crossesMidnight, false);
});

const now = new Date('2026-10-14T12:00:00Z');
const valid = { date: '2026-12-24', start: '20:00', end: '23:00', location: 'Eko Hotel', amount: '200,000' };

test('a complete request has no problems', () => {
  assert.deepEqual(requestProblems(valid, now), {});
});

test('an empty request names every field', () => {
  const p = requestProblems({ date: '', start: '', end: '', location: '', amount: '' }, now);
  assert.deepEqual(Object.keys(p).sort(), ['amount', 'date', 'end', 'location', 'start']);
});

test('a past event is refused', () => {
  assert.match(requestProblems({ ...valid, date: '2026-10-01' }, now).date as string, /future/);
});

test('the amount is typed in naira and checked against the range', () => {
  assert.match(requestProblems({ ...valid, amount: '19,999' }, now).amount as string, /between ₦20,000 and ₦3,000,000/);
  assert.match(requestProblems({ ...valid, amount: '3,000,001' }, now).amount as string, /between/);
  assert.match(requestProblems({ ...valid, amount: 'abc' }, now).amount as string, /naira/);
});

test('the range matches the backend', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../../backend/src/lib/escrowpay.ts'), 'utf8');
  assert.equal(Number(src.match(/const MIN_TRANSACTION_KOBO\s*=\s*(\d+)/)![1]), MIN_BOOKING_KOBO);
  assert.equal(Number(src.match(/const MAX_TRANSACTION_KOBO\s*=\s*(\d+)/)![1]), MAX_BOOKING_KOBO);
});

const BANDS = [
  { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
  { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
  { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
  { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
];

test('the terms read most notice first, in naira', () => {
  const s = bandSentences([...BANDS].reverse(), 20_000_000);
  assert.deepEqual(s.map((x) => x.when), ['7 or more days before', '3–6 days before', '1–2 days before', 'On the day of the event']);
  assert.match(s[0].outcome, /everything back — ₦200,000/);
  assert.match(s[1].outcome, /70% comes back to you — ₦140,000.*keeps 30%/);
  assert.match(s[3].outcome, /15% comes back to you — ₦30,000/);
});

test('the naira figures floor exactly as the backend does', () => {
  // 15% of ₦200,000.50 is 3,000,007.5 kobo — floored, never rounded up.
  assert.match(bandSentences([BANDS[3]], 20_000_050)[0].outcome, /₦30,000\.07/);
});
