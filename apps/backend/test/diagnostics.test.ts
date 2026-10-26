/**
 * Deployment visibility — issue #41.
 *
 * `/health` answered `ok` while the deployed API could not issue a session
 * token to anyone, and again while it had no provider credentials at all. Both
 * lasted days. A health check that reports only that a process is listening
 * will report `ok` for a service that cannot do any of its work.
 */

process.env.QUEUE_PREFIX = `test-diag-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('diagnostics');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const queueLib = require('../src/lib/queue.ts');

const hasRedis = Boolean(process.env.REDIS_URL);
const describe = hasDatabase ? test : test.skip;

const PASSWORD = 'correct horse battery staple';

let server: TestServer;

// The fee check compares our constants with the provider's published prices.
// These tests are about diagnostics, not about today's prices, so the provider
// is the simulator's copy of its configuration — a live price change must fail
// feeSchedule.test.ts, not every test here.
const escrowpay = require('../src/lib/escrowpay.ts');
const { FEE_CONFIGURATION } = require('../e2e/provider-simulator.ts');
const realFeeConfiguration = escrowpay.feeConfiguration;

test.before(async () => {
  if (ready) await ready;
  escrowpay.feeConfiguration = async () => JSON.parse(JSON.stringify(FEE_CONFIGURATION));
  server = await startServer(createApp());
});

test.after(async () => {
  escrowpay.feeConfiguration = realFeeConfiguration;
  if (server) await server.close();
  if (hasRedis) await queueLib.closeAll();
});

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

async function makeUser(role: UserRole) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  return prisma.user.create({
    data: {
      email: `dg${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
    },
  });
}

async function login(email: string) {
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return ((await res.json()) as any).token as string;
}

const get = async (path: string, token?: string) => {
  const res = await fetch(`${server.url}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json()) as any };
};

// ---------------------------------------------------------------------------

describe('/health says which build is running, so a deploy is verifiable', async () => {
  const saved = process.env.RENDER_GIT_COMMIT;
  process.env.RENDER_GIT_COMMIT = 'abcdef1234567890';

  try {
    // Re-required so the payload picks up the variable; the module caches only
    // its boot time, not the commit.
    const { healthPayload } = require('../src/lib/version.ts');
    const payload = healthPayload();

    assert.equal(payload.status, 'ok');
    assert.equal(payload.commit, 'abcdef1', 'the commit is shortened to 7 characters');
    assert.ok(payload.version);
    assert.ok(payload.startedAt);
    assert.ok(Number.isInteger(payload.uptimeSeconds));
  } finally {
    if (saved === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = saved;
  }

  // Over HTTP, unauthenticated, as a monitor would.
  const res = await get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');

  // And it gives nothing away beyond the build.
  const text = JSON.stringify(res.body);
  assert.doesNotMatch(text, /postgres|redis|secret|key|password|MISSING/i);
});

describe('/health stays public — a monitor has no token', async () => {
  const res = await get('/health');
  assert.equal(res.status, 200);
});

describe('/admin/diagnostics reports whether the dependencies actually answer', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const res = await get('/admin/diagnostics', token);
  const { diagnostics } = res.body;

  assert.ok(diagnostics.build.commit !== undefined);

  // A real query, not a connection test: a pool can hold an open socket to a
  // database that has stopped answering.
  assert.equal(diagnostics.database.ok, true, diagnostics.database.detail);
  assert.match(diagnostics.database.detail, /booking\(s\)/);
  assert.ok(Number.isInteger(diagnostics.database.latencyMs));

  if (hasRedis) {
    assert.equal(diagnostics.queue.ok, true, diagnostics.queue.detail);
    // A queue with no consumer accepts jobs and runs none of them, which looks
    // healthy from every angle except the one that matters.
    assert.match(diagnostics.queue.detail, /worker\(s\) attached/);
    assert.equal(res.status, 200);
  }
});

describe('configuration is reported as present or absent, never by value', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const res = await get('/admin/diagnostics', token);
  const { configuration } = res.body.diagnostics;

  assert.ok(configuration.JWT_SECRET.startsWith('set'));
  assert.match(configuration.JWT_SECRET, /\d+ chars/, 'length is the defence, so it is reported');

  // THE ACTUAL SECRETS MUST NOT BE IN THE RESPONSE. An endpoint that echoes a
  // signing key to whoever holds an admin token has replaced one problem with
  // a worse one.
  const text = JSON.stringify(res.body);
  for (const name of [
    'JWT_SECRET',
    'DATABASE_URL',
    'ESCROWPAY_WEBHOOK_SECRET',
    'REDIS_URL',
  ] as const) {
    const value = process.env[name];
    if (!value) continue;
    assert.ok(!text.includes(value), `${name}'s value is in the response body`);
  }

  // The API key is shown by PREFIX ONLY — sk_test_ versus sk_live_ decides
  // which book the money moves in, and confusing them is the most consequential
  // configuration mistake available here.
  if (process.env.ESCROWPAY_API_KEY) {
    assert.ok(!text.includes(process.env.ESCROWPAY_API_KEY));
    assert.match(configuration.ESCROWPAY_API_KEY, /^set \(sk_(test|live)_…\)$/);
  }
});

describe('a missing variable is named as MISSING rather than quietly absent', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const saved = process.env.ESCROWPAY_WEBHOOK_SECRET;
  delete process.env.ESCROWPAY_WEBHOOK_SECRET;

  try {
    const res = await get('/admin/diagnostics', token);
    assert.equal(res.body.diagnostics.configuration.ESCROWPAY_WEBHOOK_SECRET, 'MISSING');
  } finally {
    if (saved !== undefined) process.env.ESCROWPAY_WEBHOOK_SECRET = saved;
  }
});

describe('a broken dependency answers 503, so a monitor can see it', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const prismaLib = require('../src/lib/prisma.ts');
  const original = prismaLib.booking.count;
  prismaLib.booking.count = async () => {
    throw new Error('connection terminated unexpectedly');
  };

  try {
    const res = await get('/admin/diagnostics', token);

    assert.equal(res.status, 503, 'a failing dependency must not answer 200');
    assert.equal(res.body.diagnostics.database.ok, false);
    assert.match(res.body.diagnostics.database.detail, /connection terminated/);
  } finally {
    prismaLib.booking.count = original;
  }
});

describe('a provider price change answers 503 and says what changed', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const stub = escrowpay.feeConfiguration;
  escrowpay.feeConfiguration = async () => {
    const changed = JSON.parse(JSON.stringify(FEE_CONFIGURATION));
    changed.find((f: any) => f.fee_type === 'identity_verification_nin').fixed_minor = 9000;
    return changed;
  };

  try {
    const res = await get('/admin/diagnostics', token);
    assert.equal(res.status, 503, 'prices we no longer charge correctly are a failure');
    assert.equal(res.body.diagnostics.feeSchedule.ok, false);
    assert.match(res.body.diagnostics.feeSchedule.drift.join('\n'), /identity_verification_nin: we record ₦80; the provider charges ₦90/);
  } finally {
    escrowpay.feeConfiguration = stub;
  }
});

describe('diagnostics are closed to everyone below ADMIN', async () => {
  for (const role of ['CLIENT', 'ARTIST'] as UserRole[]) {
    const user = await makeUser(role);
    const token = await login(user.email);
    const res = await get('/admin/diagnostics', token);
    assert.equal(res.status, 403, `${role} reached the diagnostics`);
  }

  const anonymous = await get('/admin/diagnostics');
  assert.equal(anonymous.status, 401);
  assert.doesNotMatch(JSON.stringify(anonymous.body), /MISSING|postgres|redis/i);
});
