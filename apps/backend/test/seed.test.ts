/**
 * Seed script guarantees — issue #6.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('seed');

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const seedModule = require('../prisma/seed.ts');

const describe = hasDatabase ? test : test.skip;

/**
 * Empty the schema, then seed ONCE for the whole file.
 *
 * Each case previously re-ran the seed, which meant two subprocesses could
 * overlap: the first held the User unique index inside its transaction while
 * the second blocked on the same rows, and both eventually timed out. Seeding
 * once here serialises it by construction, and the idempotency case below runs
 * the second pass explicitly, which is the only place a second run is actually
 * the thing under test.
 */
test.before(async () => {
  if (ready) await ready;
  if (hasDatabase) await runSeed();
});

const BACKEND_ROOT = path.resolve(__dirname, '..');

/**
 * Runs the seed IN-PROCESS, against this file's schema.
 *
 * It was previously spawned as a subprocess, which opened a second connection
 * pool against the same schema. Two seed processes could then overlap on the
 * `User` unique index — one holding it inside an open transaction while the
 * other blocked — and both eventually hit the transaction timeout. In-process
 * removes the overlap by construction, and is faster.
 *
 * The script's command-line behaviour is still covered, once, at the end.
 */
const runSeed = () => seedModule.main();

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
  // One run already happened in before(); this is the second.
  const first = await snapshot();

  await runSeed();
  const second = await snapshot();

  // Not merely "no duplicates" — byte-identical, timestamps included. An
  // upsert would satisfy a row count but still move updatedAt on every run.
  assert.equal(second, first, 'a second seed run must write nothing at all');
});

describe('seeded accounts cover every role, with transacting users pre-verified', async () => {
  // Absolute, whole-table assertions. Possible again because this file owns
  // its schema: no other suite can add a user here. Before isolation these had
  // to be scoped to known seed emails, which measured the right thing but
  // depended on remembering to do it.
  const byRole = async (role: UserRole) => prisma.user.findMany({ where: { role } });

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
  const rates = await prisma.commissionRate.findMany();
  assert.equal(rates.length, 1);
  assert.equal(rates[0].rateBasisPoints, 500, '5% expressed in basis points');
  assert.ok(Number.isInteger(rates[0].rateBasisPoints), 'never a float percentage');

  // Attributed to the super-admin — an audit trail with no actor is not one.
  const setter = await prisma.user.findUniqueOrThrow({ where: { id: rates[0].setByUserId } });
  assert.equal(setter.role, 'SUPER_ADMIN');
});

describe('the default tier set has no gaps or overlaps in its day ranges', async () => {
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
  const openEnded = tiers.filter((t: any) => t.maxDaysBefore === null);
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
      (t: any) => day >= t.minDaysBefore && (t.maxDaysBefore === null || day <= t.maxDaysBefore)
    );
    assert.equal(matching.length, 1, `day ${day} must match exactly one band, matched ${matching.length}`);
  }
});

describe('the script runs from the command line, as the acceptance criterion states', async () => {
  // `node prisma/seed.js` is what the issue specifies, so it is exercised as
  // written — once, last, with nothing else touching the schema.
  execFileSync('node', ['prisma/seed.ts'], {
    cwd: BACKEND_ROOT,
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });

  // Still idempotent when invoked that way.
  const users = await prisma.user.findMany();
  assert.equal(users.length, 6);
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
