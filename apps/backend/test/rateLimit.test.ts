/**
 * Rate limiting — issue #41.
 *
 * The rest of the suite runs with RATE_LIMITS=off because it creates dozens of
 * accounts from one address in seconds. This file turns them back on.
 */

process.env.RATE_LIMITS = 'on';
// A prefix of our own, so counters from a previous run — Redis persists — can
// never make this file pass or fail on its own history.
process.env.QUEUE_PREFIX = `test-ratelimit-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('ratelimit');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, trustProxyHops } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const rateLimit = require('../src/lib/rateLimit.ts');

const describe = hasDatabase && process.env.REDIS_URL ? test : test.skip;

let server: TestServer;
test.before(async () => {
  if (ready) await ready;
  server = await startServer(createApp());
});
test.after(async () => {
  if (server) await server.close();
  await rateLimit.closeRateLimit();
});

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;
const PASSWORD = 'correct horse battery staple';

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any, retryAfter: res.headers.get('retry-after') };
};

// ---------------------------------------------------------------------------

describe('sign-in is limited per address and account, and says so plainly', async () => {
  const email = `rl${uniq()}@example.test`;

  for (let i = 0; i < 10; i++) {
    const r = await post('/auth/login', { email, password: 'wrong password entirely' });
    assert.equal(r.status, 401, `attempt ${i + 1} should be an ordinary wrong-password 401`);
  }

  const blocked = await post('/auth/login', { email, password: 'wrong password entirely' });
  assert.equal(blocked.status, 429);
  // The same error shape as everything else, written for a person.
  assert.match(blocked.body.error, /Too many sign-in attempts/);
  assert.doesNotMatch(blocked.body.error, /429|rate.?limit/i);
  assert.ok(Number(blocked.retryAfter) > 0, 'no Retry-After header');

  // A DIFFERENT ACCOUNT from the same address is unaffected. Keyed on the pair,
  // so an attacker cannot lock a victim out by exhausting a limit from
  // elsewhere, nor exhaust a shared one to lock everyone out.
  const other = await post('/auth/login', { email: `other${uniq()}@example.test`, password: 'x'.repeat(20) });
  assert.equal(other.status, 401);
});

describe('the sign-in key ignores case and spacing in the email', async () => {
  const base = `Case${uniq()}@Example.test`;
  for (let i = 0; i < 10; i++) {
    // Alternating spellings of ONE account.
    const spelled = i % 2 ? base.toLowerCase() : `  ${base.toUpperCase()} `;
    await post('/auth/login', { email: spelled, password: 'wrong password entirely' });
  }
  const r = await post('/auth/login', { email: base, password: 'wrong password entirely' });
  assert.equal(r.status, 429, 'capitalisation gave a fresh allowance');
});

describe('registration is limited per address', async () => {
  const address = { 'x-forwarded-for': `203.0.113.${(seq % 200) + 1}` };
  void address;

  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const n = uniq();
    const r = await post('/auth/register', {
      email: `reg${n}@example.test`,
      phone: `+23481${String(n).slice(-8).padStart(8, '0')}`,
      password: PASSWORD,
      role: 'CLIENT',
    });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 5), [201, 201, 201, 201, 201]);
  assert.equal(statuses[5], 429, `the sixth account in an hour was allowed: ${statuses.join(',')}`);
});

describe('check-in attempts are limited per artist and booking', async () => {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  const artistUser = await prisma.user.create({
    data: {
      email: `rlart${n}@example.test`,
      phone: `+23482${String(n).slice(-8).padStart(8, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role: 'ARTIST',
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
    },
  });
  const login = await post('/auth/login', { email: artistUser.email, password: PASSWORD });
  const auth = { authorization: `Bearer ${login.body.token}` };

  // A booking id that does not exist: every attempt is a 404, which is exactly
  // what guessing at codes or ids looks like. The limit counts attempts, not
  // successes.
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    statuses.push((await post('/bookings/clnope00000000000000000000/check-in', { code: 'ABCD-EFGH' }, auth)).status);
  }
  assert.ok(statuses.slice(0, 10).every((s) => s !== 429), `limited too early: ${statuses.join(',')}`);
  assert.equal(statuses[10], 429);

  // Another booking has its own allowance — an artist with two events that
  // night is not blocked from the second by a fumble on the first.
  const other = await post('/bookings/clother0000000000000000000/check-in', { code: 'ABCD-EFGH' }, auth);
  assert.notEqual(other.status, 429);
});

describe('the counter is atomic and windowed', async () => {
  const name = `unit${uniq()}`;
  const results = await Promise.all(Array.from({ length: 8 }, () => rateLimit.hit(name, 'k', 5, 60)));

  // Eight concurrent hits, limit five: exactly five allowed. A read-then-write
  // counter lets a burst through, which is the shape a brute-force run takes.
  assert.equal(results.filter((r: any) => r.allowed).length, 5);
  assert.ok(results.every((r: any) => r.retryAfter > 0 && r.retryAfter <= 61));
});

describe('a Redis outage fails OPEN, so nobody is locked out by it', async () => {
  const savedUrl = process.env.REDIS_URL;
  await rateLimit.closeRateLimit();
  process.env.REDIS_URL = 'redis://127.0.0.1:1'; // nothing listens there

  try {
    const mw = rateLimit.rateLimit({
      name: 'outage',
      limit: 1,
      windowSeconds: 60,
      key: () => 'someone',
      message: 'limited',
    });

    for (let i = 0; i < 3; i++) {
      let passedWith: unknown = 'not called';
      const started = Date.now();
      await mw({}, { set() {} }, (err?: unknown) => {
        passedWith = err;
      });
      // Through, with no error — and quickly. A limiter that waits on a dead
      // Redis turns an outage into every sign-in timing out.
      assert.equal(passedWith, undefined, 'the request was blocked by a Redis outage');
      assert.ok(Date.now() - started < 3000, 'waited on a dead Redis');
    }
  } finally {
    await rateLimit.closeRateLimit();
    process.env.REDIS_URL = savedUrl;
  }
});

describe('the off switch works locally and is ignored on Render', async () => {
  const saved = { limits: process.env.RATE_LIMITS, render: process.env.RENDER };
  try {
    process.env.RATE_LIMITS = 'off';
    delete process.env.RENDER;
    assert.equal(rateLimit.limitsDisabled(), true);

    // A variable left set in a deploy must not quietly remove brute-force
    // protection from sign-in.
    process.env.RENDER = 'true';
    assert.equal(rateLimit.limitsDisabled(), false);
  } finally {
    process.env.RATE_LIMITS = saved.limits;
    if (saved.render === undefined) delete process.env.RENDER;
    else process.env.RENDER = saved.render;
  }
});

// ---------------------------------------------------------------------------
// Who is calling — the precondition for any of the above meaning anything
// ---------------------------------------------------------------------------

describe('the proxy is trusted on Render and nowhere else by default', async () => {
  const saved = { hops: process.env.TRUST_PROXY_HOPS, render: process.env.RENDER };
  try {
    delete process.env.TRUST_PROXY_HOPS;

    delete process.env.RENDER;
    assert.equal(trustProxyHops(), 0, 'trusting a proxy that is not there lets callers set their own IP');

    process.env.RENDER = 'true';
    assert.equal(trustProxyHops(), 1, 'behind Render every caller would share the proxy address');
    assert.equal(createApp().get('trust proxy'), 1);

    process.env.TRUST_PROXY_HOPS = '2';
    assert.equal(trustProxyHops(), 2, 'an explicit setting wins');

    process.env.TRUST_PROXY_HOPS = 'yes';
    assert.throws(() => trustProxyHops(), /whole number/);
  } finally {
    if (saved.hops === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = saved.hops;
    if (saved.render === undefined) delete process.env.RENDER;
    else process.env.RENDER = saved.render;
  }
});

describe('without a trusted proxy, a forged X-Forwarded-For does not buy a fresh allowance', async () => {
  // Locally there is no proxy, so the header is ignored — otherwise anyone could
  // rotate it to reset their own limit.
  const email = `forge${uniq()}@example.test`;
  for (let i = 0; i < 10; i++) {
    await post('/auth/login', { email, password: 'wrong password entirely' }, { 'x-forwarded-for': `198.51.100.${i}` });
  }
  const r = await post('/auth/login', { email, password: 'wrong password entirely' }, { 'x-forwarded-for': '198.51.100.250' });
  assert.equal(r.status, 429, 'a forged header reset the limit');
});
