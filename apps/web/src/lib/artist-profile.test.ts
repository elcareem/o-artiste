/** Artist listing status — issue #44. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REQUIRED_FOR_LISTING, listingStatus } from './artist-profile.ts';

const complete = {
  stageName: 'DJ Spinall',
  category: 'DJ',
  location: 'Lagos',
  baseRateKobo: 20000000,
  verificationStatus: 'VERIFIED',
  accountStanding: 'GOOD',
  payoutRegistered: true,
};

test('a complete, verified artist in good standing is listable with nothing to say', () => {
  assert.deepEqual(listingStatus(complete), { listable: true, missing: [], warnings: [] });
});

test('an incomplete profile says exactly what is missing', () => {
  const s = listingStatus({ ...complete, category: '', location: null });
  assert.equal(s.listable, false);
  assert.equal(s.missing.length, 1);
  assert.match(s.missing[0], /what you perform, where you are based/);
});

test('an unverified artist is told to verify', () => {
  const s = listingStatus({ ...complete, verificationStatus: 'UNVERIFIED' });
  assert.equal(s.listable, false);
  assert.match(s.missing.join(' '), /Verify your identity/);
});

test('a suspended artist is told, without the word "suspended"', () => {
  const s = listingStatus({ ...complete, accountStanding: 'SUSPENDED' });
  assert.equal(s.listable, false);
  assert.match(s.missing.join(' '), /under review/);
});

test('no bank account is a warning, not a listing block — matching the backend', () => {
  const s = listingStatus({ ...complete, payoutRegistered: false });
  assert.equal(s.listable, true);
  assert.match(s.warnings[0], /cannot be paid/);
});

test('the required fields match the backend exactly', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../../backend/src/services/artistService.ts'), 'utf8');
  const m = src.match(/const REQUIRED_FOR_COMPLETE\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'REQUIRED_FOR_COMPLETE not found');
  const backend = m![1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual([...REQUIRED_FOR_LISTING].sort(), backend.sort());
});

test('the listing conditions match the backend filter', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../../backend/src/services/artistService.ts'), 'utf8');
  const filter = src.slice(src.indexOf('function listabilityFilter'), src.indexOf('async function isListable'));
  assert.match(filter, /verificationStatus: 'VERIFIED'/);
  assert.match(filter, /notIn: \['SUSPENDED', 'REMOVED'\]/);
  // If the backend ever starts requiring a payout account, this module's
  // "warning, not a block" would be wrong. Fail here so it gets updated.
  assert.doesNotMatch(filter, /payoutAccount/);
});
