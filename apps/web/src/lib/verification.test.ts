/** Identity verification — issue #43. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { identifierProblem, verificationBody, verificationProblems, viewFor } from './verification.ts';
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
  const ready = { method: 'NIN' as const, identifier: '12345678902', consent: true };
  assert.deepEqual(verificationProblems(ready), {});
  assert.ok(verificationProblems({ ...ready, consent: false }).consent);
});

test('consent is sent as the boolean the API requires', () => {
  // The API refuses anything but `true` — "yes", 1 and "on" included (#41).
  assert.equal(verificationBody({ method: 'NIN', identifier: '123 4567 8902', consent: true }).consent, true);
  assert.equal(verificationBody({ method: 'NIN', identifier: '12345678902', consent: false }).consent, false);
  assert.equal(verificationBody({ method: 'BVN', identifier: '222 2222 2222', consent: true }).identifier, '22222222222');
});

test('an identifier is 11 digits, and the message says how many were typed', () => {
  assert.equal(identifierProblem('NIN', '12345678902'), null);
  assert.equal(identifierProblem('BVN', '2222 2222 222'), null);
  assert.match(identifierProblem('NIN', '1234') as string, /11 digits — you have entered 4/);
  assert.match(identifierProblem('NIN', '1234567890a') as string, /digits only/);
  assert.match(identifierProblem('BVN', '') as string, /BVN is needed/);
});
