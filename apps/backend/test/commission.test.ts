/**
 * Versioned commission rate configuration — issue #7.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('commission');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const service = require('../src/services/commissionService.ts');

const describe = hasDatabase ? test : test.skip;

// The schema is emptied before anything runs, so a rerun behaves like a first run.
test.before(async () => { if (ready) await ready; });

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

async function makeUser(role: UserRole) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  const password = 'correct horse battery staple';
  const user = await prisma.user.create({
    data: {
      email: `comm${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(password),
      role,
    },
  });
  return { user, password };
}

async function withServer(fn: (server: TestServer) => Promise<void>) {
  const server = await startServer(createApp());
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

async function tokenFor(server: TestServer, role: UserRole) {
  const { user, password } = await makeUser(role);
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password }),
  });
  const { token } = ((await res.json()) as any);
  return { token, user };
}

const putRate = (server: TestServer, body?: unknown, token?: string) =>
  fetch(`${server.url}/admin/config/commission`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------

describe('a non-super-admin token receives 403 from the endpoint', async () => {
  await withServer(async (server: TestServer) => {
    for (const role of ['CLIENT', 'ARTIST', 'ADMIN']) {
      const { token } = await tokenFor(server, role);
      const res = await putRate(server, { rateBasisPoints: 700, reason: 'attempt' }, token);
      assert.equal(res.status, 403, `${role} must not be able to change the commission rate`);
    }

    // And with no token at all.
    assert.equal((await putRate(server, { rateBasisPoints: 700, reason: 'x' })).status, 401);

    // The guard is real, not a blanket refusal: SUPER_ADMIN succeeds.
    const { token } = await tokenFor(server, 'SUPER_ADMIN');
    assert.equal((await putRate(server, { rateBasisPoints: 700, reason: 'permitted' }, token)).status, 201);
  });
});

describe('changing the rate leaves the prior record intact and queryable', async () => {
  await withServer(async (server: TestServer) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');

    const first = ((await (await putRate(server, { rateBasisPoints: 500, reason: 'initial' }, token)).json()) as any);
    const second = ((await (await putRate(server, { rateBasisPoints: 700, reason: 'raise' }, token)).json()) as any);

    assert.notEqual(second.current.id, first.current.id, 'a change writes a NEW record');

    // The original row is untouched — not updated, not deleted.
    const original = await prisma.commissionRate.findUnique({ where: { id: first.current.id } });
    assert.ok(original, 'the prior record must remain queryable');
    assert.equal(original.rateBasisPoints, 500, 'and must still read 500, not 700');
  });
});

describe('the resolver returns the correct historical rate for a past timestamp', async () => {
  // The canonical test from issue #7: set 5%, change to 7%, query yesterday,
  // get 5% back.
  await withServer(async (server: TestServer) => {
    const { token, user } = await tokenFor(server, 'SUPER_ADMIN');

    // A dedicated timeline, so neighbouring suites cannot perturb it.
    const base = new Date('2030-01-01T00:00:00Z');
    const day = 86400000;

    await prisma.commissionRate.createMany({
      data: [
        { rateBasisPoints: 500, effectiveFrom: new Date(base.getTime()), setByUserId: user.id },
        { rateBasisPoints: 700, effectiveFrom: new Date(base.getTime() + 10 * day), setByUserId: user.id },
      ],
    });

    const dayBeforeChange = new Date(base.getTime() + 9 * day);
    const dayAfterChange = new Date(base.getTime() + 11 * day);

    assert.equal((await service.resolveCommissionRate(dayBeforeChange)).rateBasisPoints, 500);
    assert.equal((await service.resolveCommissionRate(dayAfterChange)).rateBasisPoints, 700);

    // Exactly at the boundary, the new rate is already in force — effectiveFrom
    // is inclusive.
    const atChange = new Date(base.getTime() + 10 * day);
    assert.equal((await service.resolveCommissionRate(atChange)).rateBasisPoints, 700);

    // One millisecond earlier, it is not.
    assert.equal(
      (await service.resolveCommissionRate(new Date(base.getTime() + 10 * day - 1))).rateBasisPoints,
      500
    );

    assert.equal(await service.resolveCommissionBps(dayBeforeChange), 500);

    void token;
  });
});

describe('a scheduled future rate does not take effect early', async () => {
  await withServer(async (server: TestServer) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');

    const nowRate = ((await (await putRate(server, { rateBasisPoints: 500, reason: 'now' }, token)).json()) as any);
    const future = new Date(Date.now() + 30 * 86400000);
    await putRate(server, { rateBasisPoints: 900, effectiveFrom: future.toISOString(), reason: 'scheduled' }, token);

    // Today still resolves to the current rate, not the scheduled one.
    const today = await service.resolveCommissionRate(new Date());
    assert.equal(today.rateBasisPoints, nowRate.current.rateBasisPoints);

    // And the scheduled one is in force once its time comes.
    const later = await service.resolveCommissionRate(new Date(future.getTime() + 1000));
    assert.equal(later.rateBasisPoints, 900);
  });
});

describe('an audit row exists naming the actor for every change', async () => {
  await withServer(async (server: TestServer) => {
    const { token, user } = await tokenFor(server, 'SUPER_ADMIN');

    await putRate(server, { rateBasisPoints: 500, reason: 'baseline' }, token);

    // Captured rather than assumed: other suites share this database, so the
    // record that is current at this instant is the only correct expectation
    // for `before`.
    const priorLatest = await prisma.commissionRate.findFirst({
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });

    const changed = ((await (
      await putRate(server, { rateBasisPoints: 650, reason: 'covering higher provider fees' }, token)
    ).json()) as any);

    const row = await prisma.auditLog.findFirst({
      where: { action: 'COMMISSION_RATE_CHANGED', entityId: changed.current.id },
    });

    assert.ok(row, 'every change must be attributable');
    assert.equal(row.actorUserId, user.id, 'the audit row names the actor');
    assert.equal(row.entityType, 'CommissionRate');
    assert.equal(row.reason, 'covering higher provider fees');
    // Both sides of the change are recorded, so the trail reconstructs.
    assert.equal(
      row.before.rateBasisPoints,
      priorLatest.rateBasisPoints,
      'before must reflect the record that was current at the time'
    );
    assert.equal(row.after.rateBasisPoints, 650);
  });
});

describe('the audit row and the rate record commit or fail together', async () => {
  await withServer(async (server: TestServer) => {
    const { user } = await tokenFor(server, 'SUPER_ADMIN');

    const before = await prisma.commissionRate.count();

    // actorUserId violates the foreign key, so the audit insert fails. Because
    // both writes share a transaction, the rate record must roll back too — a
    // configuration change that cannot be attributed must not happen at all.
    await assert.rejects(() =>
      service.setCommissionRate({
        rateBasisPoints: 800,
        actorUserId: 'user-that-does-not-exist',
        reason: 'should roll back',
      })
    );

    assert.equal(await prisma.commissionRate.count(), before, 'no orphaned rate record');
    void user;
  });
});

describe('rates are validated as whole basis points, never floats', async () => {
  await withServer(async (server: TestServer) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');

    const rejected = [
      [{ rateBasisPoints: 5.5, reason: 'r' }, 'a fractional basis point'],
      [{ rateBasisPoints: '500', reason: 'r' }, 'a numeric string'],
      [{ rateBasisPoints: -1, reason: 'r' }, 'a negative rate'],
      [{ rateBasisPoints: 10001, reason: 'r' }, 'over 100%'],
      [{ rateBasisPoints: null, reason: 'r' }, 'null'],
      [{ reason: 'r' }, 'a missing rate'],
    ];

    for (const [body, label] of rejected) {
      const res = await putRate(server, body, token);
      assert.equal(res.status, 400, `${label} must be rejected`);
      assert.deepEqual(Object.keys(((await res.json()) as any)), ['error']);
    }

    // 0% and 100% are the permitted extremes, not errors.
    assert.equal((await putRate(server, { rateBasisPoints: 0, reason: 'zero' }, token)).status, 201);
    assert.equal((await putRate(server, { rateBasisPoints: 10000, reason: 'max' }, token)).status, 201);
  });
});

describe('a change requires a written reason, and cannot be backdated', async () => {
  await withServer(async (server: TestServer) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');

    assert.equal((await putRate(server, { rateBasisPoints: 600 }, token)).status, 400);
    assert.equal((await putRate(server, { rateBasisPoints: 600, reason: '   ' }, token)).status, 400);

    // Forward-only. Backdating would rewrite what the resolver reports for
    // moments that have already passed — the audit trail changing its own
    // history.
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const res = await putRate(server, { rateBasisPoints: 600, effectiveFrom: yesterday, reason: 'backdate' }, token);
    assert.equal(res.status, 400);
    assert.match((((await res.json()) as any)).error, /past/i);
  });
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
