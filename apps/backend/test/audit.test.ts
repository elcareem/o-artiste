/**
 * Audit trail for rejected privilege escalation — docs/07-ADMIN-CONFIG.md §5.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('audit');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');

const describe = hasDatabase ? test : test.skip;

// The schema is emptied before anything runs, so a rerun behaves like a first run.
test.before(async () => { if (ready) await ready; });

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

const creds = (role = 'CLIENT') => {
  const n = uniq();
  return {
    email: `audit${n}@example.test`,
    phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
    password: 'correct horse battery staple',
    role,
  };
};

async function withServer(fn: (server: TestServer) => Promise<void>) {
  const server = await startServer(createApp());
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

const post = (s, p, b) =>
  fetch(`${s.url}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });

/** The write is best-effort and therefore asynchronous; give it a moment. */
async function waitForAudit(where, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const row = await prisma.auditLog.findFirst({ where, orderBy: { createdAt: 'desc' } });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe('an attempt to self-assign SUPER_ADMIN is recorded in the audit log', async () => {
  await withServer(async (server: TestServer) => {
    const attempt = { ...creds(), role: 'SUPER_ADMIN' };

    const res = await post(server, '/auth/register', attempt);
    assert.equal(res.status, 403);

    const row = await waitForAudit({
      action: 'REGISTRATION_ROLE_REJECTED',
      entityId: attempt.email.toLowerCase(),
    });

    assert.ok(row, 'the rejected attempt must leave an audit row');
    assert.equal(row.entityType, 'Registration');
    assert.equal(row.after.attemptedRole, 'SUPER_ADMIN');
    // No authenticated actor — this is exactly the case the nullable column
    // exists for.
    assert.equal(row.actorUserId, null);
    assert.ok(row.actorIp, 'the only identifying signal available is captured');
    assert.ok(row.reason);

    // And still no account.
    assert.equal(await prisma.user.findUnique({ where: { email: attempt.email } }), null);
  });
});

describe('an authenticated user reaching above their level is recorded, naming them', async () => {
  await withServer(async (server: TestServer) => {
    const c = creds('CLIENT');
    const { token, user } = ((await (await post(server, '/auth/register', c)).json()) as any);

    const res = await fetch(`${server.url}/admin/config/commission`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ rateBasisPoints: 700, reason: 'test' }),
    });
    assert.equal(res.status, 403);

    const row = await waitForAudit({ action: 'ROLE_DENIED', actorUserId: user.id });

    assert.ok(row, 'the denial must leave an audit row');
    // This one HAS an actor — an account we can name, which is what makes it
    // more significant than the anonymous case.
    assert.equal(row.actorUserId, user.id);
    assert.equal(row.entityType, 'Endpoint');
    assert.match(row.entityId, /PUT \/admin\/config\/commission/);
    assert.equal(row.after.held, 'CLIENT');
    assert.deepEqual(row.after.required, ['SUPER_ADMIN']);
  });
});

describe('a permitted request writes no denial row', async () => {
  await withServer(async (server: TestServer) => {
    const { hashPassword } = require('../src/lib/auth.ts');
    const c = creds('SUPER_ADMIN');
    await prisma.user.create({
      data: {
        email: c.email,
        phone: c.phone,
        passwordHash: await hashPassword(c.password),
        role: 'SUPER_ADMIN',
      },
    });

    const { token, user } = ((await (
      await post(server, '/auth/login', { email: c.email, password: c.password })
    ).json()) as any);

    const res = await fetch(`${server.url}/admin/config/commission`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);

    await new Promise((r) => setTimeout(r, 200));
    const rows = await prisma.auditLog.count({
      where: { action: 'ROLE_DENIED', actorUserId: user.id },
    });
    assert.equal(rows, 0, 'success must not be logged as a denial');
  });
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
