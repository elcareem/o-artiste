/**
 * Failure copy — issue #39.
 *
 * The load-bearing test here is the leak guard. A user who sees `500` on a
 * payment screen does not think "transient bug", they think their money is gone,
 * and the paths that leak are by definition the paths nobody exercised — they
 * only run when something has already gone wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTHING,
  RETRY,
  emailProblem,
  failureMessage,
  isPresentable,
  koboProblem,
  missingFields,
  reasonProblem,
  thrownMessage,
  unreachable,
} from './error-messages.ts';

test('a connection failure says what happened to the money', () => {
  // "Could not reach the server" alone is the message that makes someone phone
  // their bank.
  assert.equal(
    unreachable(NOTHING.charged),
    'Could not reach the server. You have not been charged.'
  );
  assert.match(unreachable(NOTHING.moved), /No money has moved\./);
  assert.match(unreachable(RETRY), /Check your connection/);
});

test('nothing that looks like a stack trace is presentable', () => {
  const traces = [
    'TypeError: Cannot read properties of undefined (reading \'amountKobo\')',
    'Error: connect ECONNREFUSED 127.0.0.1:5432',
    '    at releaseBooking (/home/app/src/services/escrowService.ts:288:21)',
    'PrismaClientKnownRequestError: Invalid `prisma.booking.findUnique()` invocation',
  ];

  for (const trace of traces) {
    assert.equal(isPresentable(trace), false, trace);
  }
});

test('nothing containing an HTTP status code is presentable', () => {
  for (const text of [
    'Request failed with status code 500',
    'HTTP 502 Bad Gateway',
    '403 Forbidden',
    'The server returned 404.',
  ]) {
    assert.equal(isPresentable(text), false, text);
  }
});

test('a money amount that happens to contain those digits is still presentable', () => {
  // The status-code pattern must not reject real copy. ₦500 and "500 kobo" are
  // things a message legitimately says, and a guard that eats them would push
  // callers back to inlining their own strings.
  for (const text of [
    'Your rate must be at least ₦20,000.',
    'That is 500 kobo short of the amount held.',
    'A booking of ₦404 is below the minimum.',
  ]) {
    assert.equal(isPresentable(text), true, text);
  }
});

test('undefined, null and [object Object] never reach a screen', () => {
  for (const text of [
    'Could not cancel: undefined',
    'null is not a valid booking',
    'Failed: [object Object]',
  ]) {
    assert.equal(isPresentable(text), false, text);
  }
});

test('a filesystem path is not presentable', () => {
  assert.equal(isPresentable('Cannot find module /app/src/lib/escrowpay.ts'), false);
});

test('an empty, whitespace or non-string message is not presentable', () => {
  for (const value of ['', '   ', null, undefined, 42, {}, []]) {
    assert.equal(isPresentable(value), false, String(value));
  }
});

test('a message too long to be a sentence is not presentable', () => {
  assert.equal(isPresentable('x'.repeat(401)), false);
  assert.equal(isPresentable('A real message.'), true);
});

test('the backend\'s own words are used where they are usable', () => {
  // The unified error shape is deliberate and every message is hand-written for
  // a person. Rewording it here would produce two sets of copy for one
  // condition.
  assert.equal(
    failureMessage({ error: 'This check-in code has already been used.' }, 'fallback'),
    'This check-in code has already been used.'
  );
});

test('an unusable backend message falls back without showing the user anything raw', () => {
  for (const payload of [
    { error: 'TypeError: x is not a function' },
    { error: 'Request failed with status code 500' },
    { error: '' },
    { error: null },
    {},
    null,
    'not even an object',
  ]) {
    const shown = failureMessage(payload, 'Nothing has been saved.');
    assert.equal(shown, 'Nothing has been saved.', JSON.stringify(payload));
    assert.equal(isPresentable(shown), true);
  }
});

test('a thrown value never reaches the screen, whatever it is', () => {
  // The catch around a fetch can receive anything. The message is built from the
  // reassurance, and the thrown value is deliberately unread.
  const shown = thrownMessage(new TypeError('Failed to fetch'), NOTHING.recorded);
  assert.match(shown, /The check-in was not recorded\./);
  assert.equal(isPresentable(shown), true);
  assert.doesNotMatch(shown, /TypeError|fetch/);
});

// ---------------------------------------------------------------------------
// Criterion: empty required fields show INLINE messages, not a generic alert
// ---------------------------------------------------------------------------

test('each empty field gets its own message, named as the form names it', () => {
  const problems = missingFields({
    code: { value: '', label: 'The check-in code' },
    reason: { value: '   ', label: 'A reason' },
    amount: { value: '20000', label: 'Amount' },
  });

  // Per field, because the difference between this and one summary is whether
  // the user has to work out which field they missed.
  assert.deepEqual(Object.keys(problems).sort(), ['code', 'reason']);
  assert.equal(problems.code, 'The check-in code is needed.');
  assert.equal(problems.reason, 'A reason is needed.');
  assert.equal(problems.amount, undefined);
});

test('zero and false are not empty', () => {
  // A legitimate 0 must not be reported as missing.
  const problems = missingFields({
    kobo: { value: 0, label: 'Amount' },
    flag: { value: false, label: 'Flag' },
  });
  assert.deepEqual(problems, {});
});

test('null and undefined are empty', () => {
  const problems = missingFields({
    a: { value: null, label: 'A' },
    b: { value: undefined, label: 'B' },
  });
  assert.deepEqual(Object.keys(problems).sort(), ['a', 'b']);
});

test('a kobo field rejects what is not a whole number of kobo', () => {
  assert.equal(koboProblem('20000'), null);
  assert.match(koboProblem('') as string, /needed/);
  // `Number('')` is 0, so emptiness has to be checked first — a blank field
  // becoming ₦0 is the bug that turned a blank delay into "run now" in #36.
  assert.match(koboProblem('20.5') as string, /whole number/);
  assert.match(koboProblem('-1') as string, /whole number/);
  assert.match(koboProblem('abc') as string, /whole number/);
  assert.match(koboProblem('₦200') as string, /whole number/);
  assert.match(koboProblem('9'.repeat(20)) as string, /too large/);
});

test('a kobo field names itself in its message', () => {
  assert.match(koboProblem('', 'The client share') as string, /^The client share/);
});

test('an email field is loose rather than clever', () => {
  assert.equal(emailProblem('ada@example.com'), null);
  assert.equal(emailProblem('a+tag@sub.example.co.uk'), null);
  assert.match(emailProblem('') as string, /needed/);
  assert.match(emailProblem('ada') as string, /does not look like/);
  assert.match(emailProblem('ada@') as string, /does not look like/);
});

test('a written reason has to be long enough to be a reason', () => {
  assert.match(reasonProblem('') as string, /needed/);
  assert.match(reasonProblem('ok') as string, /more detail/);
  assert.equal(reasonProblem('The client confirmed by phone.'), null);
});

test('every message this module produces is itself presentable', () => {
  // The guard applied to our own copy. A fallback that fails the leak check
  // would be a screen with nothing safe to show at all.
  const all = [
    ...Object.values(NOTHING).map((n) => unreachable(n)),
    unreachable(RETRY),
    koboProblem(''),
    koboProblem('x'),
    emailProblem(''),
    emailProblem('nope'),
    reasonProblem(''),
    reasonProblem('ok'),
    ...Object.values(missingFields({ a: { value: '', label: 'A field' } })),
  ].filter((m): m is string => m !== null);

  for (const message of all) {
    assert.equal(isPresentable(message), true, message);
  }
});
