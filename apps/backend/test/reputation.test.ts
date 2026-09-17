/**
 * The cancellation rate — issue #35, docs/06 §6.
 *
 * Two rules make this statistic fair rather than merely available: a rolling
 * window, and a minimum booking count before it is shown at all. Both of those
 * are about NOT publishing a figure, which is what most of this file tests.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('reputation');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const reputation = require('../src/services/reputationService.ts');
const bookingService = require('../src/services/bookingService.ts');

const describe = hasDatabase ? test : test.skip;

const PASSWORD = 'correct horse battery staple';

let server: TestServer;

test.before(async () => {
  if (ready) await ready;
  server = await startServer(createApp());
});

test.after(async () => {
  if (server) await server.close();
});

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;
const N = (naira: number) => naira * 100;

function tierSetFor<T>(tiers: T[]): (T & { versionId: string })[] {
  const versionId = `v_${uniq()}`;
  return tiers.map((t) => ({ ...t, versionId }));
}

const DEFAULT_TIERS = [
  { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
  { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
  { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
  { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
];

async function makeUser(role: UserRole) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  return prisma.user.create({
    data: {
      email: `rep${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

async function seedConfig() {
  const admin = await makeUser('SUPER_ADMIN');
  await prisma.commissionRate.create({
    data: { rateBasisPoints: 500, effectiveFrom: new Date(), setByUserId: admin.id },
  });
  await prisma.cancellationTier.createMany({
    data: tierSetFor(DEFAULT_TIERS).map((t: any) => ({
      ...t,
      effectiveFrom: new Date(),
      setByUserId: admin.id,
    })),
  });
  return admin;
}

async function makeArtist() {
  const user = await makeUser('ARTIST');
  const artist = await prisma.artist.create({
    data: {
      userId: user.id,
      stageName: `Artist ${uniq()}`,
      category: 'Afrobeats',
      location: 'Lagos',
      baseRateKobo: N(200000),
      profileComplete: true,
    },
  });
  return { user, artist };
}

async function makeClient() {
  const user = await makeUser('CLIENT');
  const client = await prisma.client.create({
    data: { userId: user.id, displayName: `Client ${uniq()}` },
  });
  return { user, client };
}

/**
 * A booking that concluded, with the outcome dated where we want it.
 *
 * Written directly rather than driven through the whole flow: this file is
 * about the arithmetic of the window and the threshold, and driving twelve
 * cancellations through the provider to test a percentage would be testing
 * something else.
 */
async function concluded({
  artistId,
  clientId,
  outcome,
  concludedAt,
  cancelledBy = null,
  reclassified = false,
}: {
  artistId: string;
  clientId: string;
  outcome: 'RELEASED' | 'CANCELLED' | 'REFUNDED' | 'RESOLVED';
  concludedAt: Date;
  cancelledBy?: 'CLIENT' | 'ARTIST' | null;
  reclassified?: boolean;
}) {
  const booking = await prisma.booking.create({
    data: {
      clientId,
      artistId,
      amountKobo: N(200000),
      eventDate: new Date(concludedAt.getTime() - 86400000),
      eventEndAt: new Date(concludedAt.getTime() - 82800000),
      escrowReference: `bk_${uniq()}`,
      commissionRateBpsSnapshot: 500,
      cancellationTiersSnapshot: DEFAULT_TIERS as unknown as import('@prisma/client').Prisma.InputJsonValue,
      state: outcome,
      ...(outcome === 'CANCELLED'
        ? { cancelledAt: concludedAt }
        : outcome === 'REFUNDED'
          ? { refundedAt: concludedAt }
          : { releasedAt: concludedAt }),
    },
  });

  if (cancelledBy) {
    const user =
      cancelledBy === 'CLIENT'
        ? (await prisma.client.findUnique({ where: { id: clientId } })).userId
        : (await prisma.artist.findUnique({ where: { id: artistId } })).userId;

    await prisma.cancellation.create({
      data: {
        bookingId: booking.id,
        initiatedBy: cancelledBy,
        initiatedByUserId: user,
        daysBeforeEvent: 2,
        appliedTier: {} as unknown as import('@prisma/client').Prisma.InputJsonValue,
        clientRefundKobo: 0,
        artistCompensationKobo: 0,
        escrowFeesKobo: 0,
        feeBearer: cancelledBy,
        reclassifiedAsArtistFault: reclassified,
      },
    });
  }

  return booking;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);

async function login(email: string) {
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return ((await res.json()) as any).token as string;
}

const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

// ---------------------------------------------------------------------------
// Criterion: one cancelled booking out of one shows no stat, not "100%"
// ---------------------------------------------------------------------------

describe('one cancelled booking out of one publishes nothing, not 100%', async () => {
  const { user: artistUser, artist } = await makeArtist();
  const { client } = await makeClient();

  await concluded({
    artistId: artist.id,
    clientId: client.id,
    outcome: 'CANCELLED',
    concludedAt: daysAgo(10),
    cancelledBy: 'ARTIST',
  });

  const result = await reputation.rateFor({ userId: artistUser.id, party: 'ARTIST' });

  // "100% cancellation rate" on someone with one cancelled booking is not
  // information, it is noise presented as a verdict.
  assert.equal(result.rate, null);
  assert.equal(result.belowThreshold, true);
  assert.equal(result.concluded, 1);

  // AND IT IS NULL, NOT ZERO. Zero would imply a perfect record that has not
  // been earned; the distinction is the whole point of docs/06 §6.
  assert.notEqual(result.rate, 0);

  // Through the API too, where the frontend reads it.
  const detail = await call('GET', `/artists/${artist.id}`);
  assert.equal(detail.body.artist.cancellationRate, null);
  assert.ok('cancellationRate' in detail.body.artist, 'the field must be present, never omitted');
});

describe('at the threshold the figure appears, and it is a whole percent', async () => {
  const { user: artistUser, artist } = await makeArtist();
  const { client } = await makeClient();

  // Five bookings, one cancelled by the artist → 20%.
  for (let i = 0; i < 4; i++) {
    await concluded({
      artistId: artist.id,
      clientId: client.id,
      outcome: 'RELEASED',
      concludedAt: daysAgo(10 + i),
    });
  }
  await concluded({
    artistId: artist.id,
    clientId: client.id,
    outcome: 'CANCELLED',
    concludedAt: daysAgo(20),
    cancelledBy: 'ARTIST',
  });

  const result = await reputation.rateFor({ userId: artistUser.id, party: 'ARTIST' });

  assert.equal(result.concluded, 5);
  assert.equal(result.cancelled, 1);
  assert.equal(result.rate, 20);
  assert.equal(result.belowThreshold, false);

  // A rate rendered to one decimal invites a precision the sample size does not
  // support.
  assert.ok(Number.isInteger(result.rate));
});

// ---------------------------------------------------------------------------
// Criterion: a cancellation older than the window is excluded
// ---------------------------------------------------------------------------

describe('a cancellation older than the window is excluded entirely', async () => {
  const { user: artistUser, artist } = await makeArtist();
  const { client } = await makeClient();

  // Five recent, clean bookings.
  for (let i = 0; i < 5; i++) {
    await concluded({
      artistId: artist.id,
      clientId: client.id,
      outcome: 'RELEASED',
      concludedAt: daysAgo(10 + i),
    });
  }

  // And a cancellation from fourteen months ago.
  await concluded({
    artistId: artist.id,
    clientId: client.id,
    outcome: 'CANCELLED',
    concludedAt: daysAgo(430),
    cancelledBy: 'ARTIST',
  });

  const result = await reputation.rateFor({ userId: artistUser.id, party: 'ARTIST' });

  // AN ARTIST WHO HAD A BAD YEAR AND THEN IMPROVED SHOULD NOT CARRY IT
  // INDEFINITELY. A lifetime statistic gives no path back and stops measuring
  // current reliability, which is the only thing a client wants to know.
  assert.equal(result.concluded, 5, 'the old booking is still in the denominator');
  assert.equal(result.cancelled, 0);
  assert.equal(result.rate, 0);
});

test('the window boundary is computed in months, not an approximation of them', () => {
  const at = new Date('2026-09-17T12:00:00Z');

  assert.equal(reputation.windowStart(12, at).toISOString(), '2025-09-17T12:00:00.000Z');
  assert.equal(reputation.windowStart(6, at).toISOString(), '2026-03-17T12:00:00.000Z');
  assert.equal(reputation.windowStart(1, at).toISOString(), '2026-08-17T12:00:00.000Z');
});

describe('in-flight bookings are excluded from the denominator', async () => {
  const { user: artistUser, artist } = await makeArtist();
  const { client } = await makeClient();

  for (let i = 0; i < 5; i++) {
    await concluded({
      artistId: artist.id,
      clientId: client.id,
      outcome: 'RELEASED',
      concludedAt: daysAgo(10 + i),
    });
  }
  await concluded({
    artistId: artist.id,
    clientId: client.id,
    outcome: 'CANCELLED',
    concludedAt: daysAgo(5),
    cancelledBy: 'ARTIST',
  });

  // Ten bookings still in flight. A booking whose outcome is unknown is not
  // evidence either way, and counting it would let someone dilute their rate
  // simply by making bookings.
  for (let i = 0; i < 10; i++) {
    await prisma.booking.create({
      data: {
        clientId: client.id,
        artistId: artist.id,
        amountKobo: N(200000),
        eventDate: new Date(Date.now() + 30 * 86400000),
        eventEndAt: new Date(Date.now() + 30 * 86400000 + 3600_000),
        escrowReference: `bk_${uniq()}`,
        commissionRateBpsSnapshot: 500,
        cancellationTiersSnapshot: DEFAULT_TIERS as unknown as import('@prisma/client').Prisma.InputJsonValue,
        state: 'FUNDED_HELD',
      },
    });
  }

  const result = await reputation.rateFor({ userId: artistUser.id, party: 'ARTIST' });
  assert.equal(result.concluded, 6);
  assert.equal(result.rate, 17); // 1/6 = 16.67, rounded
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

describe('a reclassified cancellation counts against the artist, not the client', async () => {
  const { user: artistUser, artist } = await makeArtist();
  const { user: clientUser, client } = await makeClient();

  for (let i = 0; i < 4; i++) {
    await concluded({
      artistId: artist.id,
      clientId: client.id,
      outcome: 'RELEASED',
      concludedAt: daysAgo(10 + i),
    });
  }

  // The client cancelled — but #29 ruled it was the artist's doing.
  await concluded({
    artistId: artist.id,
    clientId: client.id,
    outcome: 'CANCELLED',
    concludedAt: daysAgo(3),
    cancelledBy: 'CLIENT',
    reclassified: true,
  });

  // THE ENTIRE POINT OF #29. Leaving it on the client's record would publish a
  // statistic the platform has already ruled is wrong.
  const artistRate = await reputation.rateFor({ userId: artistUser.id, party: 'ARTIST' });
  assert.equal(artistRate.cancelled, 1);
  assert.equal(artistRate.rate, 20);

  const clientRate = await reputation.rateFor({ userId: clientUser.id, party: 'CLIENT' });
  assert.equal(clientRate.cancelled, 0, 'the reclassified cancellation still counts against them');
  assert.equal(clientRate.rate, 0);
});

describe('a booking that ended without a cancellation counts against nobody', async () => {
  const { user: artistUser, artist } = await makeArtist();
  const { user: clientUser, client } = await makeClient();

  // A refund from an uncontradicted no-show, and a dispute — both concluded,
  // neither a cancellation. They belong in the denominator: they happened.
  for (let i = 0; i < 3; i++) {
    await concluded({
      artistId: artist.id,
      clientId: client.id,
      outcome: 'RELEASED',
      concludedAt: daysAgo(10 + i),
    });
  }
  await concluded({
    artistId: artist.id,
    clientId: client.id,
    outcome: 'REFUNDED',
    concludedAt: daysAgo(4),
  });
  await concluded({
    artistId: artist.id,
    clientId: client.id,
    outcome: 'RESOLVED',
    concludedAt: daysAgo(2),
  });

  assert.equal((await reputation.rateFor({ userId: artistUser.id, party: 'ARTIST' })).concluded, 5);
  assert.equal((await reputation.rateFor({ userId: artistUser.id, party: 'ARTIST' })).rate, 0);
  assert.equal((await reputation.rateFor({ userId: clientUser.id, party: 'CLIENT' })).rate, 0);
});

// ---------------------------------------------------------------------------
// Criterion: artists see the client stat
// ---------------------------------------------------------------------------

describe('an artist sees the client’s rate on their booking, and the client does not', async () => {
  await seedConfig();
  const { user: artistUser, artist } = await makeArtist();
  const { user: clientUser, client } = await makeClient();

  // Give the client a publishable record: five concluded, two cancelled.
  for (let i = 0; i < 3; i++) {
    await concluded({
      artistId: artist.id,
      clientId: client.id,
      outcome: 'RELEASED',
      concludedAt: daysAgo(10 + i),
    });
  }
  for (let i = 0; i < 2; i++) {
    await concluded({
      artistId: artist.id,
      clientId: client.id,
      outcome: 'CANCELLED',
      concludedAt: daysAgo(20 + i),
      cancelledBy: 'CLIENT',
    });
  }

  const booking = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo: N(200000),
    eventDate: new Date(Date.now() + 30 * 86400000),
  });

  // MIRRORED — docs/06 §7. An artist deciding whether to hold a date deserves
  // the same signal a client gets before booking one.
  const asArtist = await call('GET', `/bookings/${booking.id}`, await login(artistUser.email));
  assert.equal(asArtist.body.clientCancellationRate, 40);

  // The client does not see their own. It is a nudge, not something they can
  // act on in that moment.
  const asClient = await call('GET', `/bookings/${booking.id}`, await login(clientUser.email));
  assert.equal(asClient.body.clientCancellationRate, undefined);
});

// ---------------------------------------------------------------------------
// Criterion: changing the threshold changes display eligibility, no deploy
// ---------------------------------------------------------------------------

describe('changing the threshold changes who has a published rate, with no deploy', async () => {
  const { user: artistUser, artist } = await makeArtist();
  const { client } = await makeClient();

  // Three concluded bookings, one cancelled — below the default threshold of 5.
  for (let i = 0; i < 2; i++) {
    await concluded({
      artistId: artist.id,
      clientId: client.id,
      outcome: 'RELEASED',
      concludedAt: daysAgo(10 + i),
    });
  }
  await concluded({
    artistId: artist.id,
    clientId: client.id,
    outcome: 'CANCELLED',
    concludedAt: daysAgo(15),
    cancelledBy: 'ARTIST',
  });

  assert.equal((await reputation.rateFor({ userId: artistUser.id, party: 'ARTIST' })).rate, null);

  const superAdmin = await makeUser('SUPER_ADMIN');
  const token = await login(superAdmin.email);

  const published = await call('PUT', '/admin/config/reputation', token, {
    windowMonths: 12,
    minBookings: 3,
  });
  assert.equal(published.status, 201);

  // The SAME running process, no restart.
  const after = await reputation.rateFor({ userId: artistUser.id, party: 'ARTIST' });
  assert.equal(after.rate, 33);
  assert.equal(after.belowThreshold, false);

  // And narrowing the window changes it again.
  await call('PUT', '/admin/config/reputation', token, { windowMonths: 1, minBookings: 1 });
  const narrowed = await reputation.rateFor({ userId: artistUser.id, party: 'ARTIST' });
  assert.equal(narrowed.concluded, 3, 'everything here is within a month');
});

test('a threshold of zero is refused, because it publishes a verdict on one booking', () => {
  const { setReputationConfig } = reputation;

  return Promise.all([
    assert.rejects(
      () => setReputationConfig({ windowMonths: 12, minBookings: 0, actorUserId: 'u' }),
      /publishes a verdict on a single booking/
    ),
    assert.rejects(
      () => setReputationConfig({ windowMonths: 0, minBookings: 5, actorUserId: 'u' }),
      /whole number of months/
    ),
    assert.rejects(
      () => setReputationConfig({ windowMonths: 12.5, minBookings: 5, actorUserId: 'u' }),
      /whole number of months/
    ),
  ]);
});

describe('only a super-admin may change the window or the threshold', async () => {
  const body = { windowMonths: 6, minBookings: 2 };

  for (const role of ['CLIENT', 'ARTIST', 'ADMIN'] as UserRole[]) {
    const user = await makeUser(role);
    const token = await login(user.email);
    assert.equal(
      (await call('PUT', '/admin/config/reputation', token, body)).status,
      403,
      `${role} changed the reputation settings`
    );
  }
});

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

describe('the listing computes every rate in one pass', async () => {
  const artists = [];
  const { client } = await makeClient();

  for (let a = 0; a < 3; a++) {
    const made = await makeArtist();
    artists.push(made);
    for (let i = 0; i < 5; i++) {
      await concluded({
        artistId: made.artist.id,
        clientId: client.id,
        outcome: i === 0 && a === 1 ? 'CANCELLED' : 'RELEASED',
        concludedAt: daysAgo(10 + i),
        ...(i === 0 && a === 1 ? { cancelledBy: 'ARTIST' as const } : {}),
      });
    }
  }

  const listed = await call('GET', '/artists?limit=50');
  assert.equal(listed.status, 200);

  const byId = new Map(listed.body.artists.map((a: any) => [a.id, a.cancellationRate]));
  assert.equal(byId.get(artists[0].artist.id), 0);
  assert.equal(byId.get(artists[1].artist.id), 20);
  assert.equal(byId.get(artists[2].artist.id), 0);

  // Present on every row, never omitted.
  for (const row of listed.body.artists) {
    assert.ok('cancellationRate' in row);
  }
});
