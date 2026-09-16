/**
 * Client-initiated cancellation — issue #27.
 *
 * The tier comes from the BOOKING'S SNAPSHOT, never the live table. That is the
 * payoff of #15 and #16: the client agreed to specific percentages, and those
 * percentages execute however the configuration changes afterwards. The last
 * test in this file is the one that proves it.
 */

process.env.QUEUE_PREFIX = `test-clientcxl-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('clientcxl');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const cancellationService = require('../src/services/cancellationService.ts');
const bookingService = require('../src/services/bookingService.ts');
const ledger = require('../src/services/ledgerService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const { computeClientCancellation } = require('../src/services/feeService.ts');

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

/**
 * One versionId for the whole set.
 *
 * `resolveTierSet` returns the rows sharing the LATEST version's id, so giving
 * each row its own id publishes four one-band versions and snapshots a single
 * band onto the booking. Its cancellation then has no applicable rule for most
 * days — caught in #28 by the snapshot guard `createBooking` now applies.
 */
function tierSetFor<T>(tiers: T[]): (T & { versionId: string })[] {
  const versionId = `v_${uniq()}`;
  return tiers.map((t) => ({ ...t, versionId }));
}

const N = (naira: number) => naira * 100;

const DEFAULT_TIERS: CancellationTierSnapshot[] = [
  { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
  { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
  { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
  { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
];

// ---------------------------------------------------------------------------
// Counting days — a calendar, not a stopwatch
// ---------------------------------------------------------------------------

test('days before the event are Lagos calendar days, not elapsed hours over 24', () => {
  const { daysBeforeEvent } = cancellationService;

  // Lagos is UTC+1. The event is Wednesday 09:00 Lagos = Wednesday 08:00 UTC.
  const event = '2026-12-16T08:00:00Z';

  // Monday 23:00 Lagos = Monday 22:00 UTC. Thirty-four hours in hand, which
  // floors to 1 — but every person involved would say this is two days before,
  // and the boundary between a 70% refund and a 40% one has to fall where they
  // would put it.
  assert.equal(daysBeforeEvent(event, '2026-12-14T22:00:00Z'), 2);

  // The event day itself, at any hour, is day 0.
  assert.equal(daysBeforeEvent(event, '2026-12-16T00:30:00Z'), 0);
  assert.equal(daysBeforeEvent(event, '2026-12-16T07:59:00Z'), 0);

  // The day before is 1, however close to the event — but 23:00 UTC is already
  // midnight in Lagos, so the boundary sits an hour earlier than a UTC reading
  // would put it. That is the whole reason this is computed in Lagos.
  assert.equal(daysBeforeEvent(event, '2026-12-15T12:00:00Z'), 1);
  assert.equal(daysBeforeEvent(event, '2026-12-15T22:59:00Z'), 1);
  assert.equal(daysBeforeEvent(event, '2026-12-15T23:00:00Z'), 0);

  // A week out is 7.
  assert.equal(daysBeforeEvent(event, '2026-12-09T08:00:00Z'), 7);

  // After the event is negative — no band covers it.
  assert.equal(daysBeforeEvent(event, '2026-12-17T09:00:00Z'), -1);
});

test('the Lagos offset changes the answer at the boundary', () => {
  const { daysBeforeEvent } = cancellationService;
  const event = '2026-12-16T08:00:00Z';

  // 23:30 UTC on the 15th is 00:30 Lagos on the 16th — the event day. Counting
  // in UTC would call this day 1 and refund the client 40% instead of 15%.
  assert.equal(daysBeforeEvent(event, '2026-12-15T23:30:00Z'), 0);
});

test('a tier is resolved from a snapshot, and a gap is refused rather than guessed', () => {
  const { resolveTier } = cancellationService;

  assert.equal(resolveTier(DEFAULT_TIERS, 30).clientRefundBps, 10000);
  assert.equal(resolveTier(DEFAULT_TIERS, 7).clientRefundBps, 10000);
  assert.equal(resolveTier(DEFAULT_TIERS, 6).clientRefundBps, 7000);
  assert.equal(resolveTier(DEFAULT_TIERS, 3).clientRefundBps, 7000);
  assert.equal(resolveTier(DEFAULT_TIERS, 2).clientRefundBps, 4000);
  assert.equal(resolveTier(DEFAULT_TIERS, 1).clientRefundBps, 4000);
  assert.equal(resolveTier(DEFAULT_TIERS, 0).clientRefundBps, 1500);

  // After the event.
  assert.throws(() => resolveTier(DEFAULT_TIERS, -1), /already taken place/i);

  // A set with a hole. #8 makes this unsaveable; if one ever arrives it must
  // not be papered over — refunding everything harms the artist and refunding
  // nothing is FCCPA exposure.
  const holed: CancellationTierSnapshot[] = [
    { minDaysBefore: 5, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
    { minDaysBefore: 0, maxDaysBefore: 1, clientRefundBps: 1500, artistCompensationBps: 8500 },
  ];
  assert.throws(() => resolveTier(holed, 3), /No cancellation tier covers 3/);

  assert.throws(() => resolveTier([], 3), /no cancellation terms/i);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeUser(role: UserRole) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  return prisma.user.create({
    data: {
      email: `ccx${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

/** A funded booking whose event is `daysOut` days away, in Lagos terms. */
async function funded({
  daysOut = 10,
  amountKobo = N(200000),
  tiers = DEFAULT_TIERS,
  state = 'FUNDED_HELD',
}: {
  daysOut?: number;
  amountKobo?: Kobo;
  tiers?: CancellationTierSnapshot[];
  state?: BookingState;
} = {}) {
  const admin = await makeUser('SUPER_ADMIN');
  await prisma.commissionRate.create({
    data: { rateBasisPoints: 500, effectiveFrom: new Date(), setByUserId: admin.id },
  });
  await prisma.cancellationTier.createMany({
    data: tierSetFor(tiers).map((t: any) => ({
      ...t,
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
      baseRateKobo: amountKobo,
      profileComplete: true,
    },
  });

  let booking = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo,
    eventDate: new Date(Date.now() + Math.max(daysOut, 1) * 86400000),
  });

  // Placed precisely, at midday Lagos, so the day count is unambiguous.
  const eventDate = new Date(Date.now() + daysOut * 86400000);
  eventDate.setUTCHours(11, 0, 0, 0);

  booking = await prisma.booking.update({
    where: { id: booking.id },
    data: {
      eventDate,
      eventEndAt: new Date(eventDate.getTime() + 3 * 3600_000),
      cancellationTiersSnapshot: tiers as unknown as import('@prisma/client').Prisma.InputJsonValue,
      ...(state === 'PENDING_PAYMENT'
        ? {}
        : { state, escrowId: `TXN_${uniq()}` }),
    },
  });

  if (state !== 'PENDING_PAYMENT') {
    await prisma.$transaction((tx: PrismaTx) => ledger.recordFunding(tx, booking));
  }

  return { booking, artist, artistUser, clientUser, amountKobo };
}

async function login(email: string) {
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return ((await res.json()) as any).token as string;
}

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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

/** Records every provider instruction, so order and amounts can be asserted. */
function recordingProvider() {
  const calls: { leg: string; amountKobo: number; reference: string }[] = [];
  return {
    calls,
    overrides: {
      release: async (args: any) => {
        calls.push({ leg: 'release', amountKobo: args.amountKobo, reference: args.reference });
        return { id: `REL_${uniq()}`, status: 'completed' };
      },
      refund: async (args: any) => {
        calls.push({ leg: 'refund', amountKobo: args.amountKobo, reference: args.reference });
        return { id: `RFD_${uniq()}`, status: 'completed' };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Criterion: each tier produces the documented split
// ---------------------------------------------------------------------------

describe('each tier produces the documented split', async () => {
  // ₦200,000 at 5% commission, one case per band of docs/05 §5.
  const cases: [number, number, number, number][] = [
    // daysOut, refund bps, client refund kobo, artist compensation kobo
    [10, 10000, N(200000), 0],
    [5, 7000, N(140000), N(60000) - N(3000)],
    [2, 4000, N(80000), N(120000) - N(6000)],
    [0, 1500, N(30000), N(170000) - N(8500)],
  ];

  for (const [daysOut, bps, expectedRefund, expectedCompensation] of cases) {
    const { booking, clientUser } = await funded({ daysOut });
    const token = await login(clientUser.email);

    const preview = await call('GET', `/bookings/${booking.id}/cancellation-preview`, token);
    assert.equal(preview.status, 200, `${daysOut} days out`);
    assert.equal(preview.body.preview.appliedTier.clientRefundBps, bps, `${daysOut} days out`);
    assert.equal(preview.body.preview.clientRefundKobo, expectedRefund, `${daysOut} days out`);
    assert.equal(
      preview.body.preview.artistCompensationKobo,
      expectedCompensation,
      `${daysOut} days out`
    );

    const provider = recordingProvider();
    const res = await withProvider(provider.overrides, () =>
      call('POST', `/bookings/${booking.id}/cancel`, token, { reason: 'Plans changed.' })
    );

    assert.equal(res.status, 200, `${daysOut} days out: ${res.body.error}`);
    assert.equal(res.body.cancellation.clientRefundKobo, expectedRefund);
    assert.equal(res.body.cancellation.artistCompensationKobo, expectedCompensation);

    // THE PREVIEW AND THE EXECUTION MUST AGREE TO THE KOBO. A preview that
    // rounds differently from the thing it previews is the failure docs/00 §10
    // exists to prevent, with extra steps.
    assert.equal(res.body.cancellation.clientRefundKobo, preview.body.preview.clientRefundKobo);
    assert.equal(
      res.body.cancellation.artistCompensationKobo,
      preview.body.preview.artistCompensationKobo
    );

    // The two shares sum to the booking total exactly — R2, docs/05 §4.
    const commission = preview.body.preview.commissionKobo;
    assert.equal(
      res.body.cancellation.clientRefundKobo +
        res.body.cancellation.artistCompensationKobo +
        commission,
      N(200000),
      `${daysOut} days out: the split does not sum to the booking total`
    );

    // The artist is instructed BEFORE the client. Both legs are retryable, so
    // the order decides who waits — and it is not the party who chose this.
    const legs = provider.calls.map((c) => c.leg);
    if (expectedCompensation > 0) {
      assert.deepEqual(legs, ['release', 'refund'], `${daysOut} days out: wrong order`);
    } else {
      // A zero leg is skipped, not sent as a zero-amount instruction.
      assert.deepEqual(legs, ['refund'], `${daysOut} days out: a zero leg was sent`);
    }

    const entries = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });
    assert.equal(
      entries.reduce((sum: number, e: LedgerEntryRow) => sum + e.amountKobo, 0),
      0,
      `${daysOut} days out: the ledger must sum to zero`
    );
  }
});

// ---------------------------------------------------------------------------
// Criterion: the ₦0 floor
// ---------------------------------------------------------------------------

test('a refund can never be negative, whatever the fees', () => {
  // At the provider's minimum of ₦20,000 and the harshest band, the client's
  // share is ₦3,000 against a money-in fee of ₦400 — a floor is not reached by
  // the default table. It is asserted across the whole permitted range anyway,
  // because the table is configuration and a future one could get there.
  for (const amount of [N(20000), N(50000), N(126667), N(250000), N(3000000)]) {
    for (const tier of DEFAULT_TIERS) {
      const b = computeClientCancellation({
        amountKobo: amount,
        commissionBps: 500,
        clientRefundBps: tier.clientRefundBps,
        artistCompensationBps: tier.artistCompensationBps,
      });

      assert.ok(b.clientRefundKobo >= 0, `${amount} at ${tier.clientRefundBps} bps went negative`);
      assert.ok(b.artistCompensationKobo >= 0);
      assert.ok(b.unrecoveredShortfallKobo >= 0);
      assert.ok(Number.isInteger(b.clientRefundKobo));
    }
  }

  // The degenerate band: nothing back at all still floors at zero rather than
  // going below it.
  const nothing = computeClientCancellation({
    amountKobo: N(20000),
    commissionBps: 500,
    clientRefundBps: 0,
    artistCompensationBps: 10000,
  });
  assert.equal(nothing.clientRefundKobo, 0);
  assert.ok(nothing.artistCompensationKobo > 0);
});

// ---------------------------------------------------------------------------
// Criterion: the preview states exact refund, compensation and fees
// ---------------------------------------------------------------------------

describe('the preview states the exact refund, compensation and fees', async () => {
  const { booking, clientUser } = await funded({ daysOut: 5 });
  const token = await login(clientUser.email);

  const { body } = await call('GET', `/bookings/${booking.id}/cancellation-preview`, token);
  const p = body.preview;

  for (const field of [
    'clientRefundKobo',
    'artistCompensationKobo',
    'commissionKobo',
    'clientSunkFeeKobo',
    'moneyOutFeeKobo',
    'unrecoveredShortfallKobo',
    'daysBeforeEvent',
    'appliedTier',
    'amountKobo',
  ]) {
    assert.ok(p[field] !== undefined, `the preview omits ${field}`);
  }

  // Every money figure is an integer number of kobo — no formatted strings, no
  // floats, docs/00 §6.
  for (const field of [
    'clientRefundKobo',
    'artistCompensationKobo',
    'commissionKobo',
    'clientSunkFeeKobo',
    'moneyOutFeeKobo',
    'amountKobo',
  ]) {
    assert.ok(Number.isInteger(p[field]), `${field} is not a kobo integer: ${p[field]}`);
  }

  // The fee the client is most likely to feel misled about: paid at funding, on
  // top of the amount, and consumed whether or not the event happens.
  assert.ok(p.clientSunkFeeKobo > 0, 'the sunk money-in fee is not disclosed');

  // And the exact tier, not a description of it.
  assert.equal(p.appliedTier.clientRefundBps, 7000);
  assert.equal(p.appliedTier.artistCompensationBps, 3000);
});

describe('the artist can see what a cancellation today would pay them', async () => {
  const { booking, artistUser } = await funded({ daysOut: 2 });
  const token = await login(artistUser.email);

  const res = await call('GET', `/bookings/${booking.id}/cancellation-preview`, token);
  assert.equal(res.status, 200, 'it is the artist’s date being held');
  assert.equal(res.body.preview.artistCompensationKobo, N(120000) - N(6000));
});

describe('a stranger sees neither the preview nor the booking', async () => {
  const { booking } = await funded();
  const stranger = await makeUser('CLIENT');
  await prisma.client.create({ data: { userId: stranger.id, displayName: 'Stranger' } });
  const token = await login(stranger.email);

  assert.equal(
    (await call('GET', `/bookings/${booking.id}/cancellation-preview`, token)).status,
    404
  );
  assert.equal((await call('POST', `/bookings/${booking.id}/cancel`, token, {})).status, 404);
});

// ---------------------------------------------------------------------------
// Criterion: an older tier table still governs an older booking
// ---------------------------------------------------------------------------

describe('a booking made under an older tier table is cancelled under that table', async () => {
  // The booking is snapshotted with a generous old table.
  const OLD: CancellationTierSnapshot[] = [
    { minDaysBefore: 1, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
    { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 9000, artistCompensationBps: 1000 },
  ];

  const { booking, clientUser } = await funded({ daysOut: 2, tiers: OLD });
  const token = await login(clientUser.email);

  // The platform then replaces the live table with something much harsher.
  const admin = await makeUser('SUPER_ADMIN');
  await prisma.cancellationTier.createMany({
    data: tierSetFor(DEFAULT_TIERS).map((t: any) => ({
      ...t,
      effectiveFrom: new Date(),
      setByUserId: admin.id,
    })),
  });

  const preview = await call('GET', `/bookings/${booking.id}/cancellation-preview`, token);

  // Two days out: the live table would refund 40%. The snapshot says 100%.
  assert.equal(preview.body.preview.appliedTier.clientRefundBps, 10000);
  assert.equal(preview.body.preview.clientRefundKobo, N(200000));

  const provider = recordingProvider();
  const res = await withProvider(provider.overrides, () =>
    call('POST', `/bookings/${booking.id}/cancel`, token, {})
  );

  assert.equal(res.body.cancellation.clientRefundKobo, N(200000));
  assert.equal(res.body.cancellation.artistCompensationKobo, 0);

  // The cancellation record keeps a COPY of the tier, not a pointer to a
  // version — so editing a table later cannot change what a settled
  // cancellation meant.
  const record = await prisma.cancellation.findUnique({ where: { bookingId: booking.id } });
  assert.equal((record.appliedTier as any).clientRefundBps, 10000);
  assert.equal(record.initiatedBy, 'CLIENT');
  assert.equal(record.daysBeforeEvent, 2);
  assert.equal(record.feeBearer, 'CLIENT');
});

// ---------------------------------------------------------------------------
// The rest of the path
// ---------------------------------------------------------------------------

describe('an unfunded booking is simply withdrawn — no tier, no money', async () => {
  const { booking, clientUser } = await funded({ daysOut: 1, state: 'PENDING_PAYMENT' });
  const token = await login(clientUser.email);

  const res = await withProvider(
    {
      release: async () => {
        throw new Error('nothing may be released for an unfunded booking');
      },
      refund: async () => {
        throw new Error('nothing may be refunded for an unfunded booking');
      },
    },
    () => call('POST', `/bookings/${booking.id}/cancel`, token, {})
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.cancellation.unfunded, true);
  assert.equal(res.body.cancellation.clientRefundKobo, 0);

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'CANCELLED');
  assert.ok(after.cancelledAt);

  // No money moved, so no money entries were written.
  const moved = await prisma.ledgerEntry.findMany({
    where: { bookingId: booking.id, entryType: { in: ['REFUNDED', 'ARTIST_COMPENSATION'] } },
  });
  assert.equal(moved.length, 0);
});

describe('cancelling twice does not pay twice', async () => {
  const { booking, clientUser } = await funded({ daysOut: 5 });
  const token = await login(clientUser.email);

  const provider = recordingProvider();
  await withProvider(provider.overrides, () =>
    call('POST', `/bookings/${booking.id}/cancel`, token, {})
  );
  assert.equal(provider.calls.length, 2);

  // The second attempt must not reach the provider at all.
  const second = await withProvider(
    {
      release: async () => {
        throw new Error('release must not be called twice');
      },
      refund: async () => {
        throw new Error('refund must not be called twice');
      },
    },
    () => call('POST', `/bookings/${booking.id}/cancel`, token, {})
  );

  assert.equal(second.status, 200);
  assert.equal(second.body.cancellation.alreadyCancelled, true);

  assert.equal(await prisma.cancellation.count({ where: { bookingId: booking.id } }), 1);
  const refunds = await prisma.ledgerEntry.findMany({
    where: { bookingId: booking.id, entryType: 'REFUNDED' },
  });
  assert.equal(refunds.length, 1);
});

describe('a booking that has already concluded cannot be cancelled', async () => {
  for (const state of ['RELEASED', 'REFUNDED', 'CANCELLED', 'CHECKED_IN'] as BookingState[]) {
    const { booking, clientUser } = await funded({ daysOut: 5 });
    await prisma.booking.update({ where: { id: booking.id }, data: { state } });
    const token = await login(clientUser.email);

    const res = await withProvider(
      {
        release: async () => {
          throw new Error(`nothing may move from ${state}`);
        },
        refund: async () => {
          throw new Error(`nothing may move from ${state}`);
        },
      },
      () => call('POST', `/bookings/${booking.id}/cancel`, token, {})
    );

    if (state === 'CANCELLED') {
      assert.equal(res.status, 200, 'an already-cancelled booking reports, it does not error');
      assert.equal(res.body.cancellation.alreadyCancelled, true);
    } else {
      assert.equal(res.status, 409, `${state} was accepted`);
      assert.doesNotMatch(res.body.error, /[A-Z]{3,}_[A-Z]/, `${state} leaked its enum name`);
    }
  }
});

describe('an artist on this path gets the artist economics, not the client ones', async () => {
  const { booking, artistUser, amountKobo } = await funded({ daysOut: 5 });
  const token = await login(artistUser.email);

  // One endpoint, two economic events, decided by who is calling (docs/02 §7).
  // Until #28 this returned 403; the route now dispatches on the caller's part
  // in the booking, resolved server-side from the token.
  const provider = recordingProvider();
  const res = await withProvider(provider.overrides, () =>
    call('POST', `/bookings/${booking.id}/cancel`, token, {})
  );

  assert.equal(res.status, 200);

  // Five days out, a CLIENT cancellation would refund 70% and compensate the
  // artist. An ARTIST cancellation returns everything and compensates nobody.
  assert.equal(res.body.cancellation.clientRefundKobo, amountKobo);
  assert.equal(res.body.cancellation.artistCompensationKobo, 0);
  assert.equal(res.body.cancellation.appliedTier, null);

  const record = await prisma.cancellation.findUnique({ where: { bookingId: booking.id } });
  assert.equal(record.initiatedBy, 'ARTIST');
  assert.equal(record.feeBearer, 'ARTIST');
});
