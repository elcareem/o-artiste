/**
 * Artist-fault reclassification — issue #29.
 *
 * Not every client cancellation is the client's fault. Where the artist changed
 * terms after booking or disclosed costs late, charging the client a
 * cancellation fee is the situation the FCCPA addresses.
 *
 * The reversal is written as OFFSETTING ENTRIES, never as edits. The originals
 * stay visible because the sequence — charged, then reversed, and why — is the
 * record that matters when the decision is questioned, and it will be.
 */

process.env.QUEUE_PREFIX = `test-reclass-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('reclass');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const bookingService = require('../src/services/bookingService.ts');
const escrowService = require('../src/services/escrowService.ts');
const ledger = require('../src/services/ledgerService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const {
  computeClientCancellation,
  computeArtistCancellation,
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
      email: `rcl${n}@example.test`,
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

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

/** Records every provider instruction, so source and amount can be asserted. */
function recordingProvider() {
  const calls: { leg: string; amountKobo: number; source?: string; reference: string }[] = [];
  return {
    calls,
    overrides: {
      release: async (a: any) => {
        calls.push({ leg: 'release', amountKobo: a.amountKobo, reference: a.reference });
        return { id: `REL_${uniq()}`, status: 'completed' };
      },
      refund: async (a: any) => {
        calls.push({
          leg: 'refund',
          amountKobo: a.amountKobo,
          source: a.source,
          reference: a.reference,
        });
        return { id: `RFD_${uniq()}`, status: 'completed' };
      },
    },
  };
}

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

const sum = (entries: LedgerEntryRow[]) =>
  entries.reduce((t: number, e: LedgerEntryRow) => t + e.amountKobo, 0);

/** A booking a client has already cancelled, at `daysOut` days before the event. */
async function cancelledByClient({ daysOut = 2, amountKobo = N(200000) } = {}) {
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
    },
  });

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
      state: 'FUNDED_HELD',
      escrowId: `TXN_${uniq()}`,
    },
  });

  await prisma.$transaction((tx: PrismaTx) => ledger.recordFunding(tx, booking));

  const clientToken = await login(clientUser.email);
  await withProvider(recordingProvider().overrides, () =>
    call('POST', `/bookings/${booking.id}/cancel`, clientToken, { reason: 'Changed plans.' })
  );

  const cancellation = await prisma.cancellation.findUnique({ where: { bookingId: booking.id } });

  return { booking, cancellation, artistUser, clientUser, amountKobo };
}

// ---------------------------------------------------------------------------
// Criterion: offsetting entries that reconcile to the correct net position
// ---------------------------------------------------------------------------

describe('reclassifying produces offsetting entries and the correct net position', async () => {
  const { booking, cancellation, amountKobo } = await cancelledByClient({ daysOut: 2 });
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const before = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });
  const original = computeClientCancellation({
    amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
    clientRefundBps: 4000,
    artistCompensationBps: 6000,
  });
  const corrected = computeArtistCancellation({ amountKobo });

  const provider = recordingProvider();
  const res = await withProvider(provider.overrides, () =>
    call('POST', `/admin/cancellations/${cancellation.id}/reclassify`, token, {
      reason: 'The artist added a ₦40,000 equipment charge after the booking was confirmed.',
    })
  );

  assert.equal(res.status, 200, res.body.error);

  // The client is brought up to what an artist-fault cancellation returns:
  // everything, plus the money-in fee they paid at funding.
  const expectedAdditional = corrected.clientTotalReturnedKobo - original.clientRefundKobo;
  assert.equal(res.body.reclassification.additionalToClientKobo, expectedAdditional);
  assert.equal(res.body.reclassification.clientTotalReturnedKobo, corrected.clientTotalReturnedKobo);

  // THE MONEY COMES FROM THE PLATFORM'S WALLET. A client cancellation has
  // already disbursed both legs, so there is nothing left in the escrow.
  const refunds = provider.calls.filter((c) => c.leg === 'refund');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amountKobo, expectedAdditional);
  assert.equal(refunds[0].source, 'wallet_available', 'refunded from an empty escrow');

  // Every original entry of the cancellation is negated, exactly.
  const after = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });
  const corrections = after.filter((e: LedgerEntryRow) => e.entryType === 'CORRECTION');

  assert.equal(corrections.length, res.body.reclassification.entriesReversed);
  assert.ok(corrections.length >= 5, `only ${corrections.length} entries were reversed`);

  for (const correction of corrections) {
    const source = before.find((e: LedgerEntryRow) => e.id === correction.offsetsEntryId);
    assert.ok(source, 'a correction offsets an entry that is not on this booking');
    assert.equal(
      correction.amountKobo,
      -source.amountKobo,
      'a correction must be the exact negation of what it offsets'
    );
  }

  // And the booking still reconciles to zero.
  assert.equal(sum(after), 0, 'the booking does not reconcile after reclassification');

  // THE CLIENT'S LIFETIME POSITION ON THIS BOOKING IS EXACTLY ZERO.
  //
  // Funding records `-(amount + moneyInFee)` — what they actually paid — and an
  // artist-fault outcome returns both halves. Nothing left over in either
  // direction is what "made whole" means, and it is a stronger statement than
  // checking the refund line alone, which would still pass if the fee
  // reimbursement had been forgotten.
  const clientNet = sum(after.filter((e: LedgerEntryRow) => e.party === 'CLIENT'));
  assert.equal(clientNet, 0, 'the client did not end up exactly whole');

  // And the two halves are both present, rather than netting by accident.
  const clientCredits = after.filter(
    (e: LedgerEntryRow) => e.party === 'CLIENT' && e.amountKobo > 0
  );
  assert.equal(sum(clientCredits), corrected.clientTotalReturnedKobo + original.clientRefundKobo);
  assert.ok(
    clientCredits.some((e: LedgerEntryRow) => e.entryType === 'ESCROW_FEE_IN'),
    'the money-in fee was never reimbursed'
  );
  assert.ok(amountKobo > 0);
});

// ---------------------------------------------------------------------------
// Criterion: the originals remain intact and queryable
// ---------------------------------------------------------------------------

describe('the original entries remain intact and queryable', async () => {
  const { booking, cancellation } = await cancelledByClient({ daysOut: 5 });
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const before = await prisma.ledgerEntry.findMany({
    where: { bookingId: booking.id },
    orderBy: { createdAt: 'asc' },
  });

  await withProvider(recordingProvider().overrides, () =>
    call('POST', `/admin/cancellations/${cancellation.id}/reclassify`, token, {
      reason: 'Artist misrepresented the set length.',
    })
  );

  const after = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });

  // NOT ONE ORIGINAL IS EDITED OR REMOVED. The sequence — charged, then
  // reversed, and why — is the record that matters.
  for (const entry of before) {
    const still = after.find((e: LedgerEntryRow) => e.id === entry.id);
    assert.ok(still, `entry ${entry.id} disappeared`);
    assert.equal(still.amountKobo, entry.amountKobo, `entry ${entry.id} was edited`);
    assert.equal(still.entryType, entry.entryType);
    assert.equal(still.party, entry.party);
    assert.deepEqual(still.createdAt, entry.createdAt);
  }

  assert.ok(after.length > before.length, 'nothing was appended');

  // Each correction carries why it was written, so the record explains itself.
  for (const c of after.filter((e: LedgerEntryRow) => e.entryType === 'CORRECTION')) {
    assert.match(c.description, /Reclassified as artist-fault/);
    assert.match(c.description, /misrepresented the set length/);
  }
});

// ---------------------------------------------------------------------------
// Criterion: a reclassification without a written reason is rejected
// ---------------------------------------------------------------------------

describe('a reclassification without a written reason is rejected', async () => {
  const { booking, cancellation } = await cancelledByClient();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: null }]) {
    const res = await withProvider(
      {
        refund: async () => {
          throw new Error('no money may move without a recorded reason');
        },
      },
      () => call('POST', `/admin/cancellations/${cancellation.id}/reclassify`, token, body)
    );

    assert.equal(res.status, 400, `${JSON.stringify(body)} was accepted`);
    assert.match(res.body.error, /record why/i);
  }

  // Nothing happened — not a partial reclassification, not a correction.
  const fresh = await prisma.cancellation.findUnique({ where: { id: cancellation.id } });
  assert.equal(fresh.reclassifiedAsArtistFault, false);
  assert.equal(
    await prisma.ledgerEntry.count({ where: { bookingId: booking.id, entryType: 'CORRECTION' } }),
    0
  );
});

// ---------------------------------------------------------------------------
// Criterion: the audit record names the deciding admin
// ---------------------------------------------------------------------------

describe('the audit record names the deciding admin, and what changed', async () => {
  const { cancellation } = await cancelledByClient({ daysOut: 2 });
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const reason = 'Artist disclosed a travel surcharge two days before the event.';
  await withProvider(recordingProvider().overrides, () =>
    call('POST', `/admin/cancellations/${cancellation.id}/reclassify`, token, { reason })
  );

  const audit = await prisma.auditLog.findFirst({
    where: { action: 'CANCELLATION_RECLASSIFIED_ARTIST_FAULT', entityId: cancellation.id },
  });

  assert.ok(audit, 'no audit record for a manual money decision');
  assert.equal(audit.actorUserId, admin.id);
  assert.equal(audit.reason, reason);

  // Before and after, so the decision can be reconstructed rather than inferred.
  assert.equal((audit.before as any).feeBearer, 'CLIENT');
  assert.equal((audit.after as any).feeBearer, 'ARTIST');
  assert.ok((audit.after as any).additionalToClientKobo > 0);

  // And the cancellation row records the decision itself.
  const updated = await prisma.cancellation.findUnique({ where: { id: cancellation.id } });
  assert.equal(updated.reclassifiedAsArtistFault, true);
  assert.equal(updated.reclassifiedByUserId, admin.id);
  assert.equal(updated.reclassificationReason, reason);
  assert.ok(updated.reclassifiedAt);
  assert.equal(updated.feeBearer, 'ARTIST');
});

// ---------------------------------------------------------------------------
// The artist's side
// ---------------------------------------------------------------------------

describe('the artist owes back their compensation and the fees, as one debt', async () => {
  const { booking, cancellation, artistUser, amountKobo } = await cancelledByClient({ daysOut: 2 });
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const original = computeClientCancellation({
    amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
    clientRefundBps: 4000,
    artistCompensationBps: 6000,
  });
  const corrected = computeArtistCancellation({ amountKobo });

  const res = await withProvider(recordingProvider().overrides, () =>
    call('POST', `/admin/cancellations/${cancellation.id}/reclassify`, token, {
      reason: 'Artist changed the terms after confirmation.',
    })
  );

  // The compensation already left escrow and cannot be clawed back from the
  // provider, so it becomes a debt — alongside the fees the platform now fronts.
  assert.equal(res.body.reclassification.artistClawbackKobo, original.artistCompensationKobo);
  assert.equal(
    res.body.reclassification.liabilityKobo,
    original.artistCompensationKobo + corrected.feeLiabilityKobo
  );

  const liability = await prisma.feeLiability.findFirst({
    where: { originBookingId: booking.id },
  });
  assert.ok(liability);
  assert.equal(liability.artistUserId, artistUser.id);
  assert.equal(liability.amountKobo, res.body.reclassification.liabilityKobo);
  assert.equal(liability.status, 'OUTSTANDING');
});

describe('it accrues a strike as though the artist had cancelled', async () => {
  const strikeService = require('../src/services/strikeService.ts');
  const { rules } = await strikeService.resolveRules();
  const weightOf = (t: StrikeTrigger) =>
    rules.find((r: StrikeRuleRow) => r.trigger === t).weight;

  const { booking, cancellation, artistUser } = await cancelledByClient({ daysOut: 2 });
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  await withProvider(recordingProvider().overrides, () =>
    call('POST', `/admin/cancellations/${cancellation.id}/reclassify`, token, {
      reason: 'Artist raised the price after confirmation.',
    })
  );

  const strikes = await prisma.strike.findMany({ where: { bookingId: booking.id } });
  assert.equal(strikes.length, 1);
  assert.equal(strikes[0].userId, artistUser.id, 'the strike landed on the wrong party');
  assert.equal(strikes[0].trigger, 'ARTIST_CANCEL_1_2_DAYS');
  assert.equal(strikes[0].weight, weightOf('ARTIST_CANCEL_1_2_DAYS'));
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('reclassifying twice is refused, and corrects nothing further', async () => {
  const { booking, cancellation } = await cancelledByClient({ daysOut: 2 });
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  await withProvider(recordingProvider().overrides, () =>
    call('POST', `/admin/cancellations/${cancellation.id}/reclassify`, token, {
      reason: 'First decision.',
    })
  );

  const afterFirst = await prisma.ledgerEntry.count({ where: { bookingId: booking.id } });

  const second = await withProvider(
    {
      refund: async () => {
        throw new Error('a second reclassification must not move money');
      },
    },
    () =>
      call('POST', `/admin/cancellations/${cancellation.id}/reclassify`, token, {
        reason: 'Second decision.',
      })
  );

  assert.equal(second.status, 409);
  assert.match(second.body.error, /already been reclassified/i);
  assert.equal(await prisma.ledgerEntry.count({ where: { bookingId: booking.id } }), afterFirst);
  assert.equal(await prisma.feeLiability.count({ where: { originBookingId: booking.id } }), 1);
});

describe('an artist cancellation cannot be reclassified as artist-fault', async () => {
  const { booking, artistUser } = await cancelledByClient({ daysOut: 5 });

  // Rewrite the record as though the artist had cancelled it.
  const cancellation = await prisma.cancellation.update({
    where: { bookingId: booking.id },
    data: { initiatedBy: 'ARTIST', initiatedByUserId: artistUser.id },
  });

  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const res = await call('POST', `/admin/cancellations/${cancellation.id}/reclassify`, token, {
    reason: 'Trying to reclassify the wrong kind.',
  });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /already the artist/i);
});

describe('only an admin may reclassify', async () => {
  const { cancellation } = await cancelledByClient();
  const body = { reason: 'Attempting without authority.' };

  for (const role of ['CLIENT', 'ARTIST'] as UserRole[]) {
    const user = await makeUser(role);
    const token = await login(user.email);
    const res = await call(
      'POST',
      `/admin/cancellations/${cancellation.id}/reclassify`,
      token,
      body
    );
    assert.equal(res.status, 403, `${role} reclassified a cancellation`);
  }

  const anon = await fetch(`${server.url}/admin/cancellations/${cancellation.id}/reclassify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(anon.status, 401);
});

describe('an unknown cancellation is 404, not a silent no-op', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const res = await call('POST', '/admin/cancellations/does-not-exist/reclassify', token, {
    reason: 'Nothing to reclassify.',
  });
  assert.equal(res.status, 404);
});
