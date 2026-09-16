/**
 * Artist-initiated cancellation and fee liability — issue #28.
 *
 * This case has a structural problem the client case does not: the artist bears
 * the fees and has no money in escrow to deduct them from. The client's payment
 * is the only money in the transaction, and all of it is going back to the
 * client. The platform fronts the cost and recovers it from the artist's next
 * payout — the second criterion below follows that money all the way through.
 */

process.env.QUEUE_PREFIX = `test-artistcxl-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('artistcxl');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const bookingService = require('../src/services/bookingService.ts');
const escrowService = require('../src/services/escrowService.ts');
const strikeService = require('../src/services/strikeService.ts');
const ledger = require('../src/services/ledgerService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const {
  computeArtistCancellation,
  computeCompletion,
} = require('../src/services/feeService.ts');

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
 * `resolveTierSet` returns the rows sharing the latest version's id, so giving
 * each row its own id snapshots a SINGLE band onto the booking — and its
 * cancellation then has no applicable rule for most days. Caught in #28 by a
 * 500 at cancellation, with the money already held.
 */
function tierSetFor<T>(tiers: T[]): (T & { versionId: string })[] {
  const versionId = `v_${uniq()}`;
  return tiers.map((t) => ({ ...t, versionId }));
}
const N = (naira: number) => naira * 100;

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
      email: `acx${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

async function seedConfig(setByUserId: string) {
  await prisma.commissionRate.create({
    data: { rateBasisPoints: 500, effectiveFrom: new Date(), setByUserId },
  });
  await prisma.cancellationTier.createMany({
    data: tierSetFor(DEFAULT_TIERS).map((t: any) => ({
      ...t,
      effectiveFrom: new Date(),
      setByUserId,
    })),
  });
}

/** A funded booking whose event is `daysOut` days away. */
async function funded({
  daysOut = 5,
  amountKobo = N(200000),
  state = 'FUNDED_HELD',
  artistUser = null as UserRow | null,
}: {
  daysOut?: number;
  amountKobo?: Kobo;
  state?: BookingState;
  artistUser?: UserRow | null;
} = {}) {
  const admin = await makeUser('SUPER_ADMIN');
  await seedConfig(admin.id);

  const clientUser = await makeUser('CLIENT');
  await prisma.client.create({ data: { userId: clientUser.id, displayName: 'Client' } });

  const au = artistUser ?? (await makeUser('ARTIST'));

  // Artist.userId is unique, so a repeat artist reuses their profile — which is
  // exactly what the settlement test needs: the liability follows the ARTIST
  // across bookings, not the profile.
  const artist =
    (await prisma.artist.findUnique({ where: { userId: au.id } })) ??
    (await prisma.artist.create({
      data: {
        userId: au.id,
        stageName: `Artist ${uniq()}`,
        category: 'Afrobeats',
        location: 'Lagos',
        baseRateKobo: amountKobo,
        profileComplete: true,
      },
    }));

  let booking = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo,
    eventDate: new Date(Date.now() + Math.max(daysOut, 1) * 86400000),
  });

  const eventDate = new Date(Date.now() + daysOut * 86400000);
  eventDate.setUTCHours(11, 0, 0, 0);

  booking = await prisma.booking.update({
    where: { id: booking.id },
    data: {
      eventDate,
      eventEndAt: new Date(eventDate.getTime() + 3 * 3600_000),
      ...(state === 'PENDING_PAYMENT' ? {} : { state, escrowId: `TXN_${uniq()}` }),
    },
  });

  if (state !== 'PENDING_PAYMENT') {
    await prisma.$transaction((tx: PrismaTx) => ledger.recordFunding(tx, booking));
  }

  return { booking, artist, artistUser: au, clientUser, amountKobo };
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

const moves = {
  refund: async () => ({ id: `RFD_${uniq()}`, status: 'completed' }),
  release: async () => ({ id: `REL_${uniq()}`, status: 'completed' }),
};

const sum = (entries: LedgerEntryRow[]) =>
  entries.reduce((total: number, e: LedgerEntryRow) => total + e.amountKobo, 0);

// ---------------------------------------------------------------------------
// Criterion: the client receives the FULL amount, not a fee-reduced one
// ---------------------------------------------------------------------------

describe('the client gets the whole booking amount back, plus the fee they paid', async () => {
  const { booking, clientUser, amountKobo } = await funded({ daysOut: 2 });
  const artistToken = await login((await prisma.user.findUnique({
    where: { id: (await prisma.artist.findUnique({ where: { id: booking.artistId } })).userId },
  })).email);

  const res = await withProvider(moves, () =>
    call('POST', `/bookings/${booking.id}/cancel`, artistToken, { reason: 'Double booked.' })
  );

  assert.equal(res.status, 200, res.body.error);

  const expected = computeArtistCancellation({ amountKobo });

  // ZERO FEE EXPOSURE means zero. The escrow back, AND the money-in fee they
  // paid on top of it at funding.
  assert.equal(res.body.cancellation.clientRefundKobo, amountKobo);
  assert.equal(res.body.cancellation.clientFeeReimbursementKobo, expected.moneyInFeeKobo);
  assert.ok(expected.moneyInFeeKobo > 0, 'the fixture must have a real fee to reimburse');

  // The timing band does not reduce it. Two days out is the harshest band a
  // CLIENT cancellation has, and it changes nothing here.
  assert.equal(res.body.cancellation.artistCompensationKobo, 0);
  assert.equal(res.body.cancellation.appliedTier, null, 'no tier applies to an artist cancellation');

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'REFUNDED');
  assert.ok(clientUser);
});

// ---------------------------------------------------------------------------
// Criterion: the liability is created and later netted off the next release
// ---------------------------------------------------------------------------

describe('the liability is created, then netted off the artist’s next payout', async () => {
  // Booking one: the artist cancels, and the platform fronts the cost.
  const first = await funded({ daysOut: 2 });
  const artistToken = await login(first.artistUser.email);

  await withProvider(moves, () =>
    call('POST', `/bookings/${first.booking.id}/cancel`, artistToken, {})
  );

  const expected = computeArtistCancellation({ amountKobo: first.amountKobo });

  const liability = await prisma.feeLiability.findFirst({
    where: { originBookingId: first.booking.id },
  });
  assert.ok(liability, 'no fee liability was accrued');
  assert.equal(liability.artistUserId, first.artistUser.id);
  assert.equal(liability.amountKobo, expected.feeLiabilityKobo);
  assert.equal(liability.status, 'OUTSTANDING');

  // Booking two: the SAME artist completes a booking and is paid.
  const second = await funded({ daysOut: 30, artistUser: first.artistUser });
  await prisma.booking.update({
    where: { id: second.booking.id },
    data: { state: 'AWAITING_CONFIRMATION' },
  });

  const release = await withProvider(moves, () =>
    escrowService.releaseBooking({ bookingId: second.booking.id, reason: 'Completed' })
  );

  const completion = computeCompletion({
    amountKobo: second.amountKobo,
    commissionBps: second.booking.commissionRateBpsSnapshot,
  });

  // The artist is paid their net MINUS the liability they owed.
  assert.equal(
    release.artistPayoutKobo,
    completion.artistNetKobo - expected.feeLiabilityKobo,
    'the liability was not netted off'
  );

  const settled = await prisma.feeLiability.findUnique({ where: { id: liability.id } });
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.settledAgainstBookingId, second.booking.id);
  assert.ok(settled.settledAt);
});

// ---------------------------------------------------------------------------
// Criterion: the ledger shows the platform bearing the cost, then recovering it
// ---------------------------------------------------------------------------

describe('the ledger shows the platform bearing the cost and then recovering it', async () => {
  const first = await funded({ daysOut: 2 });
  const artistToken = await login(first.artistUser.email);

  await withProvider(moves, () =>
    call('POST', `/bookings/${first.booking.id}/cancel`, artistToken, {})
  );

  const expected = computeArtistCancellation({ amountKobo: first.amountKobo });

  // At cancellation: the platform is out of pocket and the artist owes it.
  const cancelEntries = await prisma.ledgerEntry.findMany({
    where: { bookingId: first.booking.id },
  });

  const accrued = cancelEntries.filter(
    (e: LedgerEntryRow) => e.entryType === 'FEE_LIABILITY_ACCRUED'
  );
  assert.equal(accrued.length, 2, 'a liability is a pair of entries, not one');

  const platformSide = accrued.find((e: LedgerEntryRow) => e.party === 'PLATFORM');
  const artistSide = accrued.find((e: LedgerEntryRow) => e.party === 'ARTIST');
  assert.equal(platformSide.amountKobo, expected.feeLiabilityKobo);
  assert.equal(artistSide.amountKobo, -expected.feeLiabilityKobo);

  // The money-in fee reimbursed to the client is fronted by the platform.
  const reimbursement = cancelEntries.filter(
    (e: LedgerEntryRow) => e.entryType === 'ESCROW_FEE_IN' && e.party === 'PLATFORM'
  );
  assert.equal(reimbursement[0].amountKobo, -expected.moneyInFeeKobo);

  assert.equal(sum(cancelEntries), 0, 'the cancellation must reconcile to zero on its own');

  // At settlement: recorded on the booking whose payout settles it, both sides,
  // so THAT booking also reconciles to zero on its own.
  const second = await funded({ daysOut: 30, artistUser: first.artistUser });
  await prisma.booking.update({
    where: { id: second.booking.id },
    data: { state: 'AWAITING_CONFIRMATION' },
  });
  await withProvider(moves, () =>
    escrowService.releaseBooking({ bookingId: second.booking.id, reason: 'Completed' })
  );

  const settleEntries = await prisma.ledgerEntry.findMany({
    where: { bookingId: second.booking.id, entryType: 'FEE_LIABILITY_SETTLED' },
  });
  assert.equal(settleEntries.length, 2);
  assert.equal(
    sum(await prisma.ledgerEntry.findMany({ where: { bookingId: second.booking.id } })),
    0
  );

  // The two bookings together: the platform recovered exactly what it fronted.
  //
  // Measured as CASH OUT versus CASH IN — the fees it actually paid against the
  // amount it actually recovered. `FEE_LIABILITY_ACCRUED(PLATFORM)` is
  // deliberately excluded: it is a RECEIVABLE, the bookkeeping counterpart that
  // lets the cancellation balance on its own, not a second inflow. Adding it to
  // the recovery would count the same ₦2,070 twice, which is what a first
  // version of this assertion did.
  // Scoped per booking, because booking two has a payout fee of its own — an
  // ordinary cost of paying an artist, nothing to do with the liability. A
  // first version of this swept it in and reported the platform ₦70 short.
  const fronted = await prisma.ledgerEntry.findMany({
    where: {
      bookingId: first.booking.id,
      party: 'PLATFORM',
      entryType: { in: ['ESCROW_FEE_IN', 'ESCROW_FEE_OUT'] },
    },
  });
  const recovered = await prisma.ledgerEntry.findMany({
    where: {
      bookingId: second.booking.id,
      party: 'PLATFORM',
      entryType: 'FEE_LIABILITY_SETTLED',
    },
  });

  assert.equal(sum(fronted), -expected.feeLiabilityKobo, 'the platform fronted a different amount');
  assert.equal(sum(fronted) + sum(recovered), 0, 'the platform did not end up whole');

  // And the receivable it raised equals what it went on to collect.
  const receivable = await prisma.ledgerEntry.findFirst({
    where: {
      bookingId: first.booking.id,
      party: 'PLATFORM',
      entryType: 'FEE_LIABILITY_ACCRUED',
    },
  });
  const collected = await prisma.ledgerEntry.findFirst({
    where: {
      bookingId: second.booking.id,
      party: 'PLATFORM',
      entryType: 'FEE_LIABILITY_SETTLED',
    },
  });
  assert.equal(receivable.amountKobo, collected.amountKobo);
});

// ---------------------------------------------------------------------------
// Criterion: the correct strike weight for the timing band
// ---------------------------------------------------------------------------

describe('cancelling triggers the strike weight for the timing band', async () => {
  const { rules } = await strikeService.resolveRules();
  const weightOf = (trigger: StrikeTrigger) =>
    rules.find((r: StrikeRuleRow) => r.trigger === trigger).weight;

  const cases: [number, StrikeTrigger | null][] = [
    [10, null],
    [7, null],
    [5, 'ARTIST_CANCEL_3_6_DAYS'],
    [2, 'ARTIST_CANCEL_1_2_DAYS'],
    [0, 'ARTIST_CANCEL_DAY_OF'],
  ];

  for (const [daysOut, expected] of cases) {
    const { booking, artistUser } = await funded({ daysOut });
    const token = await login(artistUser.email);

    await withProvider(moves, () => call('POST', `/bookings/${booking.id}/cancel`, token, {}));

    const strikes = await prisma.strike.findMany({ where: { bookingId: booking.id } });

    if (expected === null) {
      // Seven days out is a normal business event: the fee liability is still
      // incurred, because the fees were still paid, but there is nothing to
      // deter — a week is enough time for the client to rebook.
      assert.equal(strikes.length, 0, `${daysOut} days out produced a strike`);

      const liability = await prisma.feeLiability.findFirst({
        where: { originBookingId: booking.id },
      });
      assert.ok(liability, `${daysOut} days out: liability missing though no strike is due`);
    } else {
      assert.equal(strikes.length, 1, `${daysOut} days out`);
      assert.equal(strikes[0].trigger, expected, `${daysOut} days out`);
      assert.equal(strikes[0].weight, weightOf(expected), `${daysOut} days out`);
      assert.equal(strikes[0].bookingId, booking.id);
      assert.match(strikes[0].reason, /Artist cancelled/);
    }
  }
});

// ---------------------------------------------------------------------------
// Everything commits together, or nothing does
// ---------------------------------------------------------------------------

describe('a failed strike write leaves no refund behind', async () => {
  const { booking, artistUser } = await funded({ daysOut: 2 });
  const token = await login(artistUser.email);

  const original = strikeService.accrueForCancellation;
  strikeService.accrueForCancellation = async () => {
    throw new Error('strike table unavailable');
  };

  try {
    const res = await withProvider(moves, () =>
      call('POST', `/bookings/${booking.id}/cancel`, token, {})
    );
    assert.equal(res.status, 500);
  } finally {
    strikeService.accrueForCancellation = original;
  }

  // The provider call already happened — it is irreversible and idempotent
  // under its reference — but NOTHING was recorded, so a retry redoes the whole
  // thing rather than leaving a refund nobody can explain.
  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'FUNDED_HELD', 'the booking moved despite the failure');
  assert.equal(await prisma.cancellation.count({ where: { bookingId: booking.id } }), 0);
  assert.equal(await prisma.feeLiability.count({ where: { originBookingId: booking.id } }), 0);
  assert.equal(
    await prisma.ledgerEntry.count({ where: { bookingId: booking.id, entryType: 'REFUNDED' } }),
    0
  );

  // And the retry completes it.
  const retry = await withProvider(moves, () =>
    call('POST', `/bookings/${booking.id}/cancel`, token, {})
  );
  assert.equal(retry.status, 200);
  assert.equal(await prisma.feeLiability.count({ where: { originBookingId: booking.id } }), 1);
});

// ---------------------------------------------------------------------------
// The rest
// ---------------------------------------------------------------------------

describe('the cancellation record says who cancelled and who pays', async () => {
  const { booking, artistUser } = await funded({ daysOut: 5 });
  const token = await login(artistUser.email);

  await withProvider(moves, () => call('POST', `/bookings/${booking.id}/cancel`, token, {}));

  const record = await prisma.cancellation.findUnique({ where: { bookingId: booking.id } });
  assert.equal(record.initiatedBy, 'ARTIST');
  assert.equal(record.initiatedByUserId, artistUser.id);
  assert.equal(record.feeBearer, 'ARTIST');
  assert.equal(record.daysBeforeEvent, 5);
  assert.equal(record.artistCompensationKobo, 0);
});

describe('an unfunded booking still costs the artist a strike, but no money', async () => {
  const { booking, artistUser } = await funded({ daysOut: 0, state: 'PENDING_PAYMENT' });
  const token = await login(artistUser.email);

  const res = await withProvider(
    {
      refund: async () => {
        throw new Error('nothing may be refunded for an unfunded booking');
      },
      release: async () => {
        throw new Error('nothing may be released for an unfunded booking');
      },
    },
    () => call('POST', `/bookings/${booking.id}/cancel`, token, {})
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.cancellation.unfunded, true);

  // No fees were incurred, so there is nothing to front.
  assert.equal(await prisma.feeLiability.count({ where: { originBookingId: booking.id } }), 0);

  // But the client has lost the date either way.
  const strikes = await prisma.strike.findMany({ where: { bookingId: booking.id } });
  assert.equal(strikes.length, 1);
  assert.equal(strikes[0].trigger, 'ARTIST_CANCEL_DAY_OF');
});

describe('one endpoint, two economic events, decided by who is calling', async () => {
  // docs/02 §7. The role comes from the token against the booking, never from
  // the body — these are different events, not one event with a parameter.
  const { booking, artistUser, clientUser, amountKobo } = await funded({ daysOut: 2 });

  const clientToken = await login(clientUser.email);
  const clientResult = await withProvider(moves, () =>
    call('POST', `/bookings/${booking.id}/cancel`, clientToken, {})
  );

  assert.equal(clientResult.status, 200, JSON.stringify(clientResult.body));

  // Two days out, a CLIENT cancellation returns 40% and compensates the artist.
  assert.equal(clientResult.body.cancellation.clientRefundKobo, N(80000));
  assert.ok(clientResult.body.cancellation.artistCompensationKobo > 0);

  // The same booking, had the artist cancelled instead, returns everything.
  const other = await funded({ daysOut: 2, amountKobo });
  const otherToken = await login(other.artistUser.email);
  const artistResult = await withProvider(moves, () =>
    call('POST', `/bookings/${other.booking.id}/cancel`, otherToken, {})
  );

  assert.equal(artistResult.body.cancellation.clientRefundKobo, amountKobo);
  assert.equal(artistResult.body.cancellation.artistCompensationKobo, 0);
  assert.ok(artistUser);
});

describe('an outstanding liability can be written off, and stays on the record', async () => {
  const { booking, artistUser } = await funded({ daysOut: 2 });
  const token = await login(artistUser.email);
  await withProvider(moves, () => call('POST', `/bookings/${booking.id}/cancel`, token, {}));

  const admin = await makeUser('ADMIN');
  const adminToken = await login(admin.email);

  // A reason is mandatory, like every other manual money decision.
  const noReason = await call(
    'POST',
    `/admin/users/${artistUser.id}/fee-liabilities/write-off`,
    adminToken,
    {}
  );
  assert.equal(noReason.status, 400);

  const res = await call(
    'POST',
    `/admin/users/${artistUser.id}/fee-liabilities/write-off`,
    adminToken,
    { reason: 'Account closed; pursuing ₦2,070 costs more than the debt.' }
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.writeOff.writtenOff, 1);

  // WRITTEN OFF, NOT DELETED. The platform bore that cost and the ledger has to
  // keep saying so.
  const liability = await prisma.feeLiability.findFirst({
    where: { originBookingId: booking.id },
  });
  assert.equal(liability.status, 'WRITTEN_OFF');
  assert.ok(liability.writtenOffAt);
  assert.match(liability.writeOffReason, /Account closed/);

  const audit = await prisma.auditLog.findFirst({
    where: { action: 'FEE_LIABILITIES_WRITTEN_OFF', entityId: artistUser.id },
  });
  assert.ok(audit, 'a write-off must be attributable');
  assert.equal(audit.actorUserId, admin.id);

  // And a written-off liability is not settled against a later payout.
  const second = await funded({ daysOut: 30, artistUser });
  await prisma.booking.update({
    where: { id: second.booking.id },
    data: { state: 'AWAITING_CONFIRMATION' },
  });
  const release = await withProvider(moves, () =>
    escrowService.releaseBooking({ bookingId: second.booking.id, reason: 'Completed' })
  );
  assert.equal(release.liabilitySettledKobo, 0, 'a written-off liability was collected anyway');
});
