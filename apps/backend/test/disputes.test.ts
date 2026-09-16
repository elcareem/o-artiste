/**
 * Dispute opening and evidence — issue #31, docs/04 §5.
 *
 * THE FUNDS STAY HELD AND NOTHING RESOLVES ON A TIMER. Any default outcome is
 * gameable: whichever party it favours simply waits for the clock. These tests
 * are mostly about what does NOT happen.
 */

process.env.QUEUE_PREFIX = `test-disputes-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('disputes');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const bookingService = require('../src/services/bookingService.ts');
const disputeService = require('../src/services/disputeService.ts');
const autoReleaseJob = require('../src/jobs/autoReleaseJob.ts');
const ledger = require('../src/services/ledgerService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const queueLib = require('../src/lib/queue.ts');

const hasRedis = Boolean(process.env.REDIS_URL);
const describe = hasDatabase ? test : test.skip;
const describeQueue = hasDatabase && hasRedis ? test : test.skip;

const PASSWORD = 'correct horse battery staple';

let server: TestServer;

test.before(async () => {
  if (ready) await ready;
  server = await startServer(createApp());
});

test.after(async () => {
  if (server) await server.close();
  await queueLib.closeAll();
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
      email: `dsp${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

/** A funded booking whose event has finished, optionally with a check-in. */
async function afterTheEvent({ checkedIn = false, state = 'FUNDED_HELD' } = {}) {
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
      baseRateKobo: N(200000),
      profileComplete: true,
    },
  });

  let booking = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo: N(200000),
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
      autoReleaseAt: new Date(Date.now() + 3600_000),
    },
  });

  await prisma.$transaction((tx: PrismaTx) => ledger.recordFunding(tx, booking));

  if (checkedIn) {
    await prisma.checkIn.create({
      data: { bookingId: booking.id, redeemedByUser: artistUser.id },
    });
  }

  if (state !== 'FUNDED_HELD') {
    booking = await prisma.booking.update({ where: { id: booking.id }, data: { state } });
  }

  return { booking, artist, artistUser, clientUser };
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

const noMoneyMayMove = {
  release: async () => {
    throw new Error('release must not be called on a disputed booking');
  },
  refund: async () => {
    throw new Error('refund must not be called on a disputed booking');
  },
  walletPayout: async () => {
    throw new Error('payout must not be called on a disputed booking');
  },
};

// ---------------------------------------------------------------------------
// Criterion: opening a dispute prevents auto-release from firing
// ---------------------------------------------------------------------------

describe('opening a dispute stops the auto-release from firing', async () => {
  const { booking, clientUser } = await afterTheEvent({ checkedIn: true });
  const token = await login(clientUser.email);

  const opened = await call('POST', `/bookings/${booking.id}/disputes`, token, {
    reason: 'The artist played for twenty minutes of a two-hour set.',
  });
  assert.equal(opened.status, 201);

  // The job re-checks when it wakes, and refuses. Rigged so that ANY money
  // movement fails by name.
  const outcome = await withProvider(noMoneyMayMove, () =>
    autoReleaseJob.process({ data: { bookingId: booking.id }, attemptsMade: 0 } as any)
  );

  assert.equal(outcome.released, false);
  assert.equal(outcome.reason, 'dispute_open');

  // Paying out on a timer would decide the dispute in the artist's favour by
  // default, which docs/04 §5 forbids absolutely.
  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'DISPUTED');
  assert.equal(
    await prisma.ledgerEntry.count({
      where: { bookingId: booking.id, entryType: { in: ['RELEASED', 'REFUNDED'] } },
    }),
    0,
    'money moved on a disputed booking'
  );
});

describeQueue('the pending auto-release job is removed from the queue as well', async () => {
  const { booking, artistUser } = await afterTheEvent({ checkedIn: true });

  const queue = queueLib.getQueue(autoReleaseJob.QUEUE_NAME);
  const jobId = autoReleaseJob.jobIdFor(booking.id);
  await queue.remove(jobId);
  await queue.add(autoReleaseJob.JOB_NAME, { bookingId: booking.id }, { jobId, delay: 600_000 });

  assert.ok(await queue.getJob(jobId), 'the fixture did not queue a job');

  const token = await login(artistUser.email);
  await call('POST', `/bookings/${booking.id}/disputes`, token, {
    reason: 'The client refuses to confirm although I performed.',
  });

  // The job would no-op anyway — it re-reads and finds the dispute — so this is
  // the second of two guards. A dispute raised near the grace boundary must not
  // be a race.
  assert.equal(await queue.getJob(jobId), undefined, 'the auto-release job is still queued');
});

// ---------------------------------------------------------------------------
// Criterion: both parties can attach evidence to the same dispute
// ---------------------------------------------------------------------------

describe('both parties attach evidence to the same dispute, and both can read it', async () => {
  const { booking, clientUser, artistUser } = await afterTheEvent({ checkedIn: true });
  const clientToken = await login(clientUser.email);
  const artistToken = await login(artistUser.email);

  const opened = await call('POST', `/bookings/${booking.id}/disputes`, clientToken, {
    reason: 'The sound equipment promised was not provided.',
  });
  const disputeId = opened.body.dispute.id;

  const fromClient = await call('POST', `/disputes/${disputeId}/evidence`, clientToken, {
    statement: 'We agreed a full PA system. They arrived with a single speaker.',
    fileUrl: 'https://example.test/evidence/contract.pdf',
  });
  assert.equal(fromClient.status, 201);

  const fromArtist = await call('POST', `/disputes/${disputeId}/evidence`, artistToken, {
    statement: 'The booking said vocals only. I have the message thread.',
  });
  assert.equal(fromArtist.status, 201);

  // ONE dispute, both submissions. Separate records per party would let an
  // admin read one without the other.
  const asArtist = await call('GET', `/disputes/${disputeId}`, artistToken);
  assert.equal(asArtist.body.dispute.evidence.length, 2);

  const parties = asArtist.body.dispute.evidence.map((e: any) => e.party).sort();
  assert.deepEqual(parties, ['ARTIST', 'CLIENT']);

  // Each side sees the other's case, so they can answer it rather than guess.
  const asClient = await call('GET', `/disputes/${disputeId}`, clientToken);
  assert.equal(asClient.body.dispute.evidence.length, 2);
  assert.ok(
    asClient.body.dispute.evidence.some((e: any) => e.byYou === false && e.statement),
    'the client cannot see the artist’s statement'
  );

  // And whose is whose, without exposing user ids to the other party.
  const text = JSON.stringify(asClient.body);
  assert.ok(!text.includes(artistUser.id), 'the other party’s user id leaked');
});

describe('evidence may be a statement, a file, or both — but not neither', async () => {
  const { booking, clientUser } = await afterTheEvent();
  const token = await login(clientUser.email);

  const opened = await call('POST', `/bookings/${booking.id}/disputes`, token, {
    reason: 'The artist never arrived.',
  });
  const disputeId = opened.body.dispute.id;

  assert.equal(
    (await call('POST', `/disputes/${disputeId}/evidence`, token, { statement: 'Just words.' }))
      .status,
    201
  );
  assert.equal(
    (await call('POST', `/disputes/${disputeId}/evidence`, token, {
      fileUrl: 'https://example.test/a.jpg',
    })).status,
    201
  );

  for (const body of [{}, { statement: '   ' }, { statement: '', fileUrl: '' }]) {
    const res = await call('POST', `/disputes/${disputeId}/evidence`, token, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} was accepted`);
    assert.match(res.body.error, /add a statement or a file/i);
  }
});

describe('a file link that is not a web address is refused', async () => {
  const { booking, clientUser } = await afterTheEvent();
  const token = await login(clientUser.email);

  const opened = await call('POST', `/bookings/${booking.id}/disputes`, token, {
    reason: 'Disputed.',
  });
  const disputeId = opened.body.dispute.id;

  // fileUrl is rendered in the admin queue, so a javascript: or data: value is
  // a script running in the browser of the person deciding the case.
  for (const fileUrl of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'not a url at all',
  ]) {
    const res = await call('POST', `/disputes/${disputeId}/evidence`, token, { fileUrl });
    assert.equal(res.status, 400, `"${fileUrl}" was accepted`);
  }

  assert.equal(
    (await call('POST', `/disputes/${disputeId}/evidence`, token, {
      fileUrl: 'https://example.test/ok.png',
    })).status,
    201
  );
});

// ---------------------------------------------------------------------------
// Criterion: a dispute cannot reach resolved without an admin action
// ---------------------------------------------------------------------------

test('nothing in this module writes a resolved state', () => {
  const service = require('../src/services/disputeService.ts');

  // The money-moving half is #32. Keeping it out of here is what makes "no
  // resolution without an admin action" a property of the CODE rather than a
  // rule someone has to remember.
  //
  // Asserted against the source, because a name-based check proves nothing —
  // the first version of this test matched its own `RESOLVED_STATES` constant
  // and would have passed a module that quietly resolved through a function
  // called something else.
  const source = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../src/services/disputeService.ts'),
    'utf8'
  );

  const writes = source
    .split('\n')
    .filter((line: string) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .filter((line: string) => /state:\s*['\"]RESOLVED/.test(line));

  assert.deepEqual(writes, [], `this module assigns a resolved state:\n${writes.join('\n')}`);

  // And the transition map refuses to reopen a decided one.
  for (const state of service.RESOLVED_STATES) {
    assert.throws(
      () => service.assertDisputeTransition(state, 'UNDER_REVIEW'),
      /already been decided/i,
      `${state} was reopenable`
    );
  }

  // A dispute reaching a resolved state is legal from OPEN and UNDER_REVIEW —
  // #32 does it. This module simply never takes that step.
  service.assertDisputeTransition('UNDER_REVIEW', 'RESOLVED_SPLIT');
  service.assertDisputeTransition('OPEN', 'RESOLVED_REFUND');
});

describe('submitting evidence moves a dispute along but never decides it', async () => {
  const { booking, clientUser } = await afterTheEvent({ checkedIn: true });
  const token = await login(clientUser.email);

  const opened = await call('POST', `/bookings/${booking.id}/disputes`, token, {
    reason: 'Contested.',
  });
  assert.equal(opened.body.dispute.state, 'OPEN');

  const after = await call('POST', `/disputes/${opened.body.dispute.id}/evidence`, token, {
    statement: 'My account of what happened.',
  });

  // OPEN → UNDER_REVIEW, so an admin queue can tell "nobody has said anything"
  // from "both sides have made their case".
  assert.equal(after.body.dispute.state, 'UNDER_REVIEW');
  assert.equal(after.body.dispute.resolvedAt, null);

  // The booking has not moved either.
  const b = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(b.state, 'DISPUTED');
});

// ---------------------------------------------------------------------------
// Criterion: the check-in is attached automatically where one exists
// ---------------------------------------------------------------------------

describe('the check-in record is attached automatically', async () => {
  const withCheckIn = await afterTheEvent({ checkedIn: true });
  const token = await login(withCheckIn.clientUser.email);

  const opened = await call('POST', `/bookings/${withCheckIn.booking.id}/disputes`, token, {
    reason: 'They arrived but left after one song.',
  });

  // It reduces "did the event happen?" to a timestamped fact, and an admin
  // should not have to go looking for the one piece of evidence that settles it.
  assert.ok(opened.body.dispute.checkIn, 'the check-in was not attached');
  assert.ok(opened.body.dispute.checkIn.redeemedAt);

  const row = await prisma.dispute.findUnique({ where: { id: opened.body.dispute.id } });
  const checkIn = await prisma.checkIn.findUnique({
    where: { bookingId: withCheckIn.booking.id },
  });
  assert.equal(row.checkInId, checkIn.id);

  // And null where there is none, rather than an empty object that reads as one.
  const without = await afterTheEvent({ checkedIn: false });
  const otherToken = await login(without.clientUser.email);
  const second = await call('POST', `/bookings/${without.booking.id}/disputes`, otherToken, {
    reason: 'Nobody came.',
  });
  assert.equal(second.body.dispute.checkIn, null);
});

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

describe('a second dispute on the same booking returns the first', async () => {
  const { booking, clientUser, artistUser } = await afterTheEvent({ checkedIn: true });
  const clientToken = await login(clientUser.email);
  const artistToken = await login(artistUser.email);

  const first = await call('POST', `/bookings/${booking.id}/disputes`, clientToken, {
    reason: 'First grievance.',
  });

  // Even from the other party. Two disputes over one booking is two people
  // deciding the same money.
  const second = await call('POST', `/bookings/${booking.id}/disputes`, artistToken, {
    reason: 'Second grievance.',
  });

  assert.equal(second.body.dispute.id, first.body.dispute.id);
  assert.equal(await prisma.dispute.count({ where: { bookingId: booking.id } }), 1);
});

describe('a dispute must say what it is about', async () => {
  const { booking, clientUser } = await afterTheEvent();
  const token = await login(clientUser.email);

  for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
    const res = await call('POST', `/bookings/${booking.id}/disputes`, token, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} was accepted`);
    assert.match(res.body.error, /what the dispute is about/i);
  }

  assert.equal(await prisma.dispute.count({ where: { bookingId: booking.id } }), 0);
});

describe('a booking that cannot be disputed says why', async () => {
  const unpaid = await afterTheEvent({ state: 'PENDING_PAYMENT' });
  const unpaidToken = await login(unpaid.clientUser.email);
  const notPaid = await call('POST', `/bookings/${unpaid.booking.id}/disputes`, unpaidToken, {
    reason: 'Trying anyway.',
  });
  assert.equal(notPaid.status, 409);
  assert.match(notPaid.body.error, /cancel it instead/i);

  for (const state of ['RELEASED', 'REFUNDED', 'CANCELLED'] as BookingState[]) {
    const closed = await afterTheEvent({ state });
    const token = await login(closed.clientUser.email);
    const res = await call('POST', `/bookings/${closed.booking.id}/disputes`, token, {
      reason: 'Too late.',
    });
    assert.equal(res.status, 409, `${state} was accepted`);
    assert.match(res.body.error, /closed/i);
    assert.doesNotMatch(res.body.error, /[A-Z]{3,}_[A-Z]/, `${state} leaked its enum name`);
  }
});

describe('a stranger can neither open nor read a dispute', async () => {
  const { booking, clientUser } = await afterTheEvent({ checkedIn: true });
  const token = await login(clientUser.email);
  const opened = await call('POST', `/bookings/${booking.id}/disputes`, token, {
    reason: 'Contested.',
  });

  const stranger = await makeUser('CLIENT');
  await prisma.client.create({ data: { userId: stranger.id, displayName: 'Stranger' } });
  const strangerToken = await login(stranger.email);

  // 404 rather than 403 — confirming a booking or a dispute exists is itself
  // information.
  assert.equal(
    (await call('POST', `/bookings/${booking.id}/disputes`, strangerToken, { reason: 'x' })).status,
    404
  );
  assert.equal(
    (await call('GET', `/disputes/${opened.body.dispute.id}`, strangerToken)).status,
    404
  );
  assert.equal(
    (await call('POST', `/disputes/${opened.body.dispute.id}/evidence`, strangerToken, {
      statement: 'Not my dispute.',
    })).status,
    404
  );
});

describe('a no-show claim contradicted by a check-in still opens one automatically', async () => {
  // #24's path, now going through this module so the two cannot drift apart.
  const { booking, clientUser } = await afterTheEvent({ checkedIn: true });
  await prisma.booking.update({
    where: { id: booking.id },
    data: { state: 'AWAITING_CONFIRMATION' },
  });

  const token = await login(clientUser.email);
  const res = await withProvider(noMoneyMayMove, () =>
    call('POST', `/bookings/${booking.id}/claim-no-show`, token, {
      reason: 'They never showed up.',
    })
  );

  assert.equal(res.body.confirmation.outcome, 'dispute');

  const dispute = await prisma.dispute.findFirst({ where: { bookingId: booking.id } });
  assert.equal(dispute.state, 'OPEN');

  // The check-in attached, and the client's own words carried in so the artist
  // can answer them.
  const checkIn = await prisma.checkIn.findUnique({ where: { bookingId: booking.id } });
  assert.equal(dispute.checkInId, checkIn.id);
  assert.match(dispute.openedReason, /They never showed up\./);
});
