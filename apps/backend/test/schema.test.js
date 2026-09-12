/**
 * Schema guarantees — docs/01-DATA-MODEL.md.
 *
 * These exercise the constraints the money paths depend on, against a real
 * database. Skipped when DATABASE_URL is absent so the suite still runs where
 * no database is configured.
 */

// Loaded here rather than relying on the server entry point, so the suite can
// reach the database without booting the app.
// Must be first: binds this file to its own schema before the Prisma
// singleton is constructed.
const { prisma, hasDatabase, ready } = require('./db')('schema');

const test = require('node:test');
const assert = require('node:assert/strict');

const describe = hasDatabase ? test : test.skip;

// The schema is emptied before anything runs, so a rerun behaves like a first run.
test.before(async () => { if (ready) await ready; });

const TIER_SET = [
  { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
  { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
  { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
  { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
];

let seq = 0;
const uniq = (p) => `${p}_${Date.now()}_${seq++}`;

async function makeBooking(overrides = {}) {
  const user = await prisma.user.create({
    data: {
      email: `${uniq('c')}@example.test`,
      phone: `+234${String(Date.now()).slice(-9)}${seq}`,
      passwordHash: 'x',
      role: 'CLIENT',
    },
  });
  const client = await prisma.client.create({
    data: { userId: user.id, displayName: 'Test Client' },
  });
  const artistUser = await prisma.user.create({
    data: {
      email: `${uniq('a')}@example.test`,
      phone: `+234${String(Date.now() + 1).slice(-9)}${seq}`,
      passwordHash: 'x',
      role: 'ARTIST',
    },
  });
  const artist = await prisma.artist.create({
    data: { userId: artistUser.id, stageName: 'Test Artist', baseRateKobo: 20000000 },
  });

  return prisma.booking.create({
    data: {
      clientId: client.id,
      artistId: artist.id,
      amountKobo: 20000000,
      eventDate: new Date(Date.now() + 7 * 86400000),
      eventEndAt: new Date(Date.now() + 7 * 86400000 + 3600000),
      escrowReference: uniq('esc_ref'),
      commissionRateBpsSnapshot: 500,
      cancellationTiersSnapshot: TIER_SET,
      ...overrides,
    },
  });
}

describe('escrowReference is unique — two escrows for one booking is unrecoverable', async () => {
  const booking = await makeBooking();
  await assert.rejects(
    () => makeBooking({ escrowReference: booking.escrowReference }),
    (err) => err.code === 'P2002',
    'a duplicate escrowReference must be rejected by the database'
  );
});

describe('WebhookEvent.providerEventId is unique — the idempotency guarantee', async () => {
  const eventId = uniq('evt');
  await prisma.webhookEvent.create({
    data: { providerEventId: eventId, eventType: 'escrow.funded', rawBody: '{}' },
  });

  // A provider retrying a delivery must not produce a second row. This
  // constraint is what makes "record before processing" safe.
  await assert.rejects(
    () =>
      prisma.webhookEvent.create({
        data: { providerEventId: eventId, eventType: 'escrow.funded', rawBody: '{}' },
      }),
    (err) => err.code === 'P2002'
  );
});

describe('CheckIn timestamp is server-set and cannot be supplied by a client', async () => {
  const booking = await makeBooking();
  const before = new Date();

  const checkIn = await prisma.checkIn.create({
    data: { bookingId: booking.id, redeemedByUser: 'artist-user-id' },
  });

  assert.ok(checkIn.redeemedAt >= new Date(before.getTime() - 1000));
  assert.ok(checkIn.redeemedAt <= new Date(Date.now() + 1000));
});

describe('the configuration snapshot survives a round trip intact', async () => {
  const booking = await makeBooking();
  const read = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });

  // Payout and cancellation math reads this, never live config (docs/07 §4).
  assert.equal(read.commissionRateBpsSnapshot, 500);
  assert.deepEqual(read.cancellationTiersSnapshot, TIER_SET);
  assert.equal(read.cancellationTiersSnapshot.length, 4);
});

describe('a completed booking reconciles to exactly zero in the ledger', async () => {
  const booking = await makeBooking();

  // The worked example from docs/01 §5 and docs/05 §3: ₦200,000 at 5%,
  // money-in capped at ₦2,000, money-out ₦70 → artist nets ₦187,930.
  const entries = [
    { entryType: 'FUNDED', party: 'CLIENT', amountKobo: -20000000 },
    { entryType: 'COMMISSION', party: 'PLATFORM', amountKobo: 1000000 },
    { entryType: 'ESCROW_FEE_IN', party: 'PROVIDER', amountKobo: 200000 },
    { entryType: 'ESCROW_FEE_OUT', party: 'PROVIDER', amountKobo: 7000 },
    { entryType: 'RELEASED', party: 'ARTIST', amountKobo: 18793000 },
  ];

  await prisma.ledgerEntry.createMany({
    data: entries.map((e) => ({ ...e, bookingId: booking.id })),
  });

  const sum = await prisma.ledgerEntry.aggregate({
    where: { bookingId: booking.id },
    _sum: { amountKobo: true },
  });

  assert.equal(sum._sum.amountKobo, 0, 'ledger entries must sum to zero');

  const released = await prisma.ledgerEntry.findFirstOrThrow({
    where: { bookingId: booking.id, entryType: 'RELEASED' },
  });
  assert.equal(released.amountKobo, 18793000, 'artist nets ₦187,930');
});

describe('state defaults to PENDING_PAYMENT', async () => {
  const booking = await makeBooking();
  assert.equal(booking.state, 'PENDING_PAYMENT');
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
