/**
 * Booking creation with configuration snapshot — issue #15.
 *
 * The snapshot tests are the substance: they are what make #7 and #8's
 * versioning mean anything.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('booking');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const booking = require('../src/services/bookingService.ts');
const commission = require('../src/services/commissionService.ts');
const tiers = require('../src/services/cancellationTierService.ts');

const describe = hasDatabase ? test : test.skip;

test.before(async () => {
  if (ready) await ready;
});

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;
const PASSWORD = 'correct horse battery staple';
const N = (naira: number) => naira * 100;

const DEFAULT_TIERS = [
  { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
  { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
  { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
  { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
];

async function makeUser(role: UserRole, { verified = true, standing = 'GOOD' }: { verified?: boolean; standing?: string } = {}) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  return prisma.user.create({
    data: {
      email: `bk${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: verified ? 'VERIFIED' : 'UNVERIFIED',
      accountStanding: standing,
      ...(verified ? { verifiedAt: new Date(), escrowPartyId: `PAR_${n}` } : {}),
    },
  });
}

async function makeClient(opts: Record<string, unknown> = {}) {
  const user = await makeUser('CLIENT', opts);
  const client = await prisma.client.create({ data: { userId: user.id, displayName: 'Client' } });
  return { user, client };
}

async function makeArtist(opts: Record<string, unknown> = {}) {
  const user = await makeUser('ARTIST', opts);
  const artist = await prisma.artist.create({
    data: {
      userId: user.id,
      stageName: `Artist ${uniq()}`,
      category: 'Afrobeats',
      location: 'Lagos',
      baseRateKobo: N(200000),
      profileComplete: opts.complete === false ? false : true,
    },
  });
  return { user, artist };
}

/** A super-admin to attribute configuration changes to. */
async function configActor() {
  return makeUser('SUPER_ADMIN', { verified: false });
}

async function seedConfig(actorId, { bps = 500 } = {}) {
  await prisma.commissionRate.create({
    data: { rateBasisPoints: bps, effectiveFrom: new Date(Date.now() - 86400000), setByUserId: actorId },
  });
  const versionId = `v_${uniq()}`;
  await prisma.cancellationTier.createMany({
    data: DEFAULT_TIERS.map((t: CancellationTierSnapshot) => ({
      ...t,
      versionId,
      effectiveFrom: new Date(Date.now() - 86400000),
      setByUserId: actorId,
    })),
  });
  return versionId;
}

const future = (days = 30) => new Date(Date.now() + days * 86400000);

async function withServer(fn: (server: TestServer) => Promise<void>) {
  const server = await startServer(createApp());
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

async function login(server, email) {
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (((await res.json()) as any)).token;
}

const post = (server: TestServer, path: string, body?: unknown, token?: string) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// The snapshot — the substance of this issue
// ---------------------------------------------------------------------------

describe('changing the commission rate after creation does not alter that booking', async () => {
  const actor = await configActor();
  await seedConfig(actor.id, { bps: 500 });

  const { user: clientUser } = await makeClient();
  const { artist } = await makeArtist();

  const made = await booking.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo: N(200000),
    eventDate: future(),
  });

  assert.equal(made.commissionRateBpsSnapshot, 500, 'frozen at creation');

  // The rate moves to 7% afterwards.
  await commission.setCommissionRate({
    rateBasisPoints: 700,
    actorUserId: actor.id,
    reason: 'raised after the booking was made',
  });
  assert.equal((await commission.resolveCommissionRate()).rateBasisPoints, 700, 'live config moved');

  // The booking has not.
  const reread = await prisma.booking.findUniqueOrThrow({ where: { id: made.id } });
  assert.equal(
    reread.commissionRateBpsSnapshot,
    500,
    'the booking still pays out at the rate the artist accepted'
  );
});

describe('changing the tier table after creation does not alter that booking', async () => {
  const actor = await configActor();
  await seedConfig(actor.id);

  const { user: clientUser } = await makeClient();
  const { artist } = await makeArtist();

  const made = await booking.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo: N(200000),
    eventDate: future(),
  });

  const snapshot = made.cancellationTiersSnapshot;
  assert.equal(snapshot.length, 4);
  const dayOf = snapshot.find((t: any) => t.minDaysBefore === 0);
  assert.equal(dayOf.clientRefundBps, 1500);

  // A super-admin restructures the table entirely.
  await tiers.setCancellationTiers({
    tiers: [
      { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 500, artistCompensationBps: 9500 },
      { minDaysBefore: 1, maxDaysBefore: null, clientRefundBps: 9000, artistCompensationBps: 1000 },
    ],
    actorUserId: actor.id,
    reason: 'restructured after the booking was made',
  });

  const live = await tiers.resolveTierSet();
  assert.equal(live.tiers.length, 2, 'live config changed');

  const reread = await prisma.booking.findUniqueOrThrow({ where: { id: made.id } });
  assert.equal(reread.cancellationTiersSnapshot.length, 4, 'the booking keeps its own table');
  assert.equal(
    reread.cancellationTiersSnapshot.find((t: any) => t.minDaysBefore === 0).clientRefundBps,
    1500,
    'the client is refunded on the terms they were shown'
  );
});

describe('the snapshot stores literal percentages, not a pointer to a version', async () => {
  const actor = await configActor();
  await seedConfig(actor.id);
  const { user: clientUser } = await makeClient();
  const { artist } = await makeArtist();

  const made = await booking.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo: N(200000),
    eventDate: future(),
  });

  const serialised = JSON.stringify(made.cancellationTiersSnapshot);
  // A pointer would require reconstructing what applied; a copy IS what applied.
  assert.ok(!serialised.includes('versionId'), 'no foreign key to a config version');
  assert.ok(!serialised.includes('setByUserId'));

  for (const tier of made.cancellationTiersSnapshot) {
    assert.deepEqual(
      Object.keys(tier).sort(),
      ['artistCompensationBps', 'clientRefundBps', 'maxDaysBefore', 'minDaysBefore']
    );
    assert.equal(tier.clientRefundBps + tier.artistCompensationBps, 10000);
  }
});

// ---------------------------------------------------------------------------
// Escrow reference
// ---------------------------------------------------------------------------

describe('the escrow reference is generated by us and unique across bookings', async () => {
  const actor = await configActor();
  await seedConfig(actor.id);
  const { user: clientUser } = await makeClient();
  const { artist } = await makeArtist();

  const refs = new Set();
  for (let i = 0; i < 5; i++) {
    const made = await booking.createBooking({
      clientUserId: clientUser.id,
      artistId: artist.id,
      amountKobo: N(200000),
      eventDate: future(30 + i),
    });
    assert.match(made.escrowReference, /^bk_/, 'ours, not a provider identifier');
    refs.add(made.escrowReference);
  }
  assert.equal(refs.size, 5, 'every reference is distinct');

  // The database enforces it too, so a collision cannot silently create two
  // escrows for one booking.
  const existing = [...refs][0];
  const clientRow = await prisma.client.findFirstOrThrow({ where: { userId: clientUser.id } });

  await assert.rejects(
    () =>
      prisma.booking.create({
        data: {
          clientId: clientRow.id,
          artistId: artist.id,
          amountKobo: N(200000),
          eventDate: future(),
          eventEndAt: future(),
          escrowReference: existing,
          commissionRateBpsSnapshot: 500,
          cancellationTiersSnapshot: DEFAULT_TIERS,
        },
      }),
    (err: ThrownError) => err.code === 'P2002'
  );
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('a booking for a past event date returns 400', async () => {
  await withServer(async (server: TestServer) => {
    const actor = await configActor();
    await seedConfig(actor.id);
    const { user: clientUser } = await makeClient();
    const { artist } = await makeArtist();
    const token = await login(server, clientUser.email);

    for (const when of [new Date(Date.now() - 86400000), new Date(Date.now() - 1000)]) {
      const res = await post(
        server,
        '/bookings',
        { artistId: artist.id, amountKobo: N(200000), eventDate: when.toISOString() },
        token
      );
      assert.equal(res.status, 400);
      assert.match((((await res.json()) as any)).error, /future/i);
    }

    // A future date is accepted.
    const ok = await post(
      server,
      '/bookings',
      { artistId: artist.id, amountKobo: N(200000), eventDate: future().toISOString() },
      token
    );
    assert.equal(ok.status, 201);
  });
});

describe('the amount is bounded by the provider range and must be an integer', async () => {
  await withServer(async (server: TestServer) => {
    const actor = await configActor();
    await seedConfig(actor.id);
    const { user: clientUser } = await makeClient();
    const { artist } = await makeArtist();
    const token = await login(server, clientUser.email);

    const bad = [N(20000) - 1, N(3000000) + 1, 20000000.5, '20000000', null];
    for (const amountKobo of bad) {
      const res = await post(
        server,
        '/bookings',
        { artistId: artist.id, amountKobo, eventDate: future().toISOString() },
        token
      );
      assert.equal(res.status, 400, `${amountKobo} must be refused`);
    }

    // Both bounds are inclusive.
    for (const amountKobo of [N(20000), N(3000000)]) {
      const res = await post(
        server,
        '/bookings',
        { artistId: artist.id, amountKobo, eventDate: future().toISOString() },
        token
      );
      assert.equal(res.status, 201, `${amountKobo} is inside the range`);
    }
  });
});

// ---------------------------------------------------------------------------
// #10's deferred criterion, closed here
// ---------------------------------------------------------------------------

describe('an unverified client receives 403 on POST /bookings with an actionable message', async () => {
  await withServer(async (server: TestServer) => {
    const actor = await configActor();
    await seedConfig(actor.id);
    const { user: clientUser } = await makeClient({ verified: false });
    const { artist } = await makeArtist();
    const token = await login(server, clientUser.email);

    const res = await post(
      server,
      '/bookings',
      { artistId: artist.id, amountKobo: N(200000), eventDate: future().toISOString() },
      token
    );

    assert.equal(res.status, 403);
    const { error } = ((await res.json()) as any);
    // Actionable: it says what to do, not merely that it was refused.
    assert.match(error, /verify/i);
    assert.ok(!/forbidden|denied/i.test(error), 'not a bare refusal');
  });
});

describe('suspended clients and unverified or suspended artists are refused', async () => {
  await withServer(async (server: TestServer) => {
    const actor = await configActor();
    await seedConfig(actor.id);

    const suspendedClient = await makeClient({ standing: 'SUSPENDED' });
    const { artist: goodArtist } = await makeArtist();
    let token = await login(server, suspendedClient.user.email);
    // A suspended account cannot even log in (#9), so the guard is reached via
    // the service directly.
    await assert.rejects(
      () =>
        booking.createBooking({
          clientUserId: suspendedClient.user.id,
          artistId: goodArtist.id,
          amountKobo: N(200000),
          eventDate: future(),
        }),
      (err: ThrownError) => err.status === 403 && /suspended/i.test((err as ThrownError).message)
    );

    const goodClient = await makeClient();
    token = await login(server, goodClient.user.email);

    const { artist: unverifiedArtist } = await makeArtist({ verified: false });
    let res = await post(
      server,
      '/bookings',
      { artistId: unverifiedArtist.id, amountKobo: N(200000), eventDate: future().toISOString() },
      token
    );
    assert.equal(res.status, 403);

    const { artist: suspendedArtist } = await makeArtist({ standing: 'SUSPENDED' });
    res = await post(
      server,
      '/bookings',
      { artistId: suspendedArtist.id, amountKobo: N(200000), eventDate: future().toISOString() },
      token
    );
    assert.equal(res.status, 403);

    const { artist: incomplete } = await makeArtist({ complete: false });
    res = await post(
      server,
      '/bookings',
      { artistId: incomplete.id, amountKobo: N(200000), eventDate: future().toISOString() },
      token
    );
    assert.equal(res.status, 409, 'an incomplete profile is not bookable');
  });
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('the initial state is PENDING_PAYMENT', async () => {
  const actor = await configActor();
  await seedConfig(actor.id);
  const { user: clientUser } = await makeClient();
  const { artist } = await makeArtist();

  const made = await booking.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo: N(200000),
    eventDate: future(),
  });
  assert.equal(made.state, 'PENDING_PAYMENT');
});

describe('every transition in the documented map is permitted, and nothing else is', async () => {
  const states = Object.keys(booking.ALLOWED_TRANSITIONS);

  // Exhaustive: every from/to pair is checked against the map, so a transition
  // silently added to the code without being added to docs/01 §4 fails here.
  for (const from of states) {
    for (const to of states) {
      const expected = booking.ALLOWED_TRANSITIONS[from].includes(to);
      assert.equal(
        booking.canTransition(from, to),
        expected,
        `${from} → ${to} should be ${expected ? 'allowed' : 'refused'}`
      );
    }
  }

  // Copied before sorting — TERMINAL_STATES is frozen, and sort() mutates.
  assert.deepEqual(
    [...booking.TERMINAL_STATES].sort(),
    ['CANCELLED', 'REFUNDED', 'RELEASED', 'RESOLVED']
  );
});

describe('an illegal transition throws rather than proceeding', async () => {
  const actor = await configActor();
  await seedConfig(actor.id);
  const { user: clientUser } = await makeClient();
  const { artist } = await makeArtist();

  const made = await booking.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo: N(200000),
    eventDate: future(),
  });

  // PENDING_PAYMENT → RELEASED is not in the map: releasing money that was
  // never funded.
  await assert.rejects(
    () => booking.transition({ bookingId: made.id, to: 'RELEASED' }),
    (err: ThrownError) => err.status === 409
  );

  // And the booking did not move.
  assert.equal(
    (await prisma.booking.findUniqueOrThrow({ where: { id: made.id } })).state,
    'PENDING_PAYMENT'
  );

  // A legal one works.
  const funded = await booking.transition({ bookingId: made.id, to: 'FUNDED_HELD' });
  assert.equal(funded.state, 'FUNDED_HELD');

  // A terminal state cannot be left.
  await booking.transition({ bookingId: made.id, to: 'REFUNDED' });
  await assert.rejects(
    () => booking.transition({ bookingId: made.id, to: 'RELEASED' }),
    (err: ThrownError) => err.status === 409 && /already/i.test((err as ThrownError).message)
  );
});

// ---------------------------------------------------------------------------
// Reading a booking
// ---------------------------------------------------------------------------

describe('a booking is visible to its participants and nobody else', async () => {
  await withServer(async (server: TestServer) => {
    const actor = await configActor();
    await seedConfig(actor.id);
    const { user: clientUser } = await makeClient();
    const { user: artistUser, artist } = await makeArtist();
    const token = await login(server, clientUser.email);

    const made = ((await (
      await post(
        server,
        '/bookings',
        { artistId: artist.id, amountKobo: N(200000), eventDate: future().toISOString() },
        token
      )
    ).json()) as any);
    const id = made.booking.id;

    const get = (t: any) =>
      fetch(`${server.url}/bookings/${id}`, { headers: { Authorization: `Bearer ${t}` } });

    assert.equal((await get(token)).status, 200, 'the client can see it');
    assert.equal((await get(await login(server, artistUser.email))).status, 200, 'the artist can');

    const stranger = await makeClient();
    // 404 rather than 403 — confirming a booking exists is itself information.
    assert.equal((await get(await login(server, stranger.user.email))).status, 404);

    // The check-in code is never serialised; it belongs to the client alone and
    // #22 exposes it behind its own guard.
    const body = ((await (await get(token)).json()) as any);
    assert.ok(!('checkInCode' in body.booking));
  });
});

describe('the payout preview is computed from the snapshot, not live config', async () => {
  await withServer(async (server: TestServer) => {
    const actor = await configActor();
    await seedConfig(actor.id, { bps: 500 });
    const { user: clientUser } = await makeClient();
    const { artist } = await makeArtist();
    const token = await login(server, clientUser.email);

    const made = ((await (
      await post(
        server,
        '/bookings',
        { artistId: artist.id, amountKobo: N(200000), eventDate: future().toISOString() },
        token
      )
    ).json()) as any);

    // Expected from the booking's OWN snapshot rather than a hardcoded figure.
    // Earlier cases in this file move the live rate, and cases within a file
    // share a schema — asserting a literal here would be asserting test order.
    const { computeCompletion } = require('../src/services/feeService.ts');
    const snapshotBps = made.booking.commissionRateBpsSnapshot;
    const expected = computeCompletion({
      amountKobo: N(200000),
      commissionBps: snapshotBps,
    }).artistNetKobo;

    const read = async () =>
      (
        ((await (
          await fetch(`${server.url}/bookings/${made.booking.id}/payout-preview`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).json()) as any)
      ).payout.artistNetKobo;

    assert.equal(await read(), expected, 'computed from the snapshot');

    // Move the live rate somewhere it has never been. The preview must not budge.
    await commission.setCommissionRate({
      rateBasisPoints: 1234,
      actorUserId: actor.id,
      reason: 'after the fact',
    });
    assert.equal(
      (await commission.resolveCommissionRate()).rateBasisPoints,
      1234,
      'live config moved'
    );

    assert.equal(await read(), expected, 'still the figure the artist was shown');

    // And demonstrably different from what live config would produce.
    const ifLive = computeCompletion({ amountKobo: N(200000), commissionBps: 1234 }).artistNetKobo;
    assert.notEqual(ifLive, expected, 'the two really would differ');
  });
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
