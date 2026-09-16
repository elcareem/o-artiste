/**
 * The money-out leg — issue #26's missing half.
 *
 * EscrowPay rejects `payout_preference: automatic` on this business
 * (`automatic_payout_disabled`, verified against the test book). A release
 * therefore moves escrow into OUR WALLET, not to the artist, and the payout out
 * of it is ours to issue.
 *
 * Until this existed the system released money and stopped. Every other path was
 * built on the assumption that a release ends with the artist paid, and it did
 * not. `docs/00` §3 says the platform never holds client money; these tests are
 * about the window in which it does, and about making that window visible when
 * it fails to close.
 */

process.env.QUEUE_PREFIX = `test-payout-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('payout');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const bookingService = require('../src/services/bookingService.ts');
const escrowService = require('../src/services/escrowService.ts');
const payoutService = require('../src/services/payoutService.ts');
const ledger = require('../src/services/ledgerService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const { computeCompletion } = require('../src/services/feeService.ts');

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

async function makeUser(role: UserRole, { partyId = true } = {}) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  return prisma.user.create({
    data: {
      email: `pay${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      ...(partyId ? { escrowPartyId: `PAR_${n}` } : {}),
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

/** Records every provider instruction so the two legs can be told apart. */
function recordingProvider(overrides: Record<string, any> = {}) {
  const calls: any[] = [];
  return {
    calls,
    overrides: {
      release: async (a: any) => {
        calls.push({ leg: 'release', amountKobo: a.amountKobo });
        return { id: `REL_${uniq()}`, status: 'completed' };
      },
      refund: async (a: any) => {
        calls.push({ leg: 'refund', amountKobo: a.amountKobo });
        return { id: `RFD_${uniq()}`, status: 'completed' };
      },
      listWallets: async () => [{ id: 'WAL_test', currency: 'NGN' }],
      walletPayout: async (a: any) => {
        calls.push({
          leg: 'payout',
          amountKobo: a.amountKobo,
          payoutAccountId: a.payoutAccountId,
          walletId: a.walletId,
          reference: a.reference,
        });
        return { id: `PAY_${uniq()}`, status: 'pending' };
      },
      createPayoutAccount: async (a: any) => {
        calls.push({ leg: 'createPayoutAccount', partyId: a.partyId, bankCode: a.bankCode });
        return { id: `PAC_${uniq()}`, account_name: 'ADENIYI ADEBAYO' };
      },
      ...overrides,
    },
  };
}

/** An artist with a registered payout account, and a booking ready to release. */
async function readyToRelease({
  withPayoutAccount = true,
  amountKobo = N(200000),
}: { withPayoutAccount?: boolean; amountKobo?: Kobo } = {}) {
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
      ...(withPayoutAccount
        ? {
            payoutAccountId: `PAC_${uniq()}`,
            payoutBankCode: '044',
            payoutAccountLast4: '4321',
            payoutAccountName: 'ADENIYI ADEBAYO',
          }
        : {}),
    },
  });

  let booking = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo,
    eventDate: new Date(Date.now() + 30 * 86400000),
  });

  booking = await prisma.booking.update({
    where: { id: booking.id },
    data: { state: 'FUNDED_HELD', escrowId: `TXN_${uniq()}` },
  });

  await prisma.$transaction((tx: PrismaTx) => ledger.recordFunding(tx, booking));

  booking = await prisma.booking.update({
    where: { id: booking.id },
    data: { state: 'AWAITING_CONFIRMATION' },
  });

  return { booking, artist, artistUser, clientUser, amountKobo };
}

// ---------------------------------------------------------------------------
// The leg that was missing
// ---------------------------------------------------------------------------

describe('releasing now sends the money on to the artist, not just to our wallet', async () => {
  const { booking, artist, amountKobo } = await readyToRelease();

  const provider = recordingProvider();
  const summary = await withProvider(provider.overrides, () =>
    escrowService.releaseBooking({ bookingId: booking.id, reason: 'Completed' })
  );

  const completion = computeCompletion({
    amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
  });

  // TWO legs, in order: escrow → our wallet, then wallet → the artist.
  assert.deepEqual(
    provider.calls.map((c) => c.leg),
    ['release', 'payout'],
    'the payout leg did not happen — the money is sitting in our wallet'
  );

  const payout = provider.calls.find((c) => c.leg === 'payout');
  assert.equal(payout.amountKobo, completion.artistNetKobo);
  assert.equal(payout.payoutAccountId, artist.payoutAccountId);
  assert.match(payout.reference, /_payout$/);

  assert.equal(summary.paidOut, true);
  assert.ok(summary.payoutId);

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.ok(after.paidOutAt, 'the booking does not record that the artist was paid');
  assert.equal(after.payoutFailureReason, null);
});

describe('the payout is the amount that actually left escrow, after any liability', async () => {
  const { booking, artistUser, amountKobo } = await readyToRelease();

  // An outstanding debt from an earlier cancellation (#28).
  await prisma.feeLiability.create({
    data: {
      artistUserId: artistUser.id,
      originBookingId: booking.id,
      amountKobo: 207000,
      status: 'OUTSTANDING',
    },
  });

  const provider = recordingProvider();
  await withProvider(provider.overrides, () =>
    escrowService.releaseBooking({ bookingId: booking.id, reason: 'Completed' })
  );

  const completion = computeCompletion({
    amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
  });

  // Not the gross net — what the artist is actually owed after settlement.
  // Paying the gross would hand back the debt that was just collected.
  const payout = provider.calls.find((c) => c.leg === 'payout');
  assert.equal(payout.amountKobo, completion.artistNetKobo - 207000);
});

// ---------------------------------------------------------------------------
// When the payout fails
// ---------------------------------------------------------------------------

describe('a failed payout does not undo the release, and is findable', async () => {
  const { booking } = await readyToRelease();

  const provider = recordingProvider({
    walletPayout: async () => {
      throw new Error('bank unreachable');
    },
  });

  const summary = await withProvider(provider.overrides, () =>
    escrowService.releaseBooking({ bookingId: booking.id, reason: 'Completed' })
  );

  // THE RELEASE STANDS. It already happened and is recorded correctly; turning
  // a payout problem into a failed release would roll back a movement that has
  // already left the escrow.
  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'RELEASED');
  assert.equal(summary.paidOut, false);

  // And the money we are holding is visible.
  assert.equal(after.paidOutAt, null);
  assert.match(after.payoutFailureReason, /bank unreachable/);

  const awaiting = await payoutService.awaitingPayout();
  assert.ok(
    awaiting.some((b: BookingRow) => b.id === booking.id),
    'money we are holding for someone else is not listed anywhere'
  );
});

describe('an artist with no bank account on file is a named failure, not a crash', async () => {
  const { booking } = await readyToRelease({ withPayoutAccount: false });

  const provider = recordingProvider();
  await withProvider(provider.overrides, () =>
    escrowService.releaseBooking({ bookingId: booking.id, reason: 'Completed' })
  );

  // The provider is never asked to pay an account that does not exist.
  assert.equal(provider.calls.filter((c) => c.leg === 'payout').length, 0);

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'RELEASED');
  assert.match(after.payoutFailureReason, /no bank account on file/i);
});

describe('paying out twice sends the money once', async () => {
  const { booking } = await readyToRelease();

  const provider = recordingProvider();
  await withProvider(provider.overrides, () =>
    escrowService.releaseBooking({ bookingId: booking.id, reason: 'Completed' })
  );
  assert.equal(provider.calls.filter((c) => c.leg === 'payout').length, 1);

  const again = await withProvider(
    recordingProvider({
      walletPayout: async () => {
        throw new Error('a second payout must not be attempted');
      },
    }).overrides,
    () => payoutService.payOut({ bookingId: booking.id, amountKobo: N(190000) })
  );

  assert.equal(again.paid, false);
  assert.equal(again.alreadyPaid, true);
});

describe('a release fully consumed by a liability pays nobody, and that is not a failure', async () => {
  const { booking, artistUser } = await readyToRelease();

  const completion = computeCompletion({
    amountKobo: booking.amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
  });

  // A debt larger than the payout. feeService floors the disbursement at zero.
  await prisma.feeLiability.create({
    data: {
      artistUserId: artistUser.id,
      originBookingId: booking.id,
      amountKobo: completion.artistNetKobo,
      status: 'OUTSTANDING',
    },
  });

  const provider = recordingProvider({
    walletPayout: async () => {
      throw new Error('a zero payout must not be sent');
    },
  });

  await withProvider(provider.overrides, () =>
    escrowService.releaseBooking({ bookingId: booking.id, reason: 'Completed' })
  );

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'RELEASED');
  // Nothing owed, so nothing sent and nothing recorded as failed.
  assert.equal(after.payoutFailureReason, null);
});

// ---------------------------------------------------------------------------
// Registering where the money goes
// ---------------------------------------------------------------------------

describe('an artist registers a bank account, and the number is never stored', async () => {
  const artistUser = await makeUser('ARTIST');
  await prisma.artist.create({
    data: {
      userId: artistUser.id,
      stageName: `Artist ${uniq()}`,
      category: 'Afrobeats',
      location: 'Lagos',
      baseRateKobo: N(200000),
      profileComplete: true,
    },
  });

  const token = await login(artistUser.email);
  const provider = recordingProvider();

  const res = await withProvider(provider.overrides, () =>
    call('PUT', '/artists/me/payout-account', token, {
      bankCode: '044',
      accountNumber: '0123456789',
    })
  );

  assert.equal(res.status, 200, res.body.error);
  assert.equal(res.body.payoutAccount.registered, true);
  assert.equal(res.body.payoutAccount.accountLast4, '6789');
  assert.equal(res.body.payoutAccount.accountName, 'ADENIYI ADEBAYO');

  // THE FULL NUMBER IS NOWHERE. Not in the response, not on the row. It goes to
  // the provider once and every payout afterwards is addressed by their id —
  // keeping it would be exposure with no operational benefit.
  assert.ok(!JSON.stringify(res.body).includes('0123456789'));

  const artist = await prisma.artist.findUnique({ where: { userId: artistUser.id } });
  assert.ok(!JSON.stringify(artist).includes('0123456789'), 'the account number was stored');
  assert.equal(artist.payoutAccountLast4, '6789');
  assert.ok(artist.payoutAccountId);

  // It is registered against the artist's provider party, not the business.
  const registration = provider.calls.find((c) => c.leg === 'createPayoutAccount');
  assert.ok(registration.partyId.startsWith('PAR_'));
});

describe('a malformed account number is refused before the provider is called', async () => {
  const artistUser = await makeUser('ARTIST');
  await prisma.artist.create({
    data: {
      userId: artistUser.id,
      stageName: `Artist ${uniq()}`,
      category: 'Afrobeats',
      location: 'Lagos',
      baseRateKobo: N(200000),
      profileComplete: true,
    },
  });
  const token = await login(artistUser.email);

  const provider = recordingProvider({
    createPayoutAccount: async () => {
      throw new Error('a malformed account must not reach the provider');
    },
  });

  for (const accountNumber of ['123', '01234567890', 'abcdefghij', '', '012345678a']) {
    const res = await withProvider(provider.overrides, () =>
      call('PUT', '/artists/me/payout-account', token, { bankCode: '044', accountNumber })
    );
    assert.equal(res.status, 400, `"${accountNumber}" was accepted`);
    assert.match(res.body.error, /10 digits/);
  }

  // A missing bank is its own message, not a generic validation failure.
  const noBank = await withProvider(provider.overrides, () =>
    call('PUT', '/artists/me/payout-account', token, { accountNumber: '0123456789' })
  );
  assert.equal(noBank.status, 400);
  assert.match(noBank.body.error, /choose your bank/i);
});

describe('an unverified artist cannot register one, and is told why', async () => {
  const artistUser = await makeUser('ARTIST', { partyId: false });
  await prisma.artist.create({
    data: {
      userId: artistUser.id,
      stageName: `Artist ${uniq()}`,
      category: 'Afrobeats',
      location: 'Lagos',
      baseRateKobo: N(200000),
      profileComplete: true,
    },
  });
  const token = await login(artistUser.email);

  const res = await withProvider(recordingProvider().overrides, () =>
    call('PUT', '/artists/me/payout-account', token, {
      bankCode: '044',
      accountNumber: '0123456789',
    })
  );

  // A payout account is owned by a provider party, and the party is created
  // during identity verification (#10).
  assert.equal(res.status, 409);
  assert.match(res.body.error, /verify your identity/i);
});

describe('only the artist sees or sets their own account', async () => {
  const artistUser = await makeUser('ARTIST');
  await prisma.artist.create({
    data: {
      userId: artistUser.id,
      stageName: `Artist ${uniq()}`,
      category: 'Afrobeats',
      location: 'Lagos',
      baseRateKobo: N(200000),
      profileComplete: true,
      payoutAccountId: `PAC_${uniq()}`,
      payoutAccountLast4: '4321',
    },
  });

  const client = await makeUser('CLIENT');
  const clientToken = await login(client.email);

  assert.equal((await call('GET', '/artists/me/payout-account', clientToken)).status, 403);
  assert.equal(
    (await call('PUT', '/artists/me/payout-account', clientToken, {
      bankCode: '044',
      accountNumber: '0123456789',
    })).status,
    403
  );

  // And an artist sees only the last four of their own.
  const token = await login(artistUser.email);
  const mine = await call('GET', '/artists/me/payout-account', token);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.payoutAccount.accountLast4, '4321');
  assert.equal(mine.body.payoutAccount.registered, true);
});

// ---------------------------------------------------------------------------
// Operator visibility
// ---------------------------------------------------------------------------

describe('an admin can see money we are holding that is not ours', async () => {
  const { booking } = await readyToRelease({ withPayoutAccount: false });

  await withProvider(recordingProvider().overrides, () =>
    escrowService.releaseBooking({ bookingId: booking.id, reason: 'Completed' })
  );

  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const res = await call('GET', '/admin/payouts/awaiting', token);
  assert.equal(res.status, 200);

  const entry = res.body.awaiting.find((a: any) => a.bookingId === booking.id);
  assert.ok(entry, 'a released-but-unpaid booking is not listed');
  assert.equal(entry.hasPayoutAccount, false);
  assert.match(entry.failureReason, /no bank account/i);

  // Closed to everyone below ADMIN.
  const artistToken = await login((await makeUser('ARTIST')).email);
  assert.equal((await call('GET', '/admin/payouts/awaiting', artistToken)).status, 403);
});
