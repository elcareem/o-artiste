/**
 * Escrow creation and funding instruction — issue #18.
 *
 * The provider is stubbed so the failure paths can be exercised deliberately.
 * The real calls are proven against the sandbox in `escrowpaySandbox.sandbox.js`
 * and by the live walkthrough recorded in the acceptance log.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('escrowcreation');

const test = require('node:test');
const assert = require('node:assert/strict');

const escrowpay = require('../src/lib/escrowpay.ts');
const escrowService = require('../src/services/escrowService.ts');
const bookingService = require('../src/services/bookingService.ts');
const ackService = require('../src/services/acknowledgementService.ts');
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

async function makeUser(role: UserRole, extra: Record<string, unknown> = {}) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  return prisma.user.create({
    data: {
      email: `esc${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword('correct horse battery staple'),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
      ...extra,
    },
  });
}

/** A booking with terms acknowledged, ready to fund. */
async function readyToFund({ acknowledge = true, clientParty = true, artistParty = true } = {}) {
  const admin = await makeUser('SUPER_ADMIN');
  await prisma.commissionRate.create({
    data: { rateBasisPoints: 500, effectiveFrom: new Date(), setByUserId: admin.id },
  });
  await prisma.cancellationTier.createMany({
    data: DEFAULT_TIERS.map((t: CancellationTierSnapshot) => ({
      ...t,
      versionId: `v_${uniq()}`,
      effectiveFrom: new Date(),
      setByUserId: admin.id,
    })),
  });

  const clientUser = await makeUser('CLIENT', clientParty ? {} : { escrowPartyId: null });
  await prisma.client.create({ data: { userId: clientUser.id, displayName: 'Client' } });

  const artistUser = await makeUser('ARTIST', artistParty ? {} : { escrowPartyId: null });
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

  if (acknowledge) {
    await ackService.acknowledgeTerms({
      bookingId: booking.id,
      clientUserId: clientUser.id,
      acknowledged: true,
      tiersAsDisplayed: booking.cancellationTiersSnapshot,
    });
  }

  return { clientUser, artistUser, artist, booking };
}

/** Replaces the provider client for one call. */
async function withProvider(overrides: Record<string, any>, fn: () => any) {
  const originals: Record<string, any> = {};
  for (const [name, impl] of Object.entries(overrides)) {
    originals[name] = escrowpay[name];
    escrowpay[name] = impl;
  }
  try {
    return await fn();
  } finally {
    for (const [name, impl] of Object.entries(originals)) escrowpay[name] = impl;
  }
}

const happyProvider = (txId = `TXN_${uniq()}`): Record<string, any> => ({
  createEscrow: async () => ({ id: txId, status: 'draft', version: 1 }),
  activateEscrow: async () => ({ id: txId, status: 'pending_funding', version: 2 }),
  createCheckoutSession: async () => ({
    id: `CSN_${uniq()}`,
    allowed_channels: ['bank_transfer'],
    payment_instructions: {
      payment_account_id: `PAM_${uniq()}`,
      account_number: '8881754680',
      masked_account_number: '****4680',
      bank_code: '090175',
      account_name: 'O-artist',
      amount_minor: N(202000),
      currency: 'NGN',
      expires_at: new Date(Date.now() + 1800000).toISOString(),
      provider: 'rubies',
    },
  }),
});

function providerError(code: string, message: string, status = 502): AppErrorLike {
  const err: AppErrorLike = new AppError(
    status,
    'The payment provider could not complete that request.'
  );
  err.providerCode = code;
  err.providerMessage = message;
  err.providerStatus = status;
  return err;
}

// ---------------------------------------------------------------------------

describe('a created booking returns a valid funding instruction', async () => {
  const { clientUser, booking } = await readyToFund();
  const txId = `TXN_${uniq()}`;

  const funding = await withProvider(happyProvider(txId), () =>
    escrowService.createEscrowForBooking({ bookingId: booking.id, clientUserId: clientUser.id })
  );

  // Everything a person needs to make the transfer.
  assert.equal(funding.bankTransfer.accountNumber, '8881754680');
  assert.equal(funding.bankTransfer.accountName, 'O-artist');
  assert.equal(funding.bankTransfer.bankCode, '090175');
  assert.equal(funding.bankTransfer.provider, 'rubies');
  assert.ok(funding.bankTransfer.expiresAt);

  // The account number must NOT be the masked form — a client cannot transfer
  // to ****4680.
  assert.ok(!funding.bankTransfer.accountNumber.includes('*'));

  // Both figures are named, because they differ and the client must not be
  // surprised at their banking app (docs/05 §1).
  assert.equal(funding.bookingAmountKobo, N(200000));
  assert.equal(funding.providerFeeKobo, N(2000));
  assert.equal(funding.amountToTransferKobo, N(202000));

  assert.deepEqual(funding.channels, ['bank_transfer']);
  assert.equal(funding.escrowId, txId);

  // Persisted against the booking.
  const stored = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(stored.escrowId, txId);
  assert.equal(stored.state, 'PENDING_PAYMENT', 'funding has not arrived yet');
});

describe('a provider error leaves the booking in PENDING_PAYMENT with no orphaned escrow', async () => {
  // Each of the three provider calls, failed in turn. A half-created booking is
  // worse than a failed one.
  for (const failing of ['createEscrow', 'activateEscrow', 'createCheckoutSession']) {
    const { clientUser, booking } = await readyToFund();

    const provider = happyProvider();
    provider[failing] = async () => {
      throw providerError('provider_unreachable', `${failing} failed`);
    };

    await assert.rejects(
      () =>
        withProvider(provider, () =>
          escrowService.createEscrowForBooking({
            bookingId: booking.id,
            clientUserId: clientUser.id,
          })
        ),
      (err: ThrownError) => err.status === 502,
      `${failing} must surface as a provider error`
    );

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    assert.equal(after.state, 'PENDING_PAYMENT', `${failing}: state must not move`);
    assert.equal(after.escrowId, null, `${failing}: no escrow id persisted`);

    // And the client can simply try again — the reference is unchanged, so a
    // retry reuses the same idempotency key rather than opening a second escrow.
    assert.equal(after.escrowReference, booking.escrowReference);
  }
});

describe('a retry after a failure reuses the same reference', async () => {
  const { clientUser, booking } = await readyToFund();

  const seen: any[] = [];
  const failing = happyProvider();
  failing.createEscrow = async ({ reference }: any) => {
    seen.push(reference);
    throw providerError('provider_unreachable', 'timeout');
  };

  await assert.rejects(() =>
    withProvider(failing, () =>
      escrowService.createEscrowForBooking({ bookingId: booking.id, clientUserId: clientUser.id })
    )
  );

  const succeeding = happyProvider();
  const original = succeeding.createEscrow;
  succeeding.createEscrow = async (args: any) => {
    seen.push(args.reference);
    return original(args);
  };

  await withProvider(succeeding, () =>
    escrowService.createEscrowForBooking({ bookingId: booking.id, clientUserId: clientUser.id })
  );

  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'the retry carries the same idempotency key');
  assert.equal(seen[0], booking.escrowReference, 'which is our self-generated reference');
});

describe('funding is refused without an acknowledgement, even calling the service directly', async () => {
  const { clientUser, booking } = await readyToFund({ acknowledge: false });

  let called = false;
  const provider = happyProvider();
  provider.createEscrow = async () => {
    called = true;
    throw new Error('the provider must not be reached');
  };

  await assert.rejects(
    () =>
      withProvider(provider, () =>
        escrowService.createEscrowForBooking({ bookingId: booking.id, clientUserId: clientUser.id })
      ),
    (err: ThrownError) => err.status === 409
  );

  // The gate is checked before any provider call — no escrow is created for a
  // booking whose terms were never accepted.
  assert.equal(called, false);
  assert.equal(
    (await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).escrowId,
    null
  );
});

describe('calling funding twice returns the same escrow rather than creating a second', async () => {
  const { clientUser, booking } = await readyToFund();
  const txId = `TXN_${uniq()}`;

  const first = await withProvider(happyProvider(txId), () =>
    escrowService.createEscrowForBooking({ bookingId: booking.id, clientUserId: clientUser.id })
  );

  let created = 0;
  const counting = happyProvider(`TXN_should_not_be_used_${uniq()}`);
  const originalCreate = counting.createEscrow;
  counting.createEscrow = async (args: any) => {
    created++;
    return originalCreate(args);
  };

  const second = await withProvider(counting, () =>
    escrowService.createEscrowForBooking({ bookingId: booking.id, clientUserId: clientUser.id })
  );

  assert.equal(created, 0, 'the provider is not called again');
  assert.equal(second.escrowId, first.escrowId);
  assert.equal(await prisma.booking.count({ where: { escrowId: txId } }), 1);
});

describe('a party without an escrow identity cannot fund, and the provider is not called', async () => {
  for (const [label, opts, pattern] of [
    ['client', { clientParty: false }, /verify your identity/i],
    ['artist', { artistParty: false }, /cannot receive payments/i],
  ] as [string, Record<string, boolean>, RegExp][]) {
    const { clientUser, booking } = await readyToFund(opts);

    let called = false;
    const provider = happyProvider();
    provider.createEscrow = async () => {
      called = true;
      throw new Error('unreachable');
    };

    await assert.rejects(
      () =>
        withProvider(provider, () =>
          escrowService.createEscrowForBooking({
            bookingId: booking.id,
            clientUserId: clientUser.id,
          })
        ),
      (err: ThrownError) => err.status === 409 && pattern.test((err as ThrownError).message),
      `${label} without a party id`
    );
    assert.equal(called, false, `${label}: the provider must not be reached`);
  }
});

describe('a booking already past PENDING_PAYMENT cannot be funded again', async () => {
  const { clientUser, booking } = await readyToFund();
  await bookingService.transition({ bookingId: booking.id, to: 'FUNDED_HELD' });

  await assert.rejects(
    () =>
      withProvider(happyProvider(), () =>
        escrowService.createEscrowForBooking({
          bookingId: booking.id,
          clientUserId: clientUser.id,
        })
      ),
    (err: ThrownError) => err.status === 409 && /already been paid/i.test((err as ThrownError).message)
  );
});

describe('only the booking’s own client can fund it', async () => {
  const { booking } = await readyToFund();
  const stranger = await readyToFund();

  await assert.rejects(
    () =>
      withProvider(happyProvider(), () =>
        escrowService.createEscrowForBooking({
          bookingId: booking.id,
          clientUserId: stranger.clientUser.id,
        })
      ),
    (err: ThrownError) => err.status === 404
  );
});

describe('no card payment path exists anywhere in the codebase', async () => {
  const { execSync } = require('node:child_process');
  const root = require('node:path').resolve(__dirname, '..', '..', '..');

  // The provider is bank-transfer only, and escrow with card chargebacks is
  // structurally incompatible: a chargeback arriving weeks after funds reach an
  // artist is unrecoverable (docs/03 §2).
  const hits = execSync(
    `grep -rIlE "card_payment|cardPayment|/charges/card|payWithCard" ` +
      `"${root}/apps/backend/src" "${root}/apps/web/src" || true`,
    { encoding: 'utf8' }
  ).trim();

  assert.equal(hits, '', `card payment references found: ${hits}`);
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});

// ── #10's last deferred criterion ────────────────────────────────────────────

describe('an artist who is unverified or suspended cannot be funded into', async () => {
  // #10's criterion reads "an unverified artist cannot accept a booking". There
  // is no acceptance step in the state machine — docs/01 §4 goes straight from
  // PENDING_PAYMENT to FUNDED_HELD — so the criterion is satisfied at the two
  // gates that do exist, and this closes both.

  // Gate 1: they cannot become party to a booking at all (#15, covered in
  // booking.test.js). Gate 2, below: a booking made while they were in good
  // standing cannot be funded after that changed.
  for (const [label, change] of [
    ['verification revoked', { verificationStatus: 'UNVERIFIED' }],
    ['suspended', { accountStanding: 'SUSPENDED' }],
  ]) {
    const { clientUser, artistUser, booking } = await readyToFund();

    await prisma.user.update({ where: { id: artistUser.id }, data: change });

    await assert.rejects(
      () => escrowService.createEscrowForBooking({ bookingId: booking.id, clientUserId: clientUser.id }),
      (err: ThrownError) => {
        assert.ok(err instanceof AppError, `${label}: expected an AppError`);
        assert.equal(err.status, 403, `${label}: expected 403`);
        return true;
      },
      `an artist ${label} after booking creation must not receive escrowed money`
    );

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    assert.equal(after.state, 'PENDING_PAYMENT', `${label}: the client has not paid`);
    assert.equal(after.escrowId, null, `${label}: no escrow was opened`);
  }
});

describe('a client suspended after booking creation cannot fund either', async () => {
  const { clientUser, booking } = await readyToFund();

  await prisma.user.update({ where: { id: clientUser.id }, data: { accountStanding: 'SUSPENDED' } });

  await assert.rejects(
    () => escrowService.createEscrowForBooking({ bookingId: booking.id, clientUserId: clientUser.id }),
    (err: ThrownError) => err.status === 403
  );

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.escrowId, null);
});

describe('a returning client gets the account number back, not an empty instruction', async () => {
  // Bank transfer funding is out-of-band: the client leaves to make the
  // transfer and comes back, often on another device. Before this, the second
  // call returned bankTransfer: null — a funding page with nothing to pay into.
  const { clientUser, booking } = await readyToFund();

  const calls: any[] = [];
  const session = {
    allowed_channels: ['bank_transfer'],
    payment_instructions: {
      amount_minor: N(202000),
      account_number: '8881754743',
      account_name: 'O-artist',
      bank_code: '090175',
      provider: 'rubies',
    },
  };

  const first = await withProvider(
    {
      createEscrow: async () => ({ id: 'TXN_return', version: 1 }),
      activateEscrow: async () => ({ status: 'pending_funding' }),
      createCheckoutSession: async (args: any) => {
        calls.push(args.reference);
        return session;
      },
    },
    () => escrowService.createEscrowForBooking({ bookingId: booking.id, clientUserId: clientUser.id })
  );

  assert.equal(first.bankTransfer.accountNumber, '8881754743');

  const second = await withProvider(
    {
      createEscrow: async () => assert.fail('a second escrow must not be created'),
      createCheckoutSession: async (args: any) => {
        calls.push(args.reference);
        return session;
      },
    },
    () => escrowService.createEscrowForBooking({ bookingId: booking.id, clientUserId: clientUser.id })
  );

  assert.equal(second.bankTransfer.accountNumber, '8881754743', 'the returning client can still pay');
  assert.equal(second.amountToTransferKobo, N(202000));
  assert.equal(second.escrowId, 'TXN_return', 'and it is the same escrow');

  // The same idempotency key both times, so the provider returns the same
  // session rather than a second one with a different destination account.
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
});

describe('an unreachable provider on re-read still shows the booking, without inventing an account', async () => {
  const { clientUser, booking } = await readyToFund();

  await prisma.booking.update({ where: { id: booking.id }, data: { escrowId: 'TXN_existing' } });

  const instruction = await withProvider(
    {
      createCheckoutSession: async () => {
        throw new AppError(502, 'Could not reach the payment provider.');
      },
    },
    () => escrowService.createEscrowForBooking({ bookingId: booking.id, clientUserId: clientUser.id })
  );

  assert.equal(instruction.bankTransfer, null, 'no fabricated account details');
  assert.equal(instruction.bookingAmountKobo, N(200000), 'but the booking is still readable');
  assert.equal(instruction.amountToTransferKobo, N(202000));
});
