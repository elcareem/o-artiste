/** Sign-up rules — issue #42. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MIN_PASSWORD_LENGTH, homeFor, normalisePhone, registrationBody, signupProblems } from './signup.ts';

const valid = {
  role: 'CLIENT' as const,
  name: 'Ada Obi',
  email: 'ada@example.com',
  phone: '0801 234 5678',
  password: 'a long enough phrase',
};

test('a complete form has no problems', () => {
  assert.deepEqual(signupProblems(valid), {});
});

test('an empty form names every field, inline', () => {
  const problems = signupProblems({ role: '', name: '', email: '', phone: '', password: '' });
  assert.deepEqual(Object.keys(problems).sort(), ['email', 'name', 'password', 'phone', 'role']);
});

test('an artist is asked for a stage name, a client for a name', () => {
  assert.match(signupProblems({ ...valid, role: 'ARTIST', name: '' }).name as string, /stage name/);
  assert.doesNotMatch(signupProblems({ ...valid, name: '' }).name as string, /stage/);
});

test('a Nigerian number is accepted however it is typed', () => {
  for (const typed of ['08012345678', '0801 234 5678', '0801-234-5678', '2348012345678', '+2348012345678', '(0801) 234 5678']) {
    assert.equal(normalisePhone(typed), '+2348012345678', typed);
    assert.equal(signupProblems({ ...valid, phone: typed }).phone, undefined, typed);
  }
});

test('a number that is not a mobile number is refused, not mangled', () => {
  for (const typed of ['12345', '0123', 'not a number', '+234']) {
    assert.ok(signupProblems({ ...valid, phone: typed }).phone, typed);
  }
});

test('a short password is caught before the backend refuses it', () => {
  assert.ok(signupProblems({ ...valid, password: 'short' }).password);
  assert.equal(signupProblems({ ...valid, password: 'x'.repeat(MIN_PASSWORD_LENGTH) }).password, undefined);
});

test('the body sent is the one the backend expects', () => {
  assert.deepEqual(registrationBody({ ...valid, email: '  Ada@Example.COM ' }), {
    role: 'CLIENT',
    email: 'ada@example.com',
    phone: '+2348012345678',
    password: 'a long enough phrase',
    displayName: 'Ada Obi',
  });
  const artistBody = registrationBody({ ...valid, role: 'ARTIST', name: ' DJ Spinall ' }) as { stageName?: string };
  assert.equal(artistBody.stageName, 'DJ Spinall');
});

test('admins land on admin screens, everyone else on their bookings', () => {
  assert.equal(homeFor('SUPER_ADMIN'), '/admin/bookings');
  assert.equal(homeFor('CLIENT'), '/bookings');
  assert.equal(homeFor('ARTIST'), '/bookings');
  assert.equal(homeFor(null), '/bookings');
});

// The backend is authoritative. These read its rules from source so the form
// can never accept what the API will refuse, or refuse what it accepts.
const authSource = () =>
  fs.readFileSync(path.resolve(import.meta.dirname, '../../../backend/src/routes/auth.ts'), 'utf8');

test('the password length matches the backend', () => {
  const match = authSource().match(/const MIN_PASSWORD_LENGTH\s*=\s*(\d+)/);
  assert.ok(match, 'MIN_PASSWORD_LENGTH not found in routes/auth.ts');
  assert.equal(MIN_PASSWORD_LENGTH, Number(match![1]));
});

test('every phone the form accepts, the backend accepts', () => {
  const match = authSource().match(/const E164_PATTERN\s*=\s*\/(.+)\/;/);
  assert.ok(match, 'E164_PATTERN not found in routes/auth.ts');
  const backend = new RegExp(match![1]);
  for (const typed of ['08012345678', '07031234567', '09091234567', '2348012345678']) {
    assert.ok(backend.test(normalisePhone(typed)), `the backend would refuse ${normalisePhone(typed)}`);
  }
});
