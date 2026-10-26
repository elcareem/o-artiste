/** Identity verification — issue #43. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { dateOfBirthProblem, identifierProblem, verificationBody, verificationProblems, viewFor } from './verification.ts';
import { isPresentable } from './error-messages.ts';

const STATUSES = ['UNVERIFIED', 'PENDING', 'VERIFIED', 'RETRYABLE_FAILURE', 'REJECTED'];

test('every status the backend can hold has a view, and none leaks the enum', () => {
  // Read from the schema, so a status added there fails here until it has words.
  const schema = fs.readFileSync(path.resolve(import.meta.dirname, '../../../backend/prisma/schema.prisma'), 'utf8');
  const block = schema.slice(schema.indexOf('enum VerificationStatus'));
  const fromSchema = block.slice(block.indexOf('{') + 1, block.indexOf('}')).split(/\s+/).filter(Boolean);
  assert.deepEqual(fromSchema.sort(), [...STATUSES].sort());

  for (const status of STATUSES) {
    const v = viewFor(status);
    assert.doesNotMatch(`${v.headline} ${v.detail}`, /[A-Z]{3,}_[A-Z]/, status);
    assert.equal(isPresentable(v.detail), true, status);
  }
});

test('a provider outage and a genuine rejection read differently, and only one offers a retry', () => {
  // #43's acceptance criterion.
  const outage = viewFor('RETRYABLE_FAILURE');
  const rejected = viewFor('REJECTED');
  assert.equal(outage.mode, 'form');
  assert.equal(rejected.mode, 'blocked');
  assert.notEqual(outage.headline, rejected.headline);
  assert.match(outage.detail, /not yours/);
  assert.match(rejected.detail, /Contact support/);
});

test('a verified user is never shown the form', () => {
  assert.equal(viewFor('VERIFIED').mode, 'done');
});

test('an unknown status is treated as not verified, never as verified', () => {
  assert.equal(viewFor('SOMETHING_NEW').mode, 'form');
  assert.equal(viewFor(null).mode, 'form');
});

test('the form cannot be submitted without consent', () => {
  const ready = { method: 'NIN' as const, identifier: '12345678902', dateOfBirth: '1990-01-15', consent: true };
  assert.deepEqual(verificationProblems(ready), {});
  assert.ok(verificationProblems({ ...ready, consent: false }).consent);
});

test('consent is sent as the boolean the API requires', () => {
  // The API refuses anything but `true` — "yes", 1 and "on" included (#41).
  assert.equal(verificationBody({ method: 'NIN', identifier: '123 4567 8902', dateOfBirth: '1990-01-15', consent: true }).consent, true);
  assert.equal(verificationBody({ method: 'NIN', identifier: '12345678902', dateOfBirth: '1990-01-15', consent: false }).consent, false);
  assert.equal(verificationBody({ method: 'BVN', identifier: '222 2222 2222', dateOfBirth: '1990-01-15', consent: true }).identifier, '22222222222');
});

test('an identifier is 11 digits, and the message says how many were typed', () => {
  assert.equal(identifierProblem('NIN', '12345678902'), null);
  assert.equal(identifierProblem('BVN', '2222 2222 222'), null);
  assert.match(identifierProblem('NIN', '1234') as string, /11 digits — you have entered 4/);
  assert.match(identifierProblem('NIN', '1234567890a') as string, /digits only/);
  assert.match(identifierProblem('BVN', '') as string, /BVN is needed/);
});

test('the date of birth is checked the way the backend checks it', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  assert.equal(dateOfBirthProblem('1990-01-15', now), null);
  assert.equal(dateOfBirthProblem('2008-10-14', now), null, 'eighteen today');
  assert.match(dateOfBirthProblem('2008-10-15', now) as string, /18 or older/);
  assert.match(dateOfBirthProblem('1990-02-30', now) as string, /not a real date/);
  assert.match(dateOfBirthProblem('', now) as string, /needed/);
  assert.match(dateOfBirthProblem('1850-01-01', now) as string, /year/);
});

test('the age limit matches the backend', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../../backend/src/services/verificationService.ts'), 'utf8');
  const m = src.match(/const MIN_AGE_YEARS\s*=\s*(\d+)/);
  assert.ok(m, 'MIN_AGE_YEARS not found in verificationService');
  assert.equal(Number(m![1]), 18);
});

test('the date of birth goes in the body the API expects', () => {
  assert.equal(
    verificationBody({ method: 'NIN', identifier: '12345678902', dateOfBirth: ' 1990-01-15 ', consent: true }).dateOfBirth,
    '1990-01-15'
  );
});
