/**
 * Seed script guarantees — issue #6.
 */

const { prisma, hasDatabase } = require('./db')('seed');

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const seedModule = require('../prisma/seed');

const describe = hasDatabase ? test : test.skip;

const BACKEND_ROOT = path.resolve(__dirname, '..');

function runSeed() {
  // The seed runs as a subprocess, so it must be handed this file's schema
  // explicitly — otherwise it would seed the default schema and the
  // assertions here would measure a different database entirely.
  execFileSync('node', ['prisma/seed.js'], {
    cwd: BACKEND_ROOT,
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
}

/**
 * A complete fingerprint of everything the seed writes, including every
 * timestamp. If a second run touches a single row, `updatedAt` moves and this
 * changes — which is the whole point.
 */
async function snapshot() {
  const [users, clients, artists, rates, tiers] = await Promise.all([
    prisma.user.findMany({ orderBy: { email: 'asc' } }),
    prisma.client.findMany({ orderBy: { userId: 'asc' } }),
    prisma.artist.findMany({ orderBy: { userId: 'asc' } }),
    prisma.commissionRate.findMany({ orderBy: { id: 'asc' } }),
    prisma.cancellationTier.findMany({ orderBy: { id: 'asc' } }),
  ]);
  return JSON.stringify({ users, clients, artists, rates, tiers });
}

describe('running the seed twice produces identical database state', async () => {
  runSeed();
  const first = await snapshot();

  runSeed();
  const second = await snapshot();

  // Not merely "no duplicates" — byte-identical, timestamps included. An
  // upsert would satisfy a row count but still move updatedAt on every run.
  assert.equal(second, first, 'a second seed run must write nothing at all');
});

describe('seeded accounts cover every role, with transacting users pre-verified', async () => {
  runSeed();

  // Absolute, whole-table assertions. Possible again because this file owns
  // its schema: no other suite can add a user here. Before isolation these had
  // to be scoped to known seed emails, which measured the right thing but
  // depended on remembering to do it.
  const byRole = async (role) => prisma.user.findMany({ where: { role } });

  assert.equal((await byRole('SUPER_ADMIN')).length, 1);
  assert.equal((await byRole('ADMIN')).length, 1);

  const clients = await byRole('CLIENT');
  const artists = await byRole('ARTIST');
  assert.equal(clients.length, 2);
  assert.equal(artists.length, 2);

  for (const user of [...clients, ...artists]) {
    assert.equal(user.verificationStatus, 'VERIFIED', `${user.email} is pre-verified`);
    // The result of the check is stored, never the NIN or BVN itself.
    assert.ok(user.verificationReference);
    assert.match(user.verificationReference, /^seed_verification_/);
  }

  // Admins never transact, so they are deliberately not verified.
  for (const user of [...(await byRole('ADMIN')), ...(await byRole('SUPER_ADMIN'))]) {
    assert.equal(user.verificationStatus, 'UNVERIFIED');
  }

  // Every seeded account has its profile row — no half-seeded users.
  for (const c of clients) {
    assert.ok(await prisma.client.findUnique({ where: { userId: c.id } }));
  }
  for (const a of artists) {
    assert.ok(await prisma.artist.findUnique({ where: { userId: a.id } }));
  }
});

describe('seeded artist rates fall within the EscrowPay transaction range', async () => {
  runSeed();
  const { MIN_RATE_KOBO, MAX_RATE_KOBO } = seedModule;

  // ₦20,000 – ₦3,000,000. A rate outside this could never be funded at all.
  assert.equal(MIN_RATE_KOBO, 2000000);
  assert.equal(MAX_RATE_KOBO, 300000000);

  const artists = await prisma.artist.findMany();
  assert.equal(artists.length, 2);

  for (const artist of artists) {
    assert.ok(Number.isInteger(artist.baseRateKobo), 'rate is an integer number of kobo');
    assert.ok(
      artist.baseRateKobo >= MIN_RATE_KOBO && artist.baseRateKobo <= MAX_RATE_KOBO,
      `${artist.stageName}: ${artist.baseRateKobo} kobo is outside the fundable range`
    );
  }
});

describe('the default commission rate is a configuration record, not a constant', async () => {
  runSeed();

  const rates = await prisma.commissionRate.findMany();
  assert.equal(rates.length, 1);
  assert.equal(rates[0].rateBasisPoints, 500, '5% expressed in basis points');
  assert.ok(Number.isInteger(rates[0].rateBasisPoints), 'never a float percentage');

  // Attributed to the super-admin — an audit trail with no actor is not one.
  const setter = await prisma.user.findUniqueOrThrow({ where: { id: rates[0].setByUserId } });
  assert.equal(setter.role, 'SUPER_ADMIN');
});

describe('the default tier set has no gaps or overlaps in its day ranges', async () => {
  runSeed();

  const tiers = await prisma.cancellationTier.findMany({ orderBy: { minDaysBefore: 'asc' } });
  assert.equal(tiers.length, 4);

  // Every row's two percentages must reconcile to the whole booking.
  for (const tier of tiers) {
    assert.equal(
      tier.clientRefundBps + tier.artistCompensationBps,
      10000,
      `band starting at day ${tier.minDaysBefore} must sum to 10000 bps`
    );
  }

  // Day 0 must be covered: a booking cancelled on the day has to resolve.
  assert.equal(tiers[0].minDaysBefore, 0);

  // Exactly one open-ended top band, and it is the last one.
  const openEnded = tiers.filter((t) => t.maxDaysBefore === null);
  assert.equal(openEnded.length, 1);
  assert.equal(openEnded[0], tiers[tiers.length - 1]);

  // Contiguous with no gap and no overlap: each band starts exactly where the
  // previous one ended. A gap means a cancellation in that window has no
  // applicable rule, and there is no safe default.
  for (let i = 1; i < tiers.length; i++) {
    const previous = tiers[i - 1];
    const current = tiers[i];
    assert.equal(
      current.minDaysBefore,
      previous.maxDaysBefore + 1,
      `gap or overlap between day ${previous.maxDaysBefore} and day ${current.minDaysBefore}`
    );
  }

  // Every day from 0 to 30 resolves to exactly one band.
  for (let day = 0; day <= 30; day++) {
    const matching = tiers.filter(
      (t) => day >= t.minDaysBefore && (t.maxDaysBefore === null || day <= t.maxDaysBefore)
    );
    assert.equal(matching.length, 1, `day ${day} must match exactly one band, matched ${matching.length}`);
  }
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
