/**
 * Authentication, roles and permission middleware — issue #9.
 */

require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { createApp } = require('../src/app');
const { startServer } = require('./helpers');

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describe = hasDatabase ? test : test.skip;

let prisma;
if (hasDatabase) prisma = require('../src/lib/prisma');

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

function credentials(role = 'CLIENT') {
  const n = uniq();
  return {
    email: `user${n}@example.test`,
    phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
    password: 'correct horse battery staple',
    role,
  };
}

async function withServer(fn) {
  const server = await startServer(createApp());
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

const post = (server, path, body, token) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const put = (server, path, body, token) =>
  fetch(`${server.url}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const get = (server, path, token) =>
  fetch(`${server.url}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

/** Registers a user directly in the database with a role that is not public. */
async function seedPrivilegedUser(role) {
  const { hashPassword } = require('../src/lib/auth');
  const c = credentials(role);
  const user = await prisma.user.create({
    data: {
      email: c.email,
      phone: c.phone,
      passwordHash: await hashPassword(c.password),
      role,
    },
  });
  return { user, credentials: c };
}

// ---------------------------------------------------------------------------

describe('a registered user can log in and call GET /me', async () => {
  await withServer(async (server) => {
    const creds = credentials('CLIENT');

    const registered = await post(server, '/auth/register', creds);
    assert.equal(registered.status, 201);
    const registerBody = await registered.json();
    assert.ok(registerBody.token, 'registration returns a session token');

    const loggedIn = await post(server, '/auth/login', {
      email: creds.email,
      password: creds.password,
    });
    assert.equal(loggedIn.status, 200);
    const { token } = await loggedIn.json();

    const me = await get(server, '/me', token);
    assert.equal(me.status, 200);
    const body = await me.json();

    assert.equal(body.user.email, creds.email.toLowerCase());
    assert.equal(body.user.role, 'CLIENT');
    assert.equal(body.user.verificationStatus, 'UNVERIFIED');
    assert.ok(body.profile, 'the client profile was created alongside the user');
  });
});

describe('GET /me never returns the password hash or the verification reference', async () => {
  await withServer(async (server) => {
    const creds = credentials('ARTIST');
    const { token } = await (await post(server, '/auth/register', creds)).json();

    const body = await (await get(server, '/me', token)).json();
    const serialised = JSON.stringify(body);

    assert.ok(!('passwordHash' in body.user), 'passwordHash must never leave the process');
    assert.ok(!serialised.includes('$2a$'), 'no bcrypt hash anywhere in the payload');
    assert.ok(!('verificationReference' in body.user));
  });
});

describe('an expired or malformed token returns 401', async () => {
  await withServer(async (server) => {
    const creds = credentials('CLIENT');
    const { token } = await (await post(server, '/auth/register', creds)).json();

    // Genuinely expired, not merely wrong.
    const expired = jwt.sign({ sub: 'someone', role: 'CLIENT' }, process.env.JWT_SECRET, {
      expiresIn: '-1s',
    });
    const wrongSignature = jwt.sign({ sub: 'someone', role: 'SUPER_ADMIN' }, 'not-the-secret');

    const cases = [
      ['expired', expired],
      ['wrong signature', wrongSignature],
      ['malformed', 'not.a.jwt'],
      ['empty', ''],
      ['nonsense', 'Bearer-ish gibberish'],
    ];

    for (const [label, bad] of cases) {
      const res = await get(server, '/me', bad);
      assert.equal(res.status, 401, `${label} token must be rejected`);
      const body = await res.json();
      assert.deepEqual(Object.keys(body), ['error'], `${label}: unified error shape`);
    }

    // The valid one still works, so the above is not passing by accident.
    assert.equal((await get(server, '/me', token)).status, 200);
  });
});

describe('a token for a deleted user is rejected, not trusted on its claims', async () => {
  await withServer(async (server) => {
    const creds = credentials('CLIENT');
    const { token, user } = await (await post(server, '/auth/register', creds)).json();

    await prisma.client.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });

    // The token is still cryptographically valid. Middleware reads the live
    // row rather than the payload, so it fails anyway.
    assert.equal((await get(server, '/me', token)).status, 401);
  });
});

describe('each role is blocked from an endpoint above its level', async () => {
  await withServer(async (server) => {
    const clientCreds = credentials('CLIENT');
    const { token: clientToken } = await (await post(server, '/auth/register', clientCreds)).json();

    const admin = await seedPrivilegedUser('ADMIN');
    const { token: adminToken } = await (
      await post(server, '/auth/login', { email: admin.credentials.email, password: admin.credentials.password })
    ).json();

    const superAdmin = await seedPrivilegedUser('SUPER_ADMIN');
    const { token: superToken } = await (
      await post(server, '/auth/login', {
        email: superAdmin.credentials.email,
        password: superAdmin.credentials.password,
      })
    ).json();

    // CLIENT cannot reach an admin endpoint.
    assert.equal((await get(server, '/admin/ping', clientToken)).status, 403);

    // ADMIN can reach admin, and can READ the commission rate, but cannot
    // CHANGE it. Roles are matched exactly — SUPER_ADMIN is not "ADMIN plus
    // more" (docs/07 §1).
    assert.equal((await get(server, '/admin/ping', adminToken)).status, 200);
    assert.equal((await get(server, '/admin/config/commission', adminToken)).status, 200);
    assert.equal(
      (await put(server, '/admin/config/commission', { rateBasisPoints: 700, reason: 'test' }, adminToken)).status,
      403,
      'an ADMIN must not be able to change the platform take'
    );

    // SUPER_ADMIN reaches all three.
    assert.equal((await get(server, '/admin/ping', superToken)).status, 200);
    assert.equal((await get(server, '/admin/config/commission', superToken)).status, 200);

    // No token at all.
    assert.equal((await get(server, '/admin/ping')).status, 401);
  });
});

describe('there is NO public route by which an account can self-assign ADMIN or SUPER_ADMIN', async () => {
  await withServer(async (server) => {
    for (const role of ['ADMIN', 'SUPER_ADMIN']) {
      const creds = { ...credentials('CLIENT'), role };
      const res = await post(server, '/auth/register', creds);

      // Rejected outright, not silently downgraded — a silent downgrade hides
      // an attempt worth seeing.
      assert.equal(res.status, 403, `registering as ${role} must be refused`);

      const created = await prisma.user.findUnique({ where: { email: creds.email } });
      assert.equal(created, null, `no ${role} account may be created this way`);
    }

    // Nor by smuggling the role past registration in a different shape.
    const sneaky = { ...credentials('CLIENT'), role: ['CLIENT', 'SUPER_ADMIN'] };
    assert.equal((await post(server, '/auth/register', sneaky)).status, 403);

    // And a self-minted token claiming SUPER_ADMIN is worthless without the
    // signing key.
    const forged = jwt.sign({ sub: 'anyone', role: 'SUPER_ADMIN' }, 'guessed-secret');
    assert.equal((await get(server, '/admin/config/commission', forged)).status, 401);
  });
});

describe('registration validates its inputs and does not leak who holds an account', async () => {
  await withServer(async (server) => {
    const base = credentials('CLIENT');

    assert.equal((await post(server, '/auth/register', { ...base, email: 'nope' })).status, 400);
    assert.equal((await post(server, '/auth/register', { ...base, phone: '08012345678' })).status, 400);
    assert.equal((await post(server, '/auth/register', { ...base, password: 'short' })).status, 400);

    await post(server, '/auth/register', base);

    // Duplicate email and duplicate phone give the SAME message, so this
    // endpoint cannot be used to enumerate which addresses are registered.
    const dupEmail = await post(server, '/auth/register', { ...credentials('CLIENT'), email: base.email });
    const dupPhone = await post(server, '/auth/register', { ...credentials('CLIENT'), phone: base.phone });

    assert.equal(dupEmail.status, 409);
    assert.equal(dupPhone.status, 409);
    assert.equal((await dupEmail.json()).error, (await dupPhone.json()).error);
  });
});

describe('login is uninformative about which half was wrong, and blocks suspended accounts', async () => {
  await withServer(async (server) => {
    const creds = credentials('CLIENT');
    await post(server, '/auth/register', creds);

    const wrongPassword = await post(server, '/auth/login', { email: creds.email, password: 'wrong-password' });
    const noSuchUser = await post(server, '/auth/login', { email: `absent${uniq()}@example.test`, password: creds.password });

    assert.equal(wrongPassword.status, 401);
    assert.equal(noSuchUser.status, 401);
    assert.equal((await wrongPassword.json()).error, (await noSuchUser.json()).error);

    await prisma.user.update({
      where: { email: creds.email },
      data: { accountStanding: 'SUSPENDED' },
    });

    const suspended = await post(server, '/auth/login', { email: creds.email, password: creds.password });
    assert.equal(suspended.status, 403);
    // Clear and non-technical (docs/06 §5).
    assert.match((await suspended.json()).error, /suspended/i);
  });
});

describe('passwords are stored as bcrypt hashes, never in plaintext', async () => {
  await withServer(async (server) => {
    const creds = credentials('CLIENT');
    await post(server, '/auth/register', creds);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: creds.email } });

    assert.notEqual(stored.passwordHash, creds.password);
    assert.match(stored.passwordHash, /^\$2[aby]\$\d{2}\$/, 'a bcrypt hash');
    assert.equal(stored.passwordHash.split('$')[2], '12', 'cost factor 12');
  });
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
