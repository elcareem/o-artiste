/**
 * Development seed — issue #6.
 *
 * Seeds test accounts and, more importantly, the default platform
 * configuration.
 *
 * The commission rate and the cancellation tier table are seeded as
 * CONFIGURATION RECORDS, not constants in code. That is the point of doing it
 * here: it establishes from day one that they are data, so no later issue is
 * tempted to hardcode 5% somewhere and quietly diverge from the versioned
 * record that payout math is supposed to read (docs/07 §3).
 *
 * IDEMPOTENT. Re-running produces identical state — every write is guarded by
 * an existence check rather than an upsert, because an upsert still issues an
 * UPDATE and would move `updatedAt` on every run. "Identical state" is the
 * acceptance criterion, so nothing may be written twice.
 *
 *   node prisma/seed.js
 */

require('dotenv').config();

const prisma = require('../src/lib/prisma');
const { hashPassword } = require('../src/lib/auth');

// EscrowPay's transaction range — docs/00 §4. Seeded rates must sit inside it,
// or the booking they produce could never be funded.
const MIN_RATE_KOBO = 2000000; // ₦20,000
const MAX_RATE_KOBO = 300000000; // ₦3,000,000

const SEED_PASSWORD = 'seed password not for production';

/** Deterministic ids, so a second run recognises what the first created. */
const COMMISSION_RATE_ID = 'seed_commission_rate_v1';
const TIER_VERSION_ID = 'seed_cancellation_tiers_v1';

const DEFAULT_COMMISSION_BPS = 500; // 5%

/**
 * The default tier set — docs/05 §5.
 *
 * Bands are inclusive at both ends. `maxDaysBefore: null` is the open-ended top
 * band. Contiguous from day 0 upward with no gaps and no overlaps: a gap would
 * mean a booking cancelled in that window has no applicable rule, and there is
 * no safe default — refunding everything harms the artist, refunding nothing is
 * FCCPA exposure.
 */
const DEFAULT_TIERS = [
  { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
  { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
  { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
  { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
];

const USERS = [
  {
    email: 'super@artist-escrow.test',
    phone: '+2348000000001',
    role: 'SUPER_ADMIN',
  },
  {
    email: 'admin@artist-escrow.test',
    phone: '+2348000000002',
    role: 'ADMIN',
  },
  {
    email: 'ada@artist-escrow.test',
    phone: '+2348000000003',
    role: 'CLIENT',
    client: { displayName: 'Ada Obi' },
  },
  {
    email: 'chidi@artist-escrow.test',
    phone: '+2348000000004',
    role: 'CLIENT',
    client: { displayName: 'Chidi Nwosu' },
  },
  {
    email: 'tolu@artist-escrow.test',
    phone: '+2348000000005',
    role: 'ARTIST',
    artist: {
      stageName: 'Tolu Live',
      bio: 'Afrobeats vocalist and band leader.',
      category: 'Afrobeats',
      location: 'Lagos',
      baseRateKobo: 25000000, // ₦250,000
      profileComplete: true,
    },
  },
  {
    email: 'ekene@artist-escrow.test',
    phone: '+2348000000006',
    role: 'ARTIST',
    artist: {
      stageName: 'DJ Ekene',
      bio: 'Wedding and corporate event DJ.',
      category: 'DJ',
      location: 'Abuja',
      baseRateKobo: 5000000, // ₦50,000
      profileComplete: true,
    },
  },
];

async function seedUsers() {
  const passwordHash = await hashPassword(SEED_PASSWORD);
  const created = [];

  for (const spec of USERS) {
    const existing = await prisma.user.findUnique({ where: { email: spec.email } });
    if (existing) {
      created.push(existing);
      continue;
    }

    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email: spec.email,
          phone: spec.phone,
          passwordHash,
          role: spec.role,
          // Test clients and artists are pre-verified so later phases have
          // something to work against without running the provider flow.
          // Admins are not: they never transact.
          ...(spec.client || spec.artist
            ? {
                verificationStatus: 'VERIFIED',
                verificationMethod: 'NIN',
                verifiedAt: new Date('2026-01-01T00:00:00Z'),
                // The RESULT of the check, never the identifier itself —
                // retaining a NIN or BVN is NDPR exposure with no operational
                // benefit (docs/02 §6).
                verificationReference: `seed_verification_${spec.role.toLowerCase()}`,
              }
            : {}),
        },
      });

      // The profile row is created in the same transaction as the user, so a
      // half-seeded account cannot exist.
      if (spec.client) await tx.client.create({ data: { userId: u.id, ...spec.client } });
      if (spec.artist) await tx.artist.create({ data: { userId: u.id, ...spec.artist } });

      return u;
    },
    // Prisma's 5s default is tuned for a request handler, not a seed. This one
    // may run against a managed database over the public internet during a
    // deploy, or against a local database under test-suite contention, and
    // failing halfway through leaves a partially seeded state.
    { timeout: 30000 });

    created.push(user);
  }

  return created;
}

async function seedCommissionRate(setByUserId) {
  const existing = await prisma.commissionRate.findUnique({ where: { id: COMMISSION_RATE_ID } });
  if (existing) return existing;

  return prisma.commissionRate.create({
    data: {
      id: COMMISSION_RATE_ID,
      rateBasisPoints: DEFAULT_COMMISSION_BPS,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      setByUserId,
    },
  });
}

async function seedCancellationTiers(setByUserId) {
  const existing = await prisma.cancellationTier.findMany({
    where: { versionId: TIER_VERSION_ID },
  });
  if (existing.length > 0) return existing;

  return prisma.$transaction(
    DEFAULT_TIERS.map((tier, index) =>
      prisma.cancellationTier.create({
        data: {
          id: `${TIER_VERSION_ID}_${index}`,
          versionId: TIER_VERSION_ID,
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          setByUserId,
          ...tier,
        },
      })
    )
  );
}

/**
 * Refuses to seed a rate the escrow provider could never process. Catching it
 * here rather than at checkout means the failure surfaces where the number was
 * chosen, not where a client tries to pay it.
 */
function assertRatesAreFundable() {
  for (const spec of USERS) {
    const rate = spec.artist?.baseRateKobo;
    if (rate === undefined) continue;
    if (rate < MIN_RATE_KOBO || rate > MAX_RATE_KOBO) {
      throw new Error(
        `${spec.artist.stageName}: rate ${rate} kobo is outside the permitted ` +
          `₦20,000–₦3,000,000 range and could never be funded.`
      );
    }
  }
}

async function main() {
  assertRatesAreFundable();

  const users = await seedUsers();
  const superAdmin = users.find((u) => u.role === 'SUPER_ADMIN');

  // Configuration is attributed to the super-admin, because that is who would
  // have set it. An audit trail with no actor is not an audit trail.
  const rate = await seedCommissionRate(superAdmin.id);
  const tiers = await seedCancellationTiers(superAdmin.id);

  console.log(`[seed] users            ${users.length}`);
  console.log(`[seed] commission rate  ${rate.rateBasisPoints} bps`);
  console.log(`[seed] cancellation tiers ${tiers.length} rows, version ${TIER_VERSION_ID}`);
  console.log('[seed] done');
}

// Only self-executes when run as a script. Required as a module — by tests, or
// by a future bootstrap — it exports `main` instead, so the seed can run
// in-process against an already-open client rather than spawning a second
// process with its own connection pool.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[seed] failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = {
  main,
  USERS,
  SEED_EMAILS: USERS.map((u) => u.email),
  DEFAULT_TIERS,
  DEFAULT_COMMISSION_BPS,
  SEED_PASSWORD,
  COMMISSION_RATE_ID,
  TIER_VERSION_ID,
  MIN_RATE_KOBO,
  MAX_RATE_KOBO,
};
