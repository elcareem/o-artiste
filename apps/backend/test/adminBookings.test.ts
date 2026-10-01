/**
 * Operational visibility — issue #37, docs/07 §7.
 *
 * This is the screen someone opens when a client emails asking why they
 * received ₦137,860 instead of ₦140,000. The answer is in the ledger, but only
 * if it is legible — so these tests are mostly about whether the view actually
 * answers the question, not whether it renders.
 */

process.env.QUEUE_PREFIX = `test-adminbk-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('adminbookings');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const bookingService = require('../src/services/bookingService.ts');
const escrowService = require('../src/services/escrowService.ts');
const ledger = require('../src/services/ledgerService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');

const describe = hasDatabase ? test : test.skip;

const PASSWORD = 'correct horse battery staple';

let server: TestServer;

test.before(async () => {
  if (ready) await ready;
  server = await startServer(createApp());
});

test.after(async () => {
  if (server) await server.close();
  await require('../src/lib/queue.ts').closeAll();
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
      email: `abk${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

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

async function withProvider(overrides: Record<string, any>, fn: () => any) {
  const originals: Record<string, any> = {};
  for (const [name, impl] of Object.entries(overrides)) {
    originals[name] = escrowpay[name];
    escrowpay[name] = impl;
  }
  try {
    return await fn();
  } finally {
    Object.assign(escrowpay, originals);
  }
}

const PROVIDER = {
  release: async () => ({ id: `REL_${uniq()}`, status: 'completed' }),
  refund: async () => ({ id: `RFD_${uniq()}`, status: 'completed' }),
};

/** Config a booking can be created against. */
async function publishConfig() {
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

/** A booking as it exists before the client has paid. */
async function pendingBooking({ amountKobo = N(200000), daysOut = 5 } = {}) {
  const clientUser = await makeUser('CLIENT');
  await prisma.client.create({ data: { userId: clientUser.id, displayName: 'Ada Client' } });

  const artistUser = await makeUser('ARTIST');
  const artist = await prisma.artist.create({
    data: {
      userId: artistUser.id,
      stageName: `Artist ${uniq()}`,
      category: 'Afrobeats',
      location: 'Lagos',
      baseRateKobo: amountKobo,
      profileComplete: true,
    },
  });

  const booking = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo,
    eventDate: new Date(Date.now() + daysOut * 86400000),
  });

  return { booking, clientUser, artistUser, artist, amountKobo };
}

/** The same booking, funded, with the funding entries written. */
async function fundedBooking(opts: { amountKobo?: number; daysOut?: number } = {}) {
  const made = await pendingBooking(opts);
  let booking = made.booking;

  // Through `transition()` rather than a direct update, which is what the
  // webhook does in production. Setting `state` directly — as this fixture did
  // first — leaves the history with a real gap: PENDING_PAYMENT followed by a
  // jump out of FUNDED_HELD, with nothing recording the funding itself.
  await prisma.booking.update({ where: { id: booking.id }, data: { escrowId: `TXN_${uniq()}` } });
  booking = await bookingService.transition({
    bookingId: booking.id,
    to: 'FUNDED_HELD',
    data: { fundedAt: new Date() },
  });
  await prisma.$transaction((tx: PrismaTx) => ledger.recordFunding(tx, booking));

  return { ...made, booking };
}

/** The same booking, carried all the way through to a payout. */
async function releasedBooking(opts = {}) {
  const made = await fundedBooking(opts);

  await bookingService.transition({ bookingId: made.booking.id, to: 'AWAITING_CONFIRMATION' });
  const release = await withProvider(PROVIDER, () =>
    escrowService.releaseBooking({ bookingId: made.booking.id })
  );

  return { ...made, release };
}

// ---------------------------------------------------------------------------
// Criterion: a completed booking's ledger entries sum to zero IN THE VIEW
// ---------------------------------------------------------------------------

describe('a completed booking reconciles to zero in the view, not just the database', async () => {
  await publishConfig();
  const { booking, amountKobo } = await releasedBooking({ amountKobo: N(200000) });

  const admin = await makeUser('ADMIN');
  const detail = await call('GET', `/admin/bookings/${booking.id}`, await login(admin.email));
  assert.equal(detail.status, 200, detail.body.error);

  // ZERO IN THE PAYLOAD. `assertBalanced` already protects the write path, but
  // #37's criterion is about the view: the number an admin reads has to be the
  // one the ledger computed, not one the screen added up again.
  assert.equal(detail.body.ledger.sumKobo, 0);
  assert.equal(detail.body.ledger.balanced, true);
  assert.ok(detail.body.ledger.entryCount > 0);

  // And it is reconciled PER PARTY, which is the form the question arrives in.
  //
  // The client's net is the booking amount PLUS the money-in fee, not the
  // amount alone — the client bears the funding fee (#18, docs/00 §8). Asserting
  // -amountKobo here is what this test did first, and the ledger was right.
  const { moneyInFee } = require('../src/services/feeService.ts');
  const net = detail.body.ledger.netByParty;
  assert.equal(net.CLIENT, -(amountKobo + moneyInFee(amountKobo)));
  assert.ok(net.ARTIST > 0, 'the artist has no net position on a released booking');
  assert.equal(
    net.CLIENT + net.ARTIST + net.PLATFORM + net.PROVIDER,
    0,
    'the per-party positions do not themselves sum to zero'
  );

  // The commission is visible as its own line rather than as a smaller artist
  // credit — "why ₦188,000 and not ₦200,000" is answered by reading, which is
  // the entire point of this screen.
  const types = detail.body.ledger.entries.map((e: any) => e.entryType);
  assert.ok(types.includes('COMMISSION'), `no commission entry among ${types.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Criterion: a manual action without a written reason is rejected
// ---------------------------------------------------------------------------

describe('a manual release or refund without a written reason is refused', async () => {
  await publishConfig();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  for (const leg of ['release', 'refund']) {
    const { booking } = await fundedBooking();
    await bookingService.transition({ bookingId: booking.id, to: 'AWAITING_CONFIRMATION' });

    for (const body of [undefined, {}, { reason: '' }, { reason: '    ' }, { reason: 'ok' }]) {
      const res = await withProvider(PROVIDER, () =>
        call('POST', `/admin/bookings/${booking.id}/${leg}`, token, body)
      );
      assert.equal(res.status, 400, `${leg} accepted ${JSON.stringify(body)}`);
      assert.match(res.body.error, /reason|detail/i);
    }

    // THE MONEY DID NOT MOVE. A 400 that still released would be the worst
    // possible outcome, so the state is re-read rather than assumed.
    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    assert.equal(after.state, 'AWAITING_CONFIRMATION');
    assert.equal(after.releasedAt, null);
    assert.equal(after.refundedAt, null);
  }
});

describe('a manual release with a reason moves the money and records who and why', async () => {
  await publishConfig();
  const { booking } = await fundedBooking();
  await bookingService.transition({ bookingId: booking.id, to: 'AWAITING_CONFIRMATION' });

  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);
  const reason = 'Client confirmed by phone but will not use the app; artist has performed.';

  const res = await withProvider(PROVIDER, () =>
    call('POST', `/admin/bookings/${booking.id}/release`, token, { reason })
  );
  assert.equal(res.status, 200, res.body.error);

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'RELEASED');

  // The audit row and the state history both name the admin. A money movement
  // without a recorded justification is indefensible later (docs/07 §5).
  const audit = await prisma.auditLog.findFirst({
    where: { entityType: 'Booking', entityId: booking.id, action: 'BOOKING_MANUALLY_RELEASED' },
  });
  assert.ok(audit, 'no audit row for a manual release');
  assert.equal(audit.actorUserId, admin.id);
  assert.equal(audit.reason, reason);
});

describe('manual money movement is closed to everyone below ADMIN', async () => {
  await publishConfig();
  const { booking, clientUser, artistUser } = await fundedBooking();
  await bookingService.transition({ bookingId: booking.id, to: 'AWAITING_CONFIRMATION' });

  const reason = 'Trying to release my own booking, which should not be possible.';

  for (const user of [clientUser, artistUser]) {
    const userToken = await login(user.email);
    const res = await withProvider(PROVIDER, () =>
      call('POST', `/admin/bookings/${booking.id}/release`, userToken, { reason })
    );
    assert.equal(res.status, 403, `${user.email} released a booking`);
  }

  assert.equal((await call('GET', '/admin/bookings')).status, 401);
  assert.equal(
    (await call('GET', '/admin/bookings', await login(clientUser.email))).status,
    403
  );

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'AWAITING_CONFIRMATION');
});

// ---------------------------------------------------------------------------
// Criterion: the terms acknowledgement from #16 is retrievable
// ---------------------------------------------------------------------------

describe('the terms acknowledgement is retrievable from the booking detail', async () => {
  await publishConfig();
  // Acknowledged while PENDING_PAYMENT — before the money moves, which is the
  // only moment the acknowledgement means anything (#16).
  const { booking, clientUser } = await pendingBooking();

  const acknowledged = await call(
    'POST',
    `/bookings/${booking.id}/terms/acknowledge`,
    await login(clientUser.email),
    { acknowledged: true, tiersAsDisplayed: booking.cancellationTiersSnapshot }
  );
  assert.equal(acknowledged.status, 201, acknowledged.body.error);

  const admin = await makeUser('ADMIN');
  const detail = await call('GET', `/admin/bookings/${booking.id}`, await login(admin.email));

  const ack = detail.body.termsAcknowledgement;
  assert.ok(ack, 'the acknowledgement is not reachable from the booking detail');
  assert.ok(ack.acknowledgedAt);
  assert.equal(ack.commissionRateBpsAsDisplayed, booking.commissionRateBpsSnapshot);

  // WHAT THEY SAW, copied by value — not the configuration in force now. A
  // deduction we cannot prove was disclosed is one we may not be able to
  // defend (#16).
  assert.equal(ack.tiersAsDisplayed.length, DEFAULT_TIERS.length);
  assert.deepEqual(
    ack.tiersAsDisplayed.map((t: any) => t.clientRefundBps).sort(),
    DEFAULT_TIERS.map((t) => t.clientRefundBps).sort()
  );
});

describe('a booking with no acknowledgement says so rather than omitting the field', async () => {
  await publishConfig();
  const { booking } = await fundedBooking();
  const admin = await makeUser('ADMIN');

  const detail = await call('GET', `/admin/bookings/${booking.id}`, await login(admin.email));

  // Present and null. An absent key reads as "this screen does not show that",
  // which is a different statement from "this did not happen".
  assert.ok('termsAcknowledgement' in detail.body);
  assert.equal(detail.body.termsAcknowledgement, null);
  assert.equal(detail.body.checkIn, null);
});

// ---------------------------------------------------------------------------
// Criterion: a reclassified cancellation shows BOTH original and offsetting
// ---------------------------------------------------------------------------

describe('a reclassified cancellation shows the original entries and the offsets', async () => {
  await publishConfig();
  const { booking, clientUser, amountKobo } = await fundedBooking({ daysOut: 2 });

  // Move the event inside the 1-2 day band so the cancellation actually costs
  // the client something — a full refund would leave nothing to reverse.
  const eventDate = new Date(Date.now() + 2 * 86400000);
  eventDate.setUTCHours(11, 0, 0, 0);
  await prisma.booking.update({
    where: { id: booking.id },
    data: { eventDate, eventEndAt: new Date(eventDate.getTime() + 3 * 3600_000) },
  });

  const clientToken = await login(clientUser.email);
  await withProvider(PROVIDER, () =>
    call('POST', `/bookings/${booking.id}/cancel`, clientToken, { reason: 'Changed plans.' })
  );

  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const before = await call('GET', `/admin/bookings/${booking.id}`, token);
  const originalCount = before.body.ledger.entries.length;
  assert.ok(originalCount > 0);

  const cancellation = await prisma.cancellation.findUnique({ where: { bookingId: booking.id } });
  const reclassified = await withProvider(PROVIDER, () =>
    call('POST', `/admin/cancellations/${cancellation.id}/reclassify`, token, {
      reason: 'The artist raised their fee after the booking was accepted.',
    })
  );
  assert.equal(reclassified.status, 200, reclassified.body.error);

  const after = await call('GET', `/admin/bookings/${booking.id}`, token);
  const entries = after.body.ledger.entries;

  // BOTH, not one. The originals stay visible because the sequence — charged,
  // then reversed, and why — is the record that matters when the decision is
  // questioned, and it will be (docs/01 §5).
  assert.ok(
    entries.length > originalCount,
    'the reversal replaced the original entries instead of offsetting them'
  );

  const corrections = entries.filter((e: any) => e.entryType === 'CORRECTION');
  assert.ok(corrections.length > 0, 'no correction entries');

  // Each correction NAMES the entry it offsets, so the pair is readable as a
  // pair rather than as two entries that happen to cancel out.
  for (const correction of corrections) {
    assert.ok(correction.offsetsEntryId, 'a correction does not name what it offsets');
    assert.ok(
      entries.some((e: any) => e.id === correction.offsetsEntryId),
      'a correction offsets an entry that is not in the view'
    );
  }

  // Every original is still there.
  for (const original of before.body.ledger.entries) {
    assert.ok(entries.some((e: any) => e.id === original.id), 'an original entry disappeared');
  }

  // And it still reconciles: the client ends up whole.
  assert.equal(after.body.ledger.sumKobo, 0);
  assert.equal(after.body.ledger.netByParty.CLIENT, 0, 'the client is not made whole');
  assert.equal(after.body.ledger.balanced, true);
  void amountKobo;
});

// ---------------------------------------------------------------------------
// The state history — the question this screen exists to answer
// ---------------------------------------------------------------------------

describe('the state history records how a booking reached its state', async () => {
  await publishConfig();
  const { booking } = await releasedBooking();

  const admin = await makeUser('ADMIN');
  const detail = await call('GET', `/admin/bookings/${booking.id}`, await login(admin.email));

  const states = detail.body.timeline.map((t: any) => t.toState);
  assert.deepEqual(states, [
    'PENDING_PAYMENT',
    'FUNDED_HELD',
    'AWAITING_CONFIRMATION',
    'RELEASED',
  ]);

  // Chained: each entry says where it came from, so a gap is visible.
  assert.equal(detail.body.timeline[0].fromState, null);
  for (let i = 1; i < detail.body.timeline.length; i++) {
    assert.equal(detail.body.timeline[i].fromState, states[i - 1]);
  }

  // Recorded, not reconstructed from timestamps.
  assert.ok(detail.body.timeline.every((t: any) => t.reconstructed === false));
});

describe('an automated transition records no actor rather than a wrong one', async () => {
  await publishConfig();
  const { booking } = await fundedBooking();

  // No actor passed — this is what an auto-release or a webhook does.
  await bookingService.transition({ bookingId: booking.id, to: 'AWAITING_CONFIRMATION' });

  const admin = await makeUser('ADMIN');
  const detail = await call('GET', `/admin/bookings/${booking.id}`, await login(admin.email));

  const entry = detail.body.timeline.find((t: any) => t.toState === 'AWAITING_CONFIRMATION');
  // Null is the honest answer. Attributing it to whoever happened to be nearby
  // would make the record worse than no record.
  assert.equal(entry.actor, null);
  assert.equal(entry.reason, null);
});

describe('the history is append-only even when a transition is refused', async () => {
  await publishConfig();
  const { booking } = await releasedBooking();

  const countBefore = await prisma.bookingStateTransition.count({ where: { bookingId: booking.id } });

  // RELEASED is terminal, so this throws — and must leave no row behind.
  await assert.rejects(
    () => bookingService.transition({ bookingId: booking.id, to: 'REFUNDED' }),
    /already been paid out/i
  );

  assert.equal(
    await prisma.bookingStateTransition.count({ where: { bookingId: booking.id } }),
    countBefore,
    'a refused transition still wrote a history row'
  );
});

// ---------------------------------------------------------------------------
// The list and its filters
// ---------------------------------------------------------------------------

describe('the list filters by state, date and value', async () => {
  await publishConfig();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const cheap = await fundedBooking({ amountKobo: N(50000), daysOut: 3 });
  const dear = await fundedBooking({ amountKobo: N(500000), daysOut: 40 });
  await bookingService.transition({ bookingId: dear.booking.id, to: 'AWAITING_CONFIRMATION' });

  const byState = await call('GET', '/admin/bookings?state=AWAITING_CONFIRMATION', token);
  const ids = byState.body.bookings.map((b: any) => b.id);
  assert.ok(ids.includes(dear.booking.id));
  assert.ok(!ids.includes(cheap.booking.id));
  assert.deepEqual(byState.body.filters.applied, ['state']);

  const byValue = await call('GET', `/admin/bookings?minKobo=${N(100000)}`, token);
  const valueIds = byValue.body.bookings.map((b: any) => b.id);
  assert.ok(valueIds.includes(dear.booking.id));
  assert.ok(!valueIds.includes(cheap.booking.id));

  const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const byDate = await call('GET', `/admin/bookings?to=${soon}`, token);
  const dateIds = byDate.body.bookings.map((b: any) => b.id);
  assert.ok(dateIds.includes(cheap.booking.id));
  assert.ok(!dateIds.includes(dear.booking.id));

  // Two filters together narrow rather than widen.
  const both = await call(
    'GET',
    `/admin/bookings?state=AWAITING_CONFIRMATION&minKobo=${N(100000)}`,
    token
  );
  assert.ok(both.body.bookings.every((b: any) => b.state === 'AWAITING_CONFIRMATION'));
  assert.ok(both.body.bookings.every((b: any) => b.amountKobo >= N(100000)));
});

describe('a filter value we cannot honour is refused, never ignored', async () => {
  await publishConfig();
  const token = await login((await makeUser('ADMIN')).email);

  // A DROPPED FILTER IS WORSE THAN AN ERROR: the full list comes back looking
  // like a filtered one and the reader has no way to tell.
  const bad: [string, RegExp][] = [
    ['state=PAID', /not a booking state/i],
    ['state=FUNDED_HELD,NONSENSE', /not a booking state/i],
    ['from=last-tuesday', /not a date/i],
    ['minKobo=12.5', /whole number/i],
    ['minKobo=-1', /whole number/i],
    [`minKobo=${N(900)}&maxKobo=${N(100)}`, /nothing can match/i],
    ['from=2026-06-01&to=2026-01-01', /nothing can match/i],
  ];

  for (const [query, expected] of bad) {
    const res = await call('GET', `/admin/bookings?${query}`, token);
    assert.equal(res.status, 400, `${query} was accepted`);
    assert.match(res.body.error, expected, `${query}: "${res.body.error}"`);
  }

  // An empty value is absence, not a zero floor — `Number('')` is 0.
  const blank = await call('GET', '/admin/bookings?minKobo=&state=', token);
  assert.equal(blank.status, 200);
  assert.deepEqual(blank.body.filters.applied, []);
});

describe('the list surfaces released-but-not-paid-out, which no state shows', async () => {
  await publishConfig();
  const { booking } = await releasedBooking();
  const token = await login((await makeUser('ADMIN')).email);

  const list = await call('GET', '/admin/bookings?state=RELEASED', token);
  const row = list.body.bookings.find((b: any) => b.id === booking.id);

  // RELEASED means the money left escrow, not that the artist has it. The
  // distinction is invisible in the state and is money sitting in our wallet
  // that is not ours (#26).
  assert.equal(row.awaitingPayout, true);

  await prisma.booking.update({ where: { id: booking.id }, data: { paidOutAt: new Date() } });
  const after = await call('GET', '/admin/bookings?state=RELEASED', token);
  assert.equal(after.body.bookings.find((b: any) => b.id === booking.id).awaitingPayout, false);
});

describe('a booking that does not exist is a 404, and no id is leaked', async () => {
  const token = await login((await makeUser('ADMIN')).email);
  const res = await call('GET', '/admin/bookings/clnonexistent000000000000', token);
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.body.error, /prisma|sql|clnonexistent/i);
});

// ---------------------------------------------------------------------------
// The projection the manual-release button reads from
// ---------------------------------------------------------------------------

describe('the detail projects what a release would pay, before any release', async () => {
  await publishConfig();
  const { booking, amountKobo } = await fundedBooking({ amountKobo: N(200000) });
  await bookingService.transition({ bookingId: booking.id, to: 'AWAITING_CONFIRMATION' });

  const token = await login((await makeUser('ADMIN')).email);
  const detail = await call('GET', `/admin/bookings/${booking.id}`, token);

  const { computeCompletion, moneyOutFee } = require('../src/services/feeService.ts');
  const expected = computeCompletion({
    amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
  });

  // The ledger's artist position is still zero here — nothing has been paid.
  // A screen reading THAT would offer to "release ₦0" on every booking where
  // the button is actually available.
  assert.equal(detail.body.ledger.netByParty.ARTIST, 0);
  assert.equal(detail.body.projection.artistNetKobo, expected.artistNetKobo);
  assert.ok(detail.body.projection.artistNetKobo > 0);

  // THE PAYOUT FEE IS NOT THE ARTIST'S. It is borne by the platform and reduces
  // our take, not their payment (#18, docs/00 §8) — so the artist's share is the
  // amount less commission, full stop. Subtracting the fee here is the mistake
  // this assertion exists to catch.
  const commission = (amountKobo * booking.commissionRateBpsSnapshot) / 10000;
  assert.equal(detail.body.projection.artistNetKobo, amountKobo - commission);
  assert.ok(moneyOutFee(expected.artistNetKobo) > 0, 'no payout fee to be wrong about');
  assert.notEqual(
    detail.body.projection.artistNetKobo,
    amountKobo - commission - moneyOutFee(expected.artistNetKobo)
  );

  // And the client's side: the money-in fee is theirs, on top of the amount.
  assert.equal(detail.body.projection.clientPaysKobo, amountKobo + expected.moneyInFeeKobo);
});

describe('once released, the projection and the ledger agree', async () => {
  await publishConfig();
  const { booking } = await releasedBooking({ amountKobo: N(200000) });

  const token = await login((await makeUser('ADMIN')).email);
  const detail = await call('GET', `/admin/bookings/${booking.id}`, token);

  // The projection is what the release used, so after the fact the two must
  // match. A disagreement means the screen is quoting arithmetic the money did
  // not follow.
  assert.equal(detail.body.ledger.netByParty.ARTIST, detail.body.projection.artistNetKobo);
});
