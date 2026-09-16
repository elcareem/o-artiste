/**
 * Append-only ledger — issue #19.
 *
 * The load-bearing test here is reconciliation. Every terminal outcome a
 * booking can reach is driven end to end and asserted to sum to exactly zero,
 * because that single invariant catches a double-counted fee, a dropped share
 * and a rounding residual sent to the wrong party — the failures that are
 * otherwise invisible until someone is paid the wrong amount.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('ledger');

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../src/services/ledgerService.ts');
const bookingService = require('../src/services/bookingService.ts');
const { AppError } = require('../src/lib/errors.ts');

const describe = hasDatabase ? test : test.skip;

test.before(async () => {
  if (ready) await ready;
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
      email: `led${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword('correct horse battery staple'),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

/** A funded-shaped booking with the configuration frozen onto it. */
async function makeBooking({ amountKobo = N(200000), commissionBps = 500 } = {}) {
  const admin = await makeUser('SUPER_ADMIN');
  await prisma.commissionRate.create({
    data: { rateBasisPoints: commissionBps, effectiveFrom: new Date(), setByUserId: admin.id },
  });
  await prisma.cancellationTier.createMany({
    data: tierSetFor(DEFAULT_TIERS).map((t: any) => ({
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

  return bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo,
    eventDate: new Date(Date.now() + 30 * 86400000),
  });
}

/** Runs recorders inside one transaction, the way every caller must. */
const inTx = (fn: (tx: PrismaTx) => any): Promise<any> => prisma.$transaction(fn);

// ── Criterion: summing a completed booking reconciles to zero ────────────────

describe('a completed booking reconciles to exactly zero', async () => {
  const booking = await makeBooking();

  await inTx(async (tx: PrismaTx) => {
    await ledger.recordFunding(tx, booking);
    await ledger.recordRelease(tx, booking);
  });

  const r = await ledger.reconcile(booking.id);

  assert.equal(r.sumKobo, 0, 'a settled booking must sum to zero');
  assert.equal(r.balanced, true);

  // The canonical ₦200,000 figures from docs/05 §1, read back off the ledger
  // rather than recomputed — this is what the parties actually ended up with.
  assert.equal(r.byParty.CLIENT, -N(202000), 'client parts with ₦202,000');
  assert.equal(r.byParty.ARTIST, N(190000), 'artist receives ₦190,000');
  assert.equal(r.byParty.PLATFORM, N(9930), 'platform nets ₦9,930 after the payout fee');
  assert.equal(r.byParty.PROVIDER, N(2070), 'provider takes ₦2,000 in + ₦70 out');
});

describe('an unsettled booking does not balance, and says so', async () => {
  const booking = await makeBooking();

  await inTx((tx: PrismaTx) => ledger.recordFunding(tx, booking));

  const r = await ledger.reconcile(booking.id);

  // Not a failure — it is the money sitting in escrow, undistributed. The
  // invariant is about SETTLED bookings, and the ledger must be able to
  // represent an in-flight one honestly.
  assert.equal(r.balanced, false);
  assert.equal(r.sumKobo, -N(200000), 'the outstanding balance is exactly what escrow holds');

  await assert.rejects(() => ledger.assertBalanced(booking.id), AppError);
});

describe('every terminal outcome reconciles to zero', async () => {
  const outcomes = [
    {
      name: 'release on completion',
      run: async (tx: PrismaTx, b: BookingRow) => ledger.recordRelease(tx, b),
    },
    {
      name: 'client cancellation, full-refund tier',
      run: async (tx: PrismaTx, b: BookingRow) => ledger.recordClientCancellation(tx, b, DEFAULT_TIERS[0]),
    },
    {
      name: 'client cancellation, 70/30 tier',
      run: async (tx: PrismaTx, b: BookingRow) => ledger.recordClientCancellation(tx, b, DEFAULT_TIERS[1]),
    },
    {
      name: 'client cancellation, day-of tier',
      run: async (tx: PrismaTx, b: BookingRow) => ledger.recordClientCancellation(tx, b, DEFAULT_TIERS[3]),
    },
    {
      name: 'artist cancellation',
      run: async (tx: PrismaTx, b: BookingRow) => ledger.recordArtistCancellation(tx, b),
    },
  ];

  // Amounts chosen to straddle the fee boundaries docs/05 §2 identifies: below
  // the cap, at the cap's onset, and above the 0.8% crossover.
  const amounts = [N(20000), N(126667), N(250000), N(3000000)];

  for (const outcome of outcomes) {
    for (const amountKobo of amounts) {
      const booking = await makeBooking({ amountKobo });

      await inTx(async (tx: PrismaTx) => {
        await ledger.recordFunding(tx, booking);
        await outcome.run(tx, booking);
      });

      const r = await ledger.reconcile(booking.id);
      assert.equal(
        r.sumKobo,
        0,
        `${outcome.name} at ${amountKobo} kobo left ${r.sumKobo} kobo unreconciled`
      );
    }
  }
});

describe('a client is made whole on an artist cancellation', async () => {
  const booking = await makeBooking();

  await inTx(async (tx: PrismaTx) => {
    await ledger.recordFunding(tx, booking);
    await ledger.recordArtistCancellation(tx, booking);
  });

  const r = await ledger.reconcile(booking.id);

  assert.equal(r.sumKobo, 0);
  // Zero fee exposure means the client's net position is exactly zero: they get
  // back the escrow AND the money-in fee they paid on top of it.
  assert.equal(r.byParty.CLIENT, 0, 'the client ends whole, not merely refunded');
  assert.equal(r.byParty.ARTIST, -N(2070), 'the artist carries the fee liability');
});

// ── Criterion: a failed state change rolls back its ledger entry ─────────────

describe('a state change that fails rolls back its ledger entry', async () => {
  const booking = await makeBooking();

  // RELEASED is not reachable from PENDING_PAYMENT. The ledger write happens
  // first, so if the rollback did not cover it the row would survive.
  await assert.rejects(
    () =>
      prisma.$transaction(async (tx: PrismaTx) => {
        await ledger.recordFunding(tx, booking);
        await bookingService.transition({ bookingId: booking.id, to: 'RELEASED', client: tx });
      }),
    AppError
  );

  const r = await ledger.reconcile(booking.id);
  assert.equal(r.entryCount, 0, 'no orphaned ledger rows survive the rollback');

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'PENDING_PAYMENT', 'and the booking is unchanged');
});

describe('the reverse also holds — a failed ledger write rolls back the state change', async () => {
  const booking = await makeBooking();

  await assert.rejects(() =>
    prisma.$transaction(async (tx: PrismaTx) => {
      await bookingService.transition({ bookingId: booking.id, to: 'FUNDED_HELD', client: tx });
      await ledger.record(tx, {
        bookingId: booking.id,
        entryType: 'FUNDED',
        party: 'CLIENT',
        amountKobo: 0, // rejected: an entry that moves nothing records nothing
      });
    })
  );

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'PENDING_PAYMENT', 'the state change did not survive');
});

// ── Criterion: entries are written inside the accompanying transaction ───────

describe('the base Prisma client is refused outright', async () => {
  const booking = await makeBooking();

  await assert.rejects(
    () =>
      ledger.record(prisma, {
        bookingId: booking.id,
        entryType: 'FUNDED',
        party: 'CLIENT',
        amountKobo: -N(202000),
      }),
    (err: ThrownError) => {
      assert.ok(err instanceof AppError);
      assert.match((err as ThrownError).message, /inside the transaction/i);
      return true;
    },
    'a ledger write outside a transaction must be impossible, not merely discouraged'
  );

  const r = await ledger.reconcile(booking.id);
  assert.equal(r.entryCount, 0);
});

describe('the composite recorders refuse it too', async () => {
  const booking = await makeBooking();

  for (const [name, call] of [
    ['recordFunding', () => ledger.recordFunding(prisma, booking)],
    ['recordRelease', () => ledger.recordRelease(prisma, booking)],
    ['recordArtistCancellation', () => ledger.recordArtistCancellation(prisma, booking)],
    ['recordClientCancellation', () => ledger.recordClientCancellation(prisma, booking, DEFAULT_TIERS[1])],
    ['recordFeeLiabilitySettlement', () => ledger.recordFeeLiabilitySettlement(prisma, booking.id, 100)],
    ['recordCorrection', () => ledger.recordCorrection(prisma, { offsetsEntryId: 'x', reason: 'y' })],
  ]) {
    await assert.rejects(call, AppError, `${name} accepted the base client`);
  }
});

// ── Criterion: a correction produces two visible entries ────────────────────

describe('a correction produces two entries, not one modified entry', async () => {
  const booking = await makeBooking();

  const [funded] = await inTx((tx: PrismaTx) => ledger.recordFunding(tx, booking));

  const correction = await inTx((tx: PrismaTx) =>
    ledger.recordCorrection(tx, { offsetsEntryId: funded.id, reason: 'funded at the wrong amount' })
  );

  const r = await ledger.reconcile(booking.id);
  const rows = r.entries.filter((e: any) => e.id === funded.id || e.id === correction.id);

  assert.equal(rows.length, 2, 'both the original and the correction are visible');

  const original = rows.find((e: any) => e.id === funded.id);
  assert.equal(original.entryType, 'FUNDED');
  assert.equal(original.amountKobo, -N(202000), 'the original is untouched');

  assert.equal(correction.entryType, 'CORRECTION');
  assert.equal(correction.amountKobo, N(202000), 'the correction is the exact negation');
  assert.equal(correction.offsetsEntryId, funded.id, 'and names what it offsets');
  assert.match(correction.description, /funded at the wrong amount/);

  // Net effect: as if the original had never been written — but with the record
  // of both, which is the whole point.
  assert.equal(original.amountKobo + correction.amountKobo, 0);
});

describe('a correction cannot be applied twice, or to a correction', async () => {
  const booking = await makeBooking();
  const [funded] = await inTx((tx: PrismaTx) => ledger.recordFunding(tx, booking));

  const correction = await inTx((tx: PrismaTx) =>
    ledger.recordCorrection(tx, { offsetsEntryId: funded.id, reason: 'first' })
  );

  await assert.rejects(
    () => inTx((tx: PrismaTx) => ledger.recordCorrection(tx, { offsetsEntryId: funded.id, reason: 'again' })),
    /already been corrected/,
    'double-correcting would silently reverse the reversal'
  );

  await assert.rejects(
    () => inTx((tx: PrismaTx) => ledger.recordCorrection(tx, { offsetsEntryId: correction.id, reason: 'meta' })),
    /cannot itself be corrected/
  );

  await assert.rejects(
    () => inTx((tx: PrismaTx) => ledger.recordCorrection(tx, { offsetsEntryId: funded.id })),
    /must state its reason/
  );

  await assert.rejects(
    () => inTx((tx: PrismaTx) => ledger.recordCorrection(tx, { offsetsEntryId: 'no_such_entry', reason: 'x' })),
    /does not exist/
  );
});

describe('a booking corrected and rewritten still reconciles', async () => {
  const booking = await makeBooking();

  // Simulates the real shape of a correction: something was recorded against
  // the wrong party, is reversed, and the right entries are written.
  await inTx(async (tx: PrismaTx) => {
    await ledger.recordFunding(tx, booking);
    await ledger.recordRelease(tx, booking);
  });

  const r1 = await ledger.reconcile(booking.id);
  const commission = r1.entries.find((e: any) => e.entryType === 'COMMISSION');

  await inTx(async (tx: PrismaTx) => {
    await ledger.recordCorrection(tx, {
      offsetsEntryId: commission.id,
      reason: 'commission applied at the live rate rather than the snapshot',
    });
    await ledger.record(tx, {
      bookingId: booking.id,
      entryType: 'COMMISSION',
      party: 'PLATFORM',
      amountKobo: commission.amountKobo,
      description: 'Commission re-applied from the booking snapshot',
    });
  });

  const r2 = await ledger.reconcile(booking.id);
  assert.equal(r2.sumKobo, 0, 'the corrected booking still reconciles');
  assert.equal(r2.entryCount, r1.entryCount + 2, 'by adding entries, never by editing');
});

// ── Fee liabilities span bookings, and each still balances alone ─────────────

describe('a liability accrued on one booking and settled on another leaves both balanced', async () => {
  const cancelled = await makeBooking();
  const later = await makeBooking();

  await inTx(async (tx: PrismaTx) => {
    await ledger.recordFunding(tx, cancelled);
    await ledger.recordArtistCancellation(tx, cancelled);
  });

  await inTx(async (tx: PrismaTx) => {
    await ledger.recordFunding(tx, later);
    await ledger.recordRelease(tx, later);
    await ledger.recordFeeLiabilitySettlement(tx, later.id, N(2070));
  });

  assert.equal((await ledger.reconcile(cancelled.id)).sumKobo, 0);
  assert.equal((await ledger.reconcile(later.id)).sumKobo, 0);

  // The artist's position across both: they carried the liability, then paid it.
  const a1 = (await ledger.reconcile(cancelled.id)).byParty.ARTIST;
  const a2 = (await ledger.reconcile(later.id)).byParty.ARTIST;
  assert.equal(a1, -N(2070));
  assert.equal(a2, N(190000) - N(2070), 'the settlement comes off the payout, not the commission');
});

// ── The primitive's own guards ───────────────────────────────────────────────

describe('the primitive rejects malformed entries', async () => {
  const booking = await makeBooking();

  await assert.rejects(
    () => inTx((tx: PrismaTx) => ledger.record(tx, { entryType: 'FUNDED', party: 'CLIENT', amountKobo: 1 })),
    /must reference a booking/
  );

  for (const bad of [1.5, '100', null, undefined, NaN]) {
    await assert.rejects(
      () =>
        inTx((tx: PrismaTx) =>
          ledger.record(tx, {
            bookingId: booking.id,
            entryType: 'FUNDED',
            party: 'CLIENT',
            amountKobo: bad,
          })
        ),
      TypeError,
      `a ${String(bad)} amount must not reach the ledger`
    );
  }
});

describe('every entry names its booking and its bearing party', async () => {
  const booking = await makeBooking();

  await inTx(async (tx: PrismaTx) => {
    await ledger.recordFunding(tx, booking);
    await ledger.recordRelease(tx, booking);
  });

  const { entries } = await ledger.reconcile(booking.id);
  assert.ok(entries.length > 0);

  for (const e of entries) {
    assert.equal(e.bookingId, booking.id);
    assert.ok(['CLIENT', 'ARTIST', 'PLATFORM', 'PROVIDER'].includes(e.party), `bad party ${e.party}`);
    assert.ok(Number.isInteger(e.amountKobo));
    assert.notEqual(e.amountKobo, 0);
    assert.ok(e.description, 'an entry with no description explains nothing later');
  }
});

describe('the ledger client exposes no update or delete surface', async () => {
  // The grep in check:rules covers source; this covers the module's own API, so
  // a future export cannot quietly add a mutation path.
  for (const name of Object.keys(ledger)) {
    assert.doesNotMatch(name, /update|delete|remove|edit|void/i, `ledgerService exports ${name}`);
  }
});
