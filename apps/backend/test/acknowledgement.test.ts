/**
 * Cancellation policy acknowledgement — issue #16.
 *
 * A compliance obligation, not a UX preference: a deduction we cannot prove was
 * disclosed is a deduction we may not be able to defend (docs/05 §8).
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('acknowledgement');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const ack = require('../src/services/acknowledgementService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const bookingService = require('../src/services/bookingService.ts');
const tierService = require('../src/services/cancellationTierService.ts');

const describe = hasDatabase ? test : test.skip;

test.before(async () => {
  if (ready) await ready;
});

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;
const PASSWORD = 'correct horse battery staple';
const N = (naira) => naira * 100;

const DEFAULT_TIERS = [
  { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
  { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
  { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
  { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
];

async function makeUser(role, extra = {}) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  return prisma.user.create({
    data: {
      email: `ack${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
      ...extra,
    },
  });
}

/** A super-admin, a client, an artist, config, and a booking ready to fund. */
async function scenario() {
  const admin = await makeUser('SUPER_ADMIN');
  await prisma.commissionRate.create({
    data: { rateBasisPoints: 500, effectiveFrom: new Date(Date.now() - 86400000), setByUserId: admin.id },
  });
  // effectiveFrom is NOW, not a day ago. Cases in one file share a schema, and
  // one of them replaces the live tier table — without this, every scenario
  // created afterwards would snapshot that replacement instead of the default
  // set, and the failure would look like a bug in the snapshot.
  const versionId = `v_${uniq()}`;
  await prisma.cancellationTier.createMany({
    data: DEFAULT_TIERS.map((t) => ({
      ...t,
      versionId,
      effectiveFrom: new Date(),
      setByUserId: admin.id,
    })),
  });

  const clientUser = await makeUser('CLIENT');
  await prisma.client.create({ data: { userId: clientUser.id, displayName: 'Client' } });

  const artistUser = await makeUser('ARTIST');
  const artist = await prisma.artist.create({
    data: {
      userId: artistUser.id,
      stageName: `Artist ${uniq()}`,
      category: 'Afrobeats',
      location: 'Lagos',
      baseRateKobo: N(200000),
      profileComplete: true,
    },
  });

  const booking = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo: N(200000),
    eventDate: new Date(Date.now() + 30 * 86400000),
  });

  return { admin, clientUser, artistUser, artist, booking };
}

/**
 * Stubs the provider for the funding call.
 *
 * #16's tests are about the disclosure GATE, not about escrow creation — that
 * is #18's, and it exercises the real calls. Before #18 the funding endpoint
 * returned a placeholder, so this file needed no stub; once the endpoint became
 * real it started reaching EscrowPay with fixture party ids the provider has
 * never seen, and failed with 502.
 *
 * Stubbing keeps this file testing one thing, and keeps it deterministic.
 */
async function withStubbedProvider(fn) {
  const originals = {
    createEscrow: escrowpay.createEscrow,
    activateEscrow: escrowpay.activateEscrow,
    createCheckoutSession: escrowpay.createCheckoutSession,
  };
  const id = `TXN_stub_${uniq()}`;

  escrowpay.createEscrow = async () => ({ id, status: 'draft', version: 1 });
  escrowpay.activateEscrow = async () => ({ id, status: 'pending_funding', version: 2 });
  escrowpay.createCheckoutSession = async () => ({
    allowed_channels: ['bank_transfer'],
    payment_instructions: {
      account_number: '8881700000',
      account_name: 'O-artist',
      bank_code: '090175',
      amount_minor: N(202000),
      provider: 'rubies',
      expires_at: new Date(Date.now() + 1800000).toISOString(),
    },
  });

  try {
    return await fn();
  } finally {
    Object.assign(escrowpay, originals);
  }
}

async function withServer(fn) {
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
  return (await res.json()).token;
}

const call = (server, method, path, body, token) =>
  fetch(`${server.url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

// ---------------------------------------------------------------------------

describe('attempting to fund a booking with no acknowledgement returns 409', async () => {
  await withServer(async (server) => {
    const { clientUser, booking } = await scenario();
    const token = await login(server, clientUser.email);

    const res = await call(server, 'POST', `/bookings/${booking.id}/funding`, {}, token);
    assert.equal(res.status, 409);

    const { error } = await res.json();
    // Says what is missing, rather than merely refusing.
    assert.match(error, /accept the cancellation terms/i);
  });
});

describe('the checkout step cannot be skipped by calling the funding endpoint directly', async () => {
  await withServer(async (server) => {
    const { clientUser, booking } = await scenario();
    const token = await login(server, clientUser.email);

    // Straight to funding, never having fetched the terms. This is the whole
    // point of the guard living at the endpoint rather than in the UI.
    assert.equal(
      (await call(server, 'POST', `/bookings/${booking.id}/funding`, {}, token)).status,
      409
    );

    // Acknowledge, then fund.
    const terms = await (
      await call(server, 'GET', `/bookings/${booking.id}/terms`, null, token)
    ).json();

    const acked = await call(
      server,
      'POST',
      `/bookings/${booking.id}/terms/acknowledge`,
      { acknowledged: true, tiersAsDisplayed: terms.terms.tiers },
      token
    );
    assert.equal(acked.status, 201);

    assert.equal(
      (
        await withStubbedProvider(() =>
          call(server, 'POST', `/bookings/${booking.id}/funding`, {}, token)
        )
      ).status,
      200
    );
  });
});

describe('the persisted row contains literal percentages, not a foreign key to a config version', async () => {
  const { clientUser, booking } = await scenario();

  const terms = await ack.getTermsForBooking({
    bookingId: booking.id,
    clientUserId: clientUser.id,
  });

  await ack.acknowledgeTerms({
    bookingId: booking.id,
    clientUserId: clientUser.id,
    acknowledged: true,
    tiersAsDisplayed: terms.tiers,
  });

  const row = await prisma.termsAcknowledgement.findUniqueOrThrow({
    where: { bookingId: booking.id },
  });

  assert.equal(row.tiersAsDisplayed.length, 4);
  assert.equal(row.commissionRateBpsAsDisplayed, 500);

  const serialised = JSON.stringify(row.tiersAsDisplayed);
  // A pointer would require reconstructing what the client saw; a copy IS what
  // they saw.
  assert.ok(!serialised.includes('versionId'), 'no config version reference');
  assert.ok(!serialised.includes('setByUserId'));
  assert.ok(!serialised.includes('effectiveFrom'));

  for (const tier of row.tiersAsDisplayed) {
    assert.deepEqual(Object.keys(tier).sort(), [
      'artistCompensationBps',
      'clientRefundBps',
      'maxDaysBefore',
      'minDaysBefore',
    ]);
  }

  // The day-0 band is the literal figure, readable years later without any
  // other table.
  assert.equal(row.tiersAsDisplayed.find((t) => t.minDaysBefore === 0).clientRefundBps, 1500);
});

describe('the acknowledgement survives the configuration changing afterwards', async () => {
  const { admin, clientUser, booking } = await scenario();

  const terms = await ack.getTermsForBooking({ bookingId: booking.id, clientUserId: clientUser.id });
  await ack.acknowledgeTerms({
    bookingId: booking.id,
    clientUserId: clientUser.id,
    acknowledged: true,
    tiersAsDisplayed: terms.tiers,
  });

  // The whole table is replaced afterwards.
  await tierService.setCancellationTiers({
    tiers: [
      { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 0, artistCompensationBps: 10000 },
      { minDaysBefore: 1, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
    ],
    actorUserId: admin.id,
    reason: 'changed after the client acknowledged',
  });

  const row = await ack.getAcknowledgement(booking.id);
  assert.equal(row.tiersAsDisplayed.length, 4, 'still what the client was shown');
  assert.equal(
    row.tiersAsDisplayed.find((t) => t.minDaysBefore === 0).clientRefundBps,
    1500,
    'not the new 0 bps'
  );

  // This is the evidence: what was disclosed, provably, at the time.
});

describe('acknowledgement must be an active act', async () => {
  await withServer(async (server) => {
    const { clientUser, booking } = await scenario();
    const token = await login(server, clientUser.email);
    const terms = await (
      await call(server, 'GET', `/bookings/${booking.id}/terms`, null, token)
    ).json();

    // A pre-ticked box or a passive acceptance does not satisfy disclosure, so
    // anything other than an explicit true is refused.
    for (const acknowledged of [false, undefined, null, 'true', 1, {}]) {
      const res = await call(
        server,
        'POST',
        `/bookings/${booking.id}/terms/acknowledge`,
        { acknowledged, tiersAsDisplayed: terms.terms.tiers },
        token
      );
      assert.equal(res.status, 400, `acknowledged=${JSON.stringify(acknowledged)} must be refused`);
    }

    assert.equal(await prisma.termsAcknowledgement.count({ where: { bookingId: booking.id } }), 0);
  });
});

describe('acknowledging terms that differ from the snapshot is refused', async () => {
  await withServer(async (server) => {
    const { clientUser, booking } = await scenario();
    const token = await login(server, clientUser.email);

    // The client returns a table with a better day-0 refund than the one that
    // governs the booking. Recording that would make the evidence a lie.
    const tampered = DEFAULT_TIERS.map((t) =>
      t.minDaysBefore === 0 ? { ...t, clientRefundBps: 9000, artistCompensationBps: 1000 } : t
    );

    const res = await call(
      server,
      'POST',
      `/bookings/${booking.id}/terms/acknowledge`,
      { acknowledged: true, tiersAsDisplayed: tampered },
      token
    );
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /changed while you were reading/i);

    assert.equal(await prisma.termsAcknowledgement.count({ where: { bookingId: booking.id } }), 0);
  });
});

describe('band order and key order do not cause a spurious mismatch', async () => {
  const { clientUser, booking } = await scenario();

  // Reordered from the booking's OWN snapshot, not the module constant — the
  // snapshot is what the client would have been shown.
  const snapshot = booking.cancellationTiersSnapshot;

  // Same table, reversed, with keys written in a different order — which is
  // what a JSON round trip through a form might produce.
  const reordered = [...snapshot].reverse().map((t) => ({
    artistCompensationBps: t.artistCompensationBps,
    maxDaysBefore: t.maxDaysBefore,
    clientRefundBps: t.clientRefundBps,
    minDaysBefore: t.minDaysBefore,
  }));

  const row = await ack.acknowledgeTerms({
    bookingId: booking.id,
    clientUserId: clientUser.id,
    acknowledged: true,
    tiersAsDisplayed: reordered,
  });

  assert.ok(row.id, 'accepted — the content is identical');
  assert.equal(row.tiersAsDisplayed.length, snapshot.length);
  // Stored normalised, ascending by band, so it reads the same way every time.
  assert.equal(row.tiersAsDisplayed[0].minDaysBefore, 0);
});

describe('acknowledging twice is idempotent, not an error or a duplicate', async () => {
  const { clientUser, booking } = await scenario();
  const terms = await ack.getTermsForBooking({ bookingId: booking.id, clientUserId: clientUser.id });

  const first = await ack.acknowledgeTerms({
    bookingId: booking.id,
    clientUserId: clientUser.id,
    acknowledged: true,
    tiersAsDisplayed: terms.tiers,
  });
  const second = await ack.acknowledgeTerms({
    bookingId: booking.id,
    clientUserId: clientUser.id,
    acknowledged: true,
    tiersAsDisplayed: terms.tiers,
  });

  // A client who double-taps has not done anything wrong.
  assert.equal(second.id, first.id);
  assert.equal(await prisma.termsAcknowledgement.count({ where: { bookingId: booking.id } }), 1);
});

describe('only the booking’s own client can read or acknowledge its terms', async () => {
  await withServer(async (server) => {
    const { booking } = await scenario();
    const other = await scenario();
    const strangerToken = await login(server, other.clientUser.email);

    assert.equal(
      (await call(server, 'GET', `/bookings/${booking.id}/terms`, null, strangerToken)).status,
      404
    );
    assert.equal(
      (
        await call(
          server,
          'POST',
          `/bookings/${booking.id}/terms/acknowledge`,
          { acknowledged: true, tiersAsDisplayed: DEFAULT_TIERS },
          strangerToken
        )
      ).status,
      404
    );

    // The artist cannot either — acknowledgement is the client's act.
    const artistToken = await login(server, (await scenario()).artistUser.email);
    assert.equal(
      (await call(server, 'GET', `/bookings/${booking.id}/terms`, null, artistToken)).status,
      403
    );
  });
});

describe('the terms endpoint returns the snapshot in full, with the acknowledgement state', async () => {
  await withServer(async (server) => {
    const { clientUser, booking } = await scenario();
    const token = await login(server, clientUser.email);

    let body = await (await call(server, 'GET', `/bookings/${booking.id}/terms`, null, token)).json();
    assert.equal(body.terms.tiers.length, 4, 'the full table, not a link to it');
    assert.equal(body.terms.commissionRateBps, 500);
    assert.equal(body.terms.acknowledged, false);
    assert.equal(body.terms.acknowledgedAt, null);
    assert.equal(body.terms.amountKobo, N(200000));

    await call(
      server,
      'POST',
      `/bookings/${booking.id}/terms/acknowledge`,
      { acknowledged: true, tiersAsDisplayed: body.terms.tiers },
      token
    );

    body = await (await call(server, 'GET', `/bookings/${booking.id}/terms`, null, token)).json();
    assert.equal(body.terms.acknowledged, true);
    assert.ok(body.terms.acknowledgedAt);
  });
});

describe('the acknowledgement is retrievable later for dispute defence', async () => {
  const { clientUser, booking } = await scenario();
  const terms = await ack.getTermsForBooking({ bookingId: booking.id, clientUserId: clientUser.id });
  await ack.acknowledgeTerms({
    bookingId: booking.id,
    clientUserId: clientUser.id,
    acknowledged: true,
    tiersAsDisplayed: terms.tiers,
  });

  // #37 surfaces this on the admin booking detail.
  const row = await ack.getAcknowledgement(booking.id);
  assert.ok(row);
  assert.equal(row.clientUserId, clientUser.id);
  assert.ok(row.acknowledgedAt instanceof Date);
  assert.equal(row.tiersAsDisplayed.length, 4);
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
