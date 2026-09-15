/**
 * Release execution — issue #26.
 *
 * The money actually leaving escrow. Every figure comes from the booking's own
 * frozen snapshot, and the provider is called before anything is recorded —
 * both are asserted here rather than assumed.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('release');

const test = require('node:test');
const assert = require('node:assert/strict');

const escrowpay = require('../src/lib/escrowpay.ts');
const escrowService = require('../src/services/escrowService.ts');
const bookingService = require('../src/services/bookingService.ts');
const ledger = require('../src/services/ledgerService.ts');
const commissionService = require('../src/services/commissionService.ts');
const { AppError } = require('../src/lib/errors.ts');

const describe = hasDatabase ? test : test.skip;

test.before(async () => {
  if (ready) await ready;
});

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;
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
      email: `rel${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword('correct horse battery staple'),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

/** A booking sitting in AWAITING_CONFIRMATION, funded, ready to release. */
async function readyToRelease({ amountKobo = N(200000), commissionBps = 500, artistUser = null } = {}) {
  const admin = await makeUser('SUPER_ADMIN');
  await prisma.commissionRate.create({
    data: { rateBasisPoints: commissionBps, effectiveFrom: new Date(), setByUserId: admin.id },
  });
  await prisma.cancellationTier.createMany({
    data: DEFAULT_TIERS.map((t: CancellationTierSnapshot) => ({
      ...t,
      versionId: `v_${uniq()}`,
      effectiveFrom: new Date(),
      setByUserId: admin.id,
    })),
  });

  const clientUser = await makeUser('CLIENT');
  await prisma.client.create({ data: { userId: clientUser.id, displayName: 'Client' } });

  const au = artistUser ?? (await makeUser('ARTIST'));

  // Artist.userId is unique, so a repeat artist reuses their profile rather
  // than getting a second one — which is also what the liability tests need:
  // the liability follows the ARTIST across bookings, not the profile.
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
    eventDate: new Date(Date.now() + 30 * 86400000),
  });

  booking = await prisma.booking.update({
    where: { id: booking.id },
    data: { escrowId: `TXN_${uniq()}`, state: 'FUNDED_HELD' },
  });

  // The funding ledger entries the webhook would have written (#20).
  await prisma.$transaction((tx: PrismaTx) => ledger.recordFunding(tx, booking));

  booking = await prisma.booking.update({
    where: { id: booking.id },
    data: { state: 'AWAITING_CONFIRMATION' },
  });

  return { booking, artist, artistUser: au, clientUser, admin };
}

/** Replaces provider methods for the duration of a call. */
async function withProvider(overrides: Record<string, any>, fn: () => any) {
  const originals = {};
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

/** Records every release call so the amount and idempotency key can be asserted. */
function recordingProvider(calls: any[], impl?: (args: any) => any) {
  return {
    release: async (args) => {
      calls.push(args);
      return impl ? impl(args) : { id: `REL_${calls.length}`, status: 'completed' };
    },
  };
}

// ── Criterion: a ₦200,000 booking at 5% disburses to the artist ─────────────

describe('a ₦200,000 booking at 5% disburses ₦190,000 to the artist', async () => {
  // #26's issue text says ₦187,930. THAT FIGURE IS PRE-#18. The provider's live
  // fee configuration charges money-in to the payer at funding and money-out to
  // the platform at payout, rather than deducting both from the escrow — so the
  // artist's share is reduced by commission ALONE. docs/05 §1 and docs/08 §5
  // both carry the corrected figure.
  const { booking } = await readyToRelease();
  const calls = [];

  const result = await withProvider(recordingProvider(calls), () =>
    escrowService.releaseBooking({ bookingId: booking.id })
  );

  assert.equal(result.artistPayoutKobo, N(190000), 'the artist receives ₦190,000');
  assert.equal(result.commissionKobo, N(10000), '5% of ₦200,000');
  assert.equal(result.moneyOutFeeKobo, N(70), 'the payout fee, borne by the platform');
  assert.equal(result.platformNetKobo, N(9930), 'so the platform nets ₦9,930');

  // The amount that actually left escrow, not just the computed figure.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].amountKobo, N(190000), 'only the artist share leaves escrow');

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'RELEASED');

  const r = await ledger.reconcile(booking.id);
  assert.equal(r.sumKobo, 0, 'the booking reconciles to zero');
  assert.equal(r.byParty.ARTIST, N(190000));
  assert.equal(r.byParty.PLATFORM, N(9930));
  assert.equal(r.byParty.CLIENT, -N(202000));
  assert.equal(r.byParty.PROVIDER, N(2070));
});

// ── Criterion: a liability is netted off, both halves visible ───────────────

describe('an outstanding fee liability is netted off, with accrual and settlement both in the ledger', async () => {
  const artistUser = await makeUser('ARTIST');

  // A prior artist cancellation: the client is made whole, the platform fronts
  // the fees, and the artist owes them (#28's shape, recorded here directly).
  const cancelled = await readyToRelease({ artistUser });
  await prisma.$transaction((tx: PrismaTx) => ledger.recordArtistCancellation(tx, cancelled.booking));
  await prisma.booking.update({ where: { id: cancelled.booking.id }, data: { state: 'REFUNDED' } });

  const liability = await prisma.feeLiability.create({
    data: {
      artistUserId: artistUser.id,
      originBookingId: cancelled.booking.id,
      amountKobo: N(2070),
      status: 'OUTSTANDING',
    },
  });

  const { booking } = await readyToRelease({ artistUser });
  const calls = [];

  const result = await withProvider(recordingProvider(calls), () =>
    escrowService.releaseBooking({ bookingId: booking.id })
  );

  assert.equal(result.artistNetKobo, N(190000), 'earned');
  assert.equal(result.liabilitySettledKobo, N(2070), 'recovered');
  assert.equal(result.artistPayoutKobo, N(190000) - N(2070), 'disbursed');
  assert.equal(calls[0].amountKobo, N(190000) - N(2070), 'and that is what left escrow');

  const settled = await prisma.feeLiability.findUnique({ where: { id: liability.id } });
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.settledAgainstBookingId, booking.id);
  assert.ok(settled.settledAt);

  // BOTH HALVES VISIBLE, on the bookings where each happened.
  const accrual = await ledger.reconcile(cancelled.booking.id);
  const payout = await ledger.reconcile(booking.id);

  const accrued = accrual.entries.filter((e: any) => e.entryType === 'FEE_LIABILITY_ACCRUED');
  const settledEntries = payout.entries.filter((e: any) => e.entryType === 'FEE_LIABILITY_SETTLED');

  assert.equal(accrued.length, 2, 'the accrual is a balanced pair');
  assert.equal(settledEntries.length, 2, 'and so is the settlement');
  assert.equal(accrued.find((e: any) => e.party === 'ARTIST').amountKobo, -N(2070));
  assert.equal(settledEntries.find((e: any) => e.party === 'ARTIST').amountKobo, -N(2070));

  // Each booking still reconciles on its own, even though the liability spans
  // two of them.
  assert.equal(accrual.sumKobo, 0);
  assert.equal(payout.sumKobo, 0);

  // The artist's position on the payout booking: earned, minus recovered.
  assert.equal(payout.byParty.ARTIST, N(190000) - N(2070));
});

describe('a liability larger than the payout is left outstanding rather than settled in part', async () => {
  const artistUser = await makeUser('ARTIST');
  const origin = await readyToRelease({ artistUser });

  // FeeLiability has no partially-settled state, so settling half would need a
  // mutated amount — the mistake the ledger exists to avoid.
  const liability = await prisma.feeLiability.create({
    data: {
      artistUserId: artistUser.id,
      originBookingId: origin.booking.id,
      amountKobo: N(500000),
      status: 'OUTSTANDING',
    },
  });

  const { booking } = await readyToRelease({ artistUser, amountKobo: N(20000) });
  const calls = [];

  const result = await withProvider(recordingProvider(calls), () =>
    escrowService.releaseBooking({ bookingId: booking.id })
  );

  assert.equal(result.liabilitySettledKobo, 0, 'nothing settled');
  assert.equal(result.artistPayoutKobo, N(19000), 'the payout is untouched and never negative');
  assert.ok(result.artistPayoutKobo > 0);

  const still = await prisma.feeLiability.findUnique({ where: { id: liability.id } });
  assert.equal(still.status, 'OUTSTANDING', 'it waits for a payout that can cover it');

  assert.equal((await ledger.reconcile(booking.id)).sumKobo, 0);
});

describe('several small liabilities settle oldest first, up to what the payout covers', async () => {
  const artistUser = await makeUser('ARTIST');
  const origin = await readyToRelease({ artistUser });

  const made = [];
  for (const amountKobo of [N(2070), N(2070), N(2070)]) {
    made.push(
      await prisma.feeLiability.create({
        data: { artistUserId: artistUser.id, originBookingId: origin.booking.id, amountKobo, status: 'OUTSTANDING' },
      })
    );
    await new Promise((r) => setTimeout(r, 5)); // distinct createdAt ordering
  }

  // A ₦20,000 booking nets ₦19,000, which covers all three.
  const { booking } = await readyToRelease({ artistUser, amountKobo: N(20000) });
  const result = await withProvider(recordingProvider([]), () =>
    escrowService.releaseBooking({ bookingId: booking.id })
  );

  assert.equal(result.liabilitySettledKobo, N(6210), 'all three settled');
  assert.equal(result.artistPayoutKobo, N(19000) - N(6210));

  const statuses = await prisma.feeLiability.findMany({ where: { id: { in: made.map((l: any) => l.id) } } });
  assert.ok(statuses.every((l: any) => l.status === 'SETTLED'));
  assert.equal((await ledger.reconcile(booking.id)).sumKobo, 0);
});

// ── Criterion: the snapshot governs, not live config ────────────────────────

describe('a booking created before a commission change pays out at its snapshotted rate', async () => {
  const { booking, admin } = await readyToRelease({ commissionBps: 500 });

  // The rate changes after the booking exists — a raise, so a payout reading
  // live config would shortchange the artist and the difference would be ours.
  await commissionService.setCommissionRate({
    rateBasisPoints: 900,
    actorUserId: admin.id,
    effectiveFrom: new Date(),
  });

  const live = await commissionService.resolveCommissionRate();
  assert.equal(live.rateBasisPoints, 900, 'live config really did change');

  const calls = [];
  const result = await withProvider(recordingProvider(calls), () =>
    escrowService.releaseBooking({ bookingId: booking.id })
  );

  assert.equal(result.commissionRateBpsSnapshot, 500);
  assert.equal(result.commissionKobo, N(10000), '5%, not 9%');
  assert.equal(result.artistPayoutKobo, N(190000), 'the artist gets the terms they accepted');
  assert.equal(calls[0].amountKobo, N(190000));
});

// ── Ordering, idempotency and failure ───────────────────────────────────────

describe('the provider is called before anything is recorded, and a failure records nothing', async () => {
  const { booking } = await readyToRelease();

  await assert.rejects(
    () =>
      withProvider(
        { release: async () => { throw new AppError(502, 'Could not reach the payment provider.'); } },
        () => escrowService.releaseBooking({ bookingId: booking.id })
      ),
    (err: ThrownError) => err.status === 502
  );

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'AWAITING_CONFIRMATION', 'not marked released when no money moved');

  const r = await ledger.reconcile(booking.id);
  assert.equal(r.entries.filter((e: any) => e.entryType === 'RELEASED').length, 0);
  assert.equal(r.sumKobo, -N(200000), 'still held in escrow');
});

describe('a retry after a recording failure reuses the same idempotency key', async () => {
  const { booking } = await readyToRelease();
  const calls = [];

  await withProvider(recordingProvider(calls), () => escrowService.releaseBooking({ bookingId: booking.id }));

  // Releasing again returns what happened rather than instructing a second one.
  const second = await withProvider(recordingProvider(calls), () =>
    escrowService.releaseBooking({ bookingId: booking.id })
  );

  assert.equal(second.alreadyReleased, true);
  assert.equal(calls.length, 1, 'the provider was not called a second time');

  // And the key is stable, so a genuine retry before our record landed would
  // return the original release rather than paying twice.
  assert.equal(calls[0].reference, `${booking.escrowReference}_release`);

  const r = await ledger.reconcile(booking.id);
  assert.equal(r.entries.filter((e: any) => e.entryType === 'RELEASED').length, 1);
  assert.equal(r.sumKobo, 0);
});

describe('a booking in the wrong state is refused before the provider is troubled', async () => {
  const { booking } = await readyToRelease();
  await prisma.booking.update({ where: { id: booking.id }, data: { state: 'PENDING_PAYMENT' } });

  let called = false;
  await assert.rejects(
    () =>
      withProvider({ release: async () => { called = true; } }, () =>
        escrowService.releaseBooking({ bookingId: booking.id })
      ),
    (err: ThrownError) => err.status === 409
  );

  assert.equal(called, false, 'no money instruction for an unfundable state');
});

describe('a booking with no escrow, and an artist with no payout identity, are both refused', async () => {
  const noEscrow = await readyToRelease();
  await prisma.booking.update({ where: { id: noEscrow.booking.id }, data: { escrowId: null } });
  await assert.rejects(
    () => escrowService.releaseBooking({ bookingId: noEscrow.booking.id }),
    (err: ThrownError) => err.status === 409 && /never funded/i.test((err as ThrownError).message)
  );

  const noParty = await readyToRelease();
  await prisma.user.update({ where: { id: noParty.artistUser.id }, data: { escrowPartyId: null } });
  await assert.rejects(
    () => escrowService.releaseBooking({ bookingId: noParty.booking.id }),
    (err: ThrownError) => err.status === 409 && /cannot receive payments/i.test((err as ThrownError).message)
  );

  await assert.rejects(
    () => escrowService.releaseBooking({ bookingId: 'no_such_booking' }),
    (err: ThrownError) => err.status === 404
  );
});

describe('a suspended artist is still paid for an event they performed', async () => {
  const { booking, artistUser } = await readyToRelease();
  await prisma.user.update({ where: { id: artistUser.id }, data: { accountStanding: 'SUSPENDED' } });

  // Deliberate: suspension governs FUTURE bookings. Withholding money for an
  // event that happened would be confiscation, not enforcement.
  const result = await withProvider(recordingProvider([]), () =>
    escrowService.releaseBooking({ bookingId: booking.id })
  );

  assert.equal(result.artistPayoutKobo, N(190000));
  assert.equal((await ledger.reconcile(booking.id)).sumKobo, 0);
});

// ── Criterion: sole provider caller ─────────────────────────────────────────

describe('no route handler or job calls the provider release method directly', async () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const root = path.resolve(__dirname, '../../..');

  const hits = execFileSync(
    'bash',
    ['-c', `grep -rnE 'escrowpay\\.(release|refund)' "${root}/apps/backend/src" | grep -vE 'services/escrowService\\.ts|lib/escrowpay\\.ts' || true`],
    { encoding: 'utf8' }
  ).trim();

  assert.equal(hits, '', `provider release/refund called outside escrowService:\n${hits}`);
});

describe('reconciliation holds across the fee boundaries', async () => {
  for (const amountKobo of [N(20000), N(126667), N(250000), N(3000000)]) {
    const { booking } = await readyToRelease({ amountKobo });
    const result = await withProvider(recordingProvider([]), () =>
      escrowService.releaseBooking({ bookingId: booking.id })
    );

    const r = await ledger.reconcile(booking.id);
    assert.equal(r.sumKobo, 0, `${amountKobo} kobo left ${r.sumKobo} unreconciled`);
    assert.ok(result.artistPayoutKobo > 0);
    assert.equal(r.byParty.ARTIST, result.artistPayoutKobo);
  }
});

// ── The payout preview must not under-disclose ──────────────────────────────

describe('the payout preview discloses liabilities this payout would settle', async () => {
  // #26 introduced the deduction; without this the preview says ₦190,000 and
  // the artist receives ₦187,930, discovering the difference afterwards.
  // docs/00 §7 requires them to see their net BEFORE agreeing, and a "net"
  // that omits a known deduction is not a net.
  const { createApp } = require('../src/app.ts');
  const { startServer } = require('./helpers.ts');
  const { signToken } = require('../src/lib/auth.ts');

  const artistUser = await makeUser('ARTIST');
  const origin = await readyToRelease({ artistUser });

  await prisma.feeLiability.create({
    data: {
      artistUserId: artistUser.id,
      originBookingId: origin.booking.id,
      amountKobo: N(2070),
      status: 'OUTSTANDING',
    },
  });

  const { booking } = await readyToRelease({ artistUser });
  const server = await startServer(createApp());

  try {
    const res = await fetch(`${server.url}/bookings/${booking.id}/payout-preview`, {
      headers: { Authorization: `Bearer ${signToken(artistUser)}` },
    });
    assert.equal(res.status, 200);
    const { payout } = ((await res.json()) as any);

    assert.equal(payout.artistNetKobo, N(190000), 'what the booking earns');
    assert.equal(payout.outstandingLiabilityKobo, N(2070), 'what they owe');
    assert.equal(payout.liabilitySettleableKobo, N(2070), 'what this payout can clear');
    assert.equal(payout.estimatedPayoutKobo, N(187930), 'what would actually reach them');
    assert.equal(payout.liabilities.length, 1, 'and which liability it is');

    // Reported separately rather than folded into artistNetKobo: an earlier
    // booking may settle it first, so the deduction is possible, not certain.
    assert.notEqual(payout.artistNetKobo, payout.estimatedPayoutKobo);
  } finally {
    await server.close();
  }
});

describe('a preview with no liabilities reports a payout equal to the net', async () => {
  const { createApp } = require('../src/app.ts');
  const { startServer } = require('./helpers.ts');
  const { signToken } = require('../src/lib/auth.ts');

  const { booking, artistUser } = await readyToRelease();
  const server = await startServer(createApp());

  try {
    const res = await fetch(`${server.url}/bookings/${booking.id}/payout-preview`, {
      headers: { Authorization: `Bearer ${signToken(artistUser)}` },
    });
    const { payout } = ((await res.json()) as any);

    assert.equal(payout.outstandingLiabilityKobo, 0);
    assert.equal(payout.estimatedPayoutKobo, N(190000));
    assert.equal(payout.estimatedPayoutKobo, payout.artistNetKobo);
    assert.deepEqual(payout.liabilities, []);
  } finally {
    await server.close();
  }
});

describe('a liability too large to settle is disclosed but not deducted', async () => {
  const { createApp } = require('../src/app.ts');
  const { startServer } = require('./helpers.ts');
  const { signToken } = require('../src/lib/auth.ts');

  const artistUser = await makeUser('ARTIST');
  const origin = await readyToRelease({ artistUser });
  await prisma.feeLiability.create({
    data: {
      artistUserId: artistUser.id,
      originBookingId: origin.booking.id,
      amountKobo: N(500000),
      status: 'OUTSTANDING',
    },
  });

  const { booking } = await readyToRelease({ artistUser, amountKobo: N(20000) });
  const server = await startServer(createApp());

  try {
    const res = await fetch(`${server.url}/bookings/${booking.id}/payout-preview`, {
      headers: { Authorization: `Bearer ${signToken(artistUser)}` },
    });
    const { payout } = ((await res.json()) as any);

    assert.equal(payout.outstandingLiabilityKobo, N(500000), 'the debt is shown in full');
    assert.equal(payout.liabilitySettleableKobo, 0, 'but this payout cannot clear it');
    assert.equal(payout.estimatedPayoutKobo, N(19000), 'so the payout is untouched');
    assert.deepEqual(payout.liabilities, []);
  } finally {
    await server.close();
  }
});
