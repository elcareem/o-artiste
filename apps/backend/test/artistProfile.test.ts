/**
 * Artist profile and rate card — issue #11.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('artistprofile');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const service = require('../src/services/artistService.ts');
const { MIN_TRANSACTION_KOBO, MAX_TRANSACTION_KOBO } = require('../src/lib/escrowpay.ts');

const describe = hasDatabase ? test : test.skip;

test.before(async () => {
  if (ready) await ready;
});

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;
const PASSWORD = 'correct horse battery staple';

async function makeArtist({ verified = true, standing = 'GOOD' } = {}) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  const user = await prisma.user.create({
    data: {
      email: `artist${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role: 'ARTIST',
      verificationStatus: verified ? 'VERIFIED' : 'UNVERIFIED',
      accountStanding: standing,
      ...(verified ? { verifiedAt: new Date(), escrowPartyId: `PAR_${n}` } : {}),
    },
  });
  const artist = await prisma.artist.create({
    data: { userId: user.id, stageName: `Artist ${n}` },
  });
  return { user, artist };
}

async function withServer(fn: (server: TestServer) => Promise<void>) {
  const server = await startServer(createApp());
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

async function login(server: TestServer, email: string) {
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (((await res.json()) as any)).token;
}

const putProfile = (server: TestServer, artistId: string, body?: unknown, token?: string) =>
  fetch(`${server.url}/artists/${artistId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------

describe('a rate of ₦19,999 or ₦3,000,001 returns 400 naming the permitted range', async () => {
  await withServer(async (server: TestServer) => {
    const { user, artist } = await makeArtist();
    const token = await login(server, user.email);

    // Exactly one kobo outside each bound — the boundary, not a wild value.
    for (const [kobo, label] of [
      [MIN_TRANSACTION_KOBO - 1, '₦19,999.99'],
      [1999900, '₦19,999'],
      [MAX_TRANSACTION_KOBO + 1, '₦3,000,000.01'],
      [300000100, '₦3,000,001'],
    ]) {
      const res = await putProfile(server, artist.id, { baseRateKobo: kobo }, token);
      assert.equal(res.status, 400, `${label} must be rejected`);

      const { error } = ((await res.json()) as any);
      // The message must NAME the limit. "Invalid rate" leaves an artist
      // guessing at a bound they have no way to discover.
      assert.match(error, /₦20,000/, `${label}: message must state the floor`);
      assert.match(error, /₦3,000,000/, `${label}: message must state the ceiling`);
    }

    // Both bounds themselves are accepted — inclusive, not exclusive.
    for (const kobo of [MIN_TRANSACTION_KOBO, MAX_TRANSACTION_KOBO]) {
      const res = await putProfile(server, artist.id, { baseRateKobo: kobo }, token);
      assert.equal(res.status, 200, `${kobo} kobo is inside the range`);
    }
  });
});

describe('an artist editing another artist’s profile receives 403', async () => {
  await withServer(async (server: TestServer) => {
    const alice = await makeArtist();
    const bob = await makeArtist();

    const aliceToken = await login(server, alice.user.email);

    const res = await putProfile(server, bob.artist.id, { stageName: 'Hijacked' }, aliceToken);
    assert.equal(res.status, 403);

    // Refused, and nothing changed — a 403 that still wrote would be worse
    // than no check at all.
    const unchanged = await prisma.artist.findUniqueOrThrow({ where: { id: bob.artist.id } });
    assert.equal(unchanged.stageName, bob.artist.stageName);

    // No token at all.
    assert.equal((await putProfile(server, bob.artist.id, { stageName: 'x' })).status, 401);

    // A CLIENT cannot reach the endpoint either.
    const { hashPassword } = require('../src/lib/auth.ts');
    const n = uniq();
    const client = await prisma.user.create({
      data: {
        email: `client${n}@example.test`,
        phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
        passwordHash: await hashPassword(PASSWORD),
        role: 'CLIENT',
      },
    });
    const clientToken = await login(server, client.email);
    assert.equal((await putProfile(server, bob.artist.id, { stageName: 'x' }, clientToken)).status, 403);
  });
});

describe('the rate is stored and returned as a kobo integer, never a formatted string', async () => {
  await withServer(async (server: TestServer) => {
    const { user, artist } = await makeArtist();
    const token = await login(server, user.email);

    const res = await putProfile(server, artist.id, { baseRateKobo: 25000000 }, token);
    const body = ((await res.json()) as any);

    assert.equal(body.artist.baseRateKobo, 25000000);
    assert.equal(typeof body.artist.baseRateKobo, 'number');
    assert.ok(Number.isInteger(body.artist.baseRateKobo));

    // No Naira formatting anywhere in the payload — that is the web app's job.
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes('₦'), 'the API must never format currency');
    assert.ok(!serialised.includes('250,000'), 'no thousands separators either');

    const stored = await prisma.artist.findUniqueOrThrow({ where: { id: artist.id } });
    assert.equal(stored.baseRateKobo, 25000000);
  });
});

describe('non-integer and non-numeric rates are refused', async () => {
  await withServer(async (server: TestServer) => {
    const { user, artist } = await makeArtist();
    const token = await login(server, user.email);

    for (const bad of [25000000.5, '25000000', null, true, {}]) {
      const res = await putProfile(server, artist.id, { baseRateKobo: bad }, token);
      // null clears the rate, which is allowed; the rest are not numbers.
      if (bad === null) {
        assert.equal(res.status, 200, 'clearing the rate is permitted');
        continue;
      }
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`);
    }
  });
});

describe('a profile becomes complete only when every required field is set', async () => {
  await withServer(async (server: TestServer) => {
    const { user, artist } = await makeArtist();
    const token = await login(server, user.email);

    assert.deepEqual(service.REQUIRED_FOR_COMPLETE, [
      'stageName',
      'category',
      'location',
      'baseRateKobo',
    ]);

    let body = ((await (await putProfile(server, artist.id, { category: 'Afrobeats' }, token)).json()) as any);
    assert.equal(body.artist.profileComplete, false, 'still missing location and rate');

    body = ((await (await putProfile(server, artist.id, { location: 'Lagos' }, token)).json()) as any);
    assert.equal(body.artist.profileComplete, false, 'still missing the rate');

    body = ((await (await putProfile(server, artist.id, { baseRateKobo: 5000000 }, token)).json()) as any);
    assert.equal(body.artist.profileComplete, true);
    assert.equal(body.listable, true);

    // Clearing a required field makes it incomplete again.
    body = ((await (await putProfile(server, artist.id, { baseRateKobo: null }, token)).json()) as any);
    assert.equal(body.artist.profileComplete, false);
    assert.equal(body.listable, false);
  });
});

describe('incomplete, unverified and suspended artists are not listable', async () => {
  const complete = { category: 'DJ', location: 'Abuja', baseRateKobo: 5000000 };

  // Complete but UNVERIFIED.
  const unverified = await makeArtist({ verified: false });
  await prisma.artist.update({
    where: { id: unverified.artist.id },
    data: { ...complete, profileComplete: true },
  });
  assert.equal(await service.isListable(unverified.artist.id), false, 'unverified must not list');

  // Complete, verified, but SUSPENDED — a suspended artist appearing even
  // briefly is a trust failure (docs/06 §5).
  const suspended = await makeArtist({ standing: 'SUSPENDED' });
  await prisma.artist.update({
    where: { id: suspended.artist.id },
    data: { ...complete, profileComplete: true },
  });
  assert.equal(await service.isListable(suspended.artist.id), false, 'suspended must not list');

  // Verified and in good standing but INCOMPLETE.
  const incomplete = await makeArtist();
  assert.equal(await service.isListable(incomplete.artist.id), false, 'incomplete must not list');

  // All three conditions met.
  const listable = await makeArtist();
  await prisma.artist.update({
    where: { id: listable.artist.id },
    data: { ...complete, profileComplete: true },
  });
  assert.equal(await service.isListable(listable.artist.id), true);
});

describe('the validator is pure and usable without a request', async () => {
  assert.equal(service.validateBaseRate(MIN_TRANSACTION_KOBO), MIN_TRANSACTION_KOBO);
  assert.equal(service.validateBaseRate(null), null);
  assert.throws(() => service.validateBaseRate(MIN_TRANSACTION_KOBO - 1), /₦20,000/);
  assert.throws(() => service.validateBaseRate(MAX_TRANSACTION_KOBO + 1), /₦3,000,000/);
  assert.throws(() => service.validateBaseRate(5.5), /whole number/);
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
