/**
 * Admin dispute resolution — issue #32, docs/04 §6.
 *
 * DISPUTE AUTHORITY SITS WITH US, NOT THE PROVIDER. EscrowPay does not
 * arbitrate; funds stay held until we instruct otherwise. This is the only
 * thing standing between a held escrow and a decision, so these tests are as
 * much about what a resolution refuses to do as what it does.
 */

process.env.QUEUE_PREFIX = `test-disputeres-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('disputeres');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const bookingService = require('../src/services/bookingService.ts');
const disputeService = require('../src/services/disputeService.ts');
const escrowService = require('../src/services/escrowService.ts');
const strikeService = require('../src/services/strikeService.ts');
const ledger = require('../src/services/ledgerService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const { computeCompletion, computeArtistCancellation, applyBps } =
  require('../src/services/feeService.ts');

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
      email: `dr${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

/** A disputed booking, optionally arising from a contradicted no-show claim. */
async function disputed({
  checkedIn = true,
  noShowClaim = false,
  amountKobo = N(200000),
} = {}) {
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
      payoutAccountId: `PAC_${uniq()}`,
      payoutAccountLast4: '4321',
    },
  });

  let booking = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo,
    eventDate: new Date(Date.now() + 30 * 86400000),
  });

  const eventEndAt = new Date(Date.now() - 3600_000);
  booking = await prisma.booking.update({
    where: { id: booking.id },
    data: {
      state: 'FUNDED_HELD',
      escrowId: `TXN_${uniq()}`,
      eventDate: new Date(eventEndAt.getTime() - 3 * 3600_000),
      eventEndAt,
      ...(noShowClaim
        ? { clientNoShowClaimedAt: new Date(), clientNoShowReason: 'They never showed up.' }
        : {}),
    },
  });

  await prisma.$transaction((tx: PrismaTx) => ledger.recordFunding(tx, booking));

  if (checkedIn) {
    await prisma.checkIn.create({
      data: { bookingId: booking.id, redeemedByUser: artistUser.id },
    });
  }

  const dispute = await prisma.$transaction((tx: PrismaTx) =>
    disputeService.openDispute(tx, {
      bookingId: booking.id,
      openedByUserId: clientUser.id,
      reason: 'The artist left after twenty minutes of a two-hour set.',
    })
  );

  booking = await prisma.booking.findUnique({ where: { id: booking.id } });

  return { booking, dispute, artist, artistUser, clientUser, amountKobo };
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

function recordingProvider() {
  const calls: any[] = [];
  return {
    calls,
    overrides: {
      release: async (a: any) => {
        calls.push({ leg: 'release', amountKobo: a.amountKobo, reference: a.reference });
        return { id: `REL_${uniq()}`, status: 'completed' };
      },
      refund: async (a: any) => {
        calls.push({ leg: 'refund', amountKobo: a.amountKobo, reference: a.reference });
        return { id: `RFD_${uniq()}`, status: 'completed' };
      },
      listWallets: async () => ({ items: [{ id: 'WLT_test', currency: 'NGN', enabled: true }] }),
      walletPayout: async (a: any) => {
        calls.push({ leg: 'payout', amountKobo: a.amountKobo });
        return { id: `PAY_${uniq()}`, status: 'pending' };
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

const sum = (e: LedgerEntryRow[]) => e.reduce((t: number, x: LedgerEntryRow) => t + x.amountKobo, 0);

// ---------------------------------------------------------------------------
// Criterion: a resolution produces the escrow instruction and ledger entries
// ---------------------------------------------------------------------------

describe('a release verdict pays the artist and reconciles', async () => {
  const { booking, dispute, amountKobo } = await disputed();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const provider = recordingProvider();
  const res = await withProvider(provider.overrides, () =>
    call('POST', `/admin/disputes/${dispute.id}/resolve`, token, {
      outcome: 'RELEASE',
      reason: 'The check-in record and the venue log both show a full set.',
    })
  );

  assert.equal(res.status, 200, res.body.error);

  const completion = computeCompletion({
    amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
  });

  // Escrow → our wallet → the artist. Both legs.
  assert.deepEqual(provider.calls.map((c: any) => c.leg), ['release', 'payout']);
  assert.equal(provider.calls[0].amountKobo, completion.artistNetKobo);

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'RESOLVED');

  const resolved = await prisma.dispute.findUnique({ where: { id: dispute.id } });
  assert.equal(resolved.state, 'RESOLVED_RELEASE');

  const entries = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });
  assert.equal(sum(entries), 0, 'the booking does not reconcile');
});

describe('a refund verdict makes the client whole and charges the artist', async () => {
  const { booking, dispute, artistUser, amountKobo } = await disputed();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const provider = recordingProvider();
  await withProvider(provider.overrides, () =>
    call('POST', `/admin/disputes/${dispute.id}/resolve`, token, {
      outcome: 'REFUND',
      reason: 'The artist did not provide what was agreed.',
    })
  );

  const expected = computeArtistCancellation({ amountKobo });

  assert.deepEqual(provider.calls.map((c: any) => c.leg), ['refund']);
  assert.equal(provider.calls[0].amountKobo, expected.clientRefundKobo);

  // The artist bears the cost, as they would for a cancellation — the platform
  // fronts it and recovers it from their next payout.
  const liability = await prisma.feeLiability.findFirst({
    where: { originBookingId: booking.id },
  });
  assert.ok(liability, 'a dispute lost by the artist left no liability');
  assert.equal(liability.artistUserId, artistUser.id);
  assert.equal(liability.amountKobo, expected.feeLiabilityKobo);

  const entries = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });
  assert.equal(sum(entries), 0);
});

// ---------------------------------------------------------------------------
// Criterion: a split divides funds correctly and reconciles
// ---------------------------------------------------------------------------

describe('a split divides the booking exactly and reconciles', async () => {
  // A deliberately awkward figure: 40% of ₦200,000 leaves a share whose
  // commission does not divide evenly, which is where a kobo goes missing.
  const { booking, dispute, amountKobo } = await disputed();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const clientShare = 8333300; // ₦83,333
  const provider = recordingProvider();

  const res = await withProvider(provider.overrides, () =>
    call('POST', `/admin/disputes/${dispute.id}/resolve`, token, {
      outcome: 'SPLIT',
      splitClientKobo: clientShare,
      reason: 'The artist performed for roughly half the agreed set.',
    })
  );

  assert.equal(res.status, 200, res.body.error);

  const artistShare = amountKobo - clientShare;
  const commission = applyBps(artistShare, booking.commissionRateBpsSnapshot);
  const artistNet = artistShare - commission;

  // THE ARTIST'S SHARE IS THE RESIDUAL. The two halves sum to the booking
  // exactly; computing both from their own percentage is what loses a kobo.
  const stored = await prisma.dispute.findUnique({ where: { id: dispute.id } });
  assert.equal(stored.state, 'RESOLVED_SPLIT');
  assert.equal(stored.splitClientKobo, clientShare);
  assert.equal(stored.splitArtistKobo, artistShare);
  assert.equal(stored.splitClientKobo + stored.splitArtistKobo, amountKobo);

  // The artist is instructed first — the party who did not ask for this should
  // not be the one waiting on a retry.
  assert.deepEqual(provider.calls.map((c: any) => c.leg), ['release', 'refund', 'payout']);
  assert.equal(provider.calls[0].amountKobo, artistNet);
  assert.equal(provider.calls[1].amountKobo, clientShare);

  const entries = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });
  assert.equal(sum(entries), 0, 'a split must reconcile to zero like anything else');
});

test('a split cannot be planned that does not divide the booking', () => {
  const booking = { amountKobo: N(200000), commissionRateBpsSnapshot: 500 } as BookingRow;

  for (const bad of [undefined, null, -1, N(200001), 1.5, '50000']) {
    assert.throws(
      () => escrowService.planSplit(booking, bad as any),
      /client's share|how much of the booking/i,
      `${bad} was accepted as a client share`
    );
  }

  // The edges are legal: everything to one side is a decision, not an error.
  assert.equal(escrowService.planSplit(booking, 0).artistKobo, N(200000));
  assert.equal(escrowService.planSplit(booking, N(200000)).artistKobo, 0);

  // And the halves always sum, whatever the figure.
  for (const share of [1, 7, 12345, N(99999), N(200000) - 1]) {
    const plan = escrowService.planSplit(booking, share);
    assert.equal(plan.clientKobo + plan.artistKobo, N(200000), `share ${share}`);
    assert.equal(plan.artistNetKobo + plan.commissionKobo, plan.artistKobo);
  }
});

// ---------------------------------------------------------------------------
// Criterion: resolving without a written reason is rejected
// ---------------------------------------------------------------------------

describe('a resolution without written reasoning is rejected', async () => {
  const { booking, dispute } = await disputed();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const noMoney = {
    release: async () => {
      throw new Error('no money may move without recorded reasoning');
    },
    refund: async () => {
      throw new Error('no money may move without recorded reasoning');
    },
  };

  for (const body of [
    { outcome: 'RELEASE' },
    { outcome: 'REFUND', reason: '' },
    { outcome: 'SPLIT', reason: '   ', splitClientKobo: 100 },
  ]) {
    const res = await withProvider(noMoney, () =>
      call('POST', `/admin/disputes/${dispute.id}/resolve`, token, body)
    );
    assert.equal(res.status, 400, `${JSON.stringify(body)} was accepted`);
    assert.match(res.body.error, /record the reasoning/i);
  }

  // Nothing happened. Not a partial resolution, not a state change.
  const still = await prisma.dispute.findUnique({ where: { id: dispute.id } });
  assert.equal(still.state, 'OPEN');
  assert.equal(still.resolvedAt, null);

  const b = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(b.state, 'DISPUTED');
});

// ---------------------------------------------------------------------------
// Criterion: the dispute record names the deciding admin
// ---------------------------------------------------------------------------

describe('the record names the deciding admin, and the audit row does too', async () => {
  const { dispute } = await disputed();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const reason = 'Check-in at 20:14 contradicts the no-show claim.';
  await withProvider(recordingProvider().overrides, () =>
    call('POST', `/admin/disputes/${dispute.id}/resolve`, token, {
      outcome: 'RELEASE',
      reason,
    })
  );

  const resolved = await prisma.dispute.findUnique({ where: { id: dispute.id } });
  assert.equal(resolved.resolvedByUserId, admin.id);
  assert.equal(resolved.resolutionReason, reason);
  assert.ok(resolved.resolvedAt);

  const audit = await prisma.auditLog.findFirst({
    where: { action: 'DISPUTE_RESOLVED', entityId: dispute.id },
  });
  assert.ok(audit, 'a manual money decision left no audit row');
  assert.equal(audit.actorUserId, admin.id);
  assert.equal((audit.after as any).outcome, 'RELEASE');
});

// ---------------------------------------------------------------------------
// Strike accrual
// ---------------------------------------------------------------------------

describe('a false no-show claim, ruled against, weighs heavier than an ordinary loss', async () => {
  const { rules } = await strikeService.resolveRules();
  const weightOf = (t: StrikeTrigger) =>
    rules.find((r: StrikeRuleRow) => r.trigger === t).weight;

  // A client who claimed a no-show against a recorded check-in, and lost.
  const fraud = await disputed({ checkedIn: true, noShowClaim: true });
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  await withProvider(recordingProvider().overrides, () =>
    call('POST', `/admin/disputes/${fraud.dispute.id}/resolve`, token, {
      outcome: 'RELEASE',
      reason: 'The check-in record contradicts the claim.',
    })
  );

  const heavy = await prisma.strike.findFirst({ where: { bookingId: fraud.booking.id } });
  assert.ok(heavy, 'no strike accrued against the losing party');
  assert.equal(heavy.userId, fraud.clientUser.id, 'the strike landed on the wrong party');
  assert.equal(heavy.trigger, 'DISPUTE_FALSE_NO_SHOW_CLAIM');

  // An ordinary loss — a dispute about quality, no no-show claim.
  const ordinary = await disputed({ checkedIn: true, noShowClaim: false });
  await withProvider(recordingProvider().overrides, () =>
    call('POST', `/admin/disputes/${ordinary.dispute.id}/resolve`, token, {
      outcome: 'RELEASE',
      reason: 'The set was delivered as agreed.',
    })
  );

  const light = await prisma.strike.findFirst({ where: { bookingId: ordinary.booking.id } });
  assert.equal(light.trigger, 'DISPUTE_RULED_AGAINST');

  // THE WHOLE POINT OF docs/06 §1: an attempt to obtain a performance for free
  // is priced above poor planning.
  assert.ok(heavy.weight > light.weight, `${heavy.weight} is not heavier than ${light.weight}`);
  assert.equal(heavy.weight, weightOf('DISPUTE_FALSE_NO_SHOW_CLAIM'));
});

describe('a refund verdict strikes the artist, not the client', async () => {
  const { booking, dispute, artistUser } = await disputed();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  await withProvider(recordingProvider().overrides, () =>
    call('POST', `/admin/disputes/${dispute.id}/resolve`, token, {
      outcome: 'REFUND',
      reason: 'The artist did not perform.',
    })
  );

  const strike = await prisma.strike.findFirst({ where: { bookingId: booking.id } });
  assert.equal(strike.userId, artistUser.id);
  assert.equal(strike.trigger, 'DISPUTE_RULED_AGAINST');
});

describe('a split strikes nobody — it is not a finding against either party', async () => {
  const { booking, dispute } = await disputed();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  await withProvider(recordingProvider().overrides, () =>
    call('POST', `/admin/disputes/${dispute.id}/resolve`, token, {
      outcome: 'SPLIT',
      splitClientKobo: N(100000),
      reason: 'Both accounts are partly right.',
    })
  );

  assert.equal(await prisma.strike.count({ where: { bookingId: booking.id } }), 0);
});

// ---------------------------------------------------------------------------
// The queue and the detail view
// ---------------------------------------------------------------------------

describe('the queue shows age, value and whether a check-in exists', async () => {
  const { booking, dispute } = await disputed({ checkedIn: true });
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const res = await call('GET', '/admin/disputes', token);
  assert.equal(res.status, 200);

  const entry = res.body.disputes.find((d: any) => d.id === dispute.id);
  assert.ok(entry, 'an open dispute is not in the queue');

  // What an admin triages on: money held, for how long, and whether the one
  // record that settles the common case exists.
  assert.equal(entry.amountKobo, booking.amountKobo);
  assert.ok(Number.isInteger(entry.ageDays));
  assert.equal(entry.hasCheckIn, true);
  assert.ok(entry.artist);
  assert.ok(entry.client);
});

describe('the check-in is first in the detail payload, not buried in attachments', async () => {
  const { dispute, clientUser } = await disputed({ checkedIn: true });

  await prisma.disputeEvidence.create({
    data: {
      disputeId: dispute.id,
      submittedByUserId: clientUser.id,
      statement: 'My account of the evening.',
    },
  });

  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);
  const res = await call('GET', `/admin/disputes/${dispute.id}`, token);

  assert.equal(res.status, 200);

  // docs/04 §6: surfaced above the fold. Most disputes should be cheap to
  // resolve because that single record reduces the common case to a binary
  // fact; burying it makes every dispute expensive.
  const keys = Object.keys(res.body.dispute);
  assert.ok(
    keys.indexOf('checkIn') < keys.indexOf('evidence'),
    'the check-in is ordered after the attachments'
  );
  assert.ok(res.body.dispute.checkIn.redeemedAt);

  // Both parties' submissions, each tagged with the side that filed it.
  assert.equal(res.body.dispute.evidence.length, 1);
  assert.equal(res.body.dispute.evidence[0].party, 'CLIENT');
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('a dispute cannot be resolved twice', async () => {
  const { dispute } = await disputed();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  await withProvider(recordingProvider().overrides, () =>
    call('POST', `/admin/disputes/${dispute.id}/resolve`, token, {
      outcome: 'RELEASE',
      reason: 'First decision.',
    })
  );

  const second = await withProvider(
    {
      release: async () => {
        throw new Error('a second resolution must not move money');
      },
      refund: async () => {
        throw new Error('a second resolution must not move money');
      },
    },
    () =>
      call('POST', `/admin/disputes/${dispute.id}/resolve`, token, {
        outcome: 'REFUND',
        reason: 'Changed my mind.',
      })
  );

  assert.equal(second.status, 409);
  assert.match(second.body.error, /already been decided/i);
});

describe('the mediator opinion is recorded and executes nothing', async () => {
  const { booking, dispute } = await disputed();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const provider = recordingProvider();
  await withProvider(provider.overrides, () =>
    call('POST', `/admin/disputes/${dispute.id}/resolve`, token, {
      outcome: 'SPLIT',
      splitClientKobo: N(50000),
      reason: 'Our decision, informed but not determined by the mediator.',
      mediatorOpinion: 'The mediator recommended a full refund to the client.',
    })
  );

  const resolved = await prisma.dispute.findUnique({ where: { id: dispute.id } });
  assert.match(resolved.externalMediatorOpinion, /recommended a full refund/);

  // The mediator said "full refund". We split. NOTHING EXECUTES FROM THAT FIELD
  // — the verdict returns to us and we issue the instruction (docs/04 §6).
  assert.equal(resolved.state, 'RESOLVED_SPLIT');
  assert.equal(resolved.splitClientKobo, N(50000));
  assert.ok(provider.calls.some((c: any) => c.leg === 'release'));

  assert.ok(booking);
});

describe('only an admin may resolve, and only through the admin path', async () => {
  const { dispute, clientUser, artistUser } = await disputed();
  const body = { outcome: 'RELEASE', reason: 'Attempting without authority.' };

  for (const user of [clientUser, artistUser]) {
    const token = await login(user.email);
    const res = await call('POST', `/admin/disputes/${dispute.id}/resolve`, token, body);
    assert.equal(res.status, 403, `${user.role} resolved a dispute`);
  }

  // And a party cannot read the admin queue either.
  const clientToken = await login(clientUser.email);
  assert.equal((await call('GET', '/admin/disputes', clientToken)).status, 403);

  const still = await prisma.dispute.findUnique({ where: { id: dispute.id } });
  assert.equal(still.state, 'OPEN');
});

describe('an unknown outcome is refused before anything moves', async () => {
  const { dispute } = await disputed();
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const res = await withProvider(
    {
      release: async () => {
        throw new Error('an unknown outcome must not move money');
      },
    },
    () =>
      call('POST', `/admin/disputes/${dispute.id}/resolve`, token, {
        outcome: 'PARTIAL_MAYBE',
        reason: 'Something in between.',
      })
  );

  assert.equal(res.status, 400);
  assert.match(res.body.error, /release, refund, or split/i);
});
