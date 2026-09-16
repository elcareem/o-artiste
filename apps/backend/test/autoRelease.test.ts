/**
 * Auto-release — issue #25.
 *
 * The one money movement in this system that happens because nobody asked for
 * it. Everything here is about the conditions under which it must NOT happen,
 * because those are the expensive direction: a release that should not have
 * fired pays out for an event that may never have occurred, and there is no
 * unwinding it.
 */

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// Unique per RUN, not merely per process: Redis keeps keys forever and the
// OS reuses pids, so a prefix of pid alone can land on a dead run's queue —
// including its job-id counter, which makes `getJob('1')` return a stranger.
process.env.QUEUE_PREFIX = `test-autorelease-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('autorelease');

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const autoReleaseJob = require('../src/jobs/autoReleaseJob.ts');
const bookingService = require('../src/services/bookingService.ts');
const ledger = require('../src/services/ledgerService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const queueLib = require('../src/lib/queue.ts');

const hasRedis = Boolean(process.env.REDIS_URL);
const describe = hasDatabase ? test : test.skip;
const describeQueue = hasDatabase && hasRedis ? test : test.skip;

const BACKEND_ROOT = path.resolve(__dirname, '..');

test.before(async () => {
  if (ready) await ready;
});

test.after(async () => {
  if (hasRedis) await queueLib.closeAll();
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
      email: `ar${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword('correct horse battery staple'),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

/**
 * A booking past its grace period with a check-in and a silent client — the
 * exact situation auto-release exists for. Variations turn off one condition
 * at a time.
 */
async function overdue({
  checkedIn = true,
  state = 'CHECKED_IN',
  hoursSinceEnd = 72,
}: { checkedIn?: boolean; state?: BookingState; hoursSinceEnd?: number } = {}) {
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

  const eventEndAt = new Date(Date.now() - hoursSinceEnd * 3600_000);

  booking = await prisma.booking.update({
    where: { id: booking.id },
    data: {
      state: 'FUNDED_HELD',
      escrowId: `TXN_${uniq()}`,
      eventDate: new Date(eventEndAt.getTime() - 3 * 3600_000),
      eventEndAt,
      autoReleaseAt: new Date(eventEndAt.getTime() + 48 * 3600_000),
    },
  });

  await prisma.$transaction((tx: PrismaTx) => ledger.recordFunding(tx, booking));

  if (checkedIn) {
    await prisma.checkIn.create({
      data: { bookingId: booking.id, redeemedByUser: artistUser.id },
    });
  }

  booking = await prisma.booking.update({ where: { id: booking.id }, data: { state } });

  return { booking, artist, artistUser, clientUser };
}

/** Replaces provider methods for the duration of a call. */
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

const releases = { release: async () => ({ id: `REL_${uniq()}`, status: 'completed' }) };

/** The provider rigged so that ANY money movement fails the test by name. */
const noMoneyMayMove = {
  release: async () => {
    throw new Error('release must not be called');
  },
  refund: async () => {
    throw new Error('refund must not be called');
  },
};

const runJob = (bookingId: string) =>
  autoReleaseJob.process({ data: { bookingId }, attemptsMade: 0 } as any);

/** Runs with a temporary grace period, restoring the real one after. */
function withGrace<T>(hours: number | undefined, fn: () => T): T {
  const saved = process.env.AUTO_RELEASE_GRACE_HOURS;
  if (hours === undefined) delete process.env.AUTO_RELEASE_GRACE_HOURS;
  else process.env.AUTO_RELEASE_GRACE_HOURS = String(hours);
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.AUTO_RELEASE_GRACE_HOURS;
    else process.env.AUTO_RELEASE_GRACE_HOURS = saved;
  }
}

// ---------------------------------------------------------------------------
// The grace period is configuration
// ---------------------------------------------------------------------------

test('the grace period is read from configuration and is never a constant', () => {
  // Open item docs/00 §11.5: the right number is not knowable until there is
  // real booking data. Too short and a client who was travelling loses their
  // window to dispute; too long and every artist waits on the slowest client.
  withGrace(undefined, () => assert.equal(autoReleaseJob.graceHours(), 48));
  withGrace(72, () => assert.equal(autoReleaseJob.graceHours(), 72));
  withGrace(1 / 60, () => assert.ok(Math.abs(autoReleaseJob.graceHours() - 1 / 60) < 1e-9));

  const eventEnd = new Date('2026-12-25T23:00:00Z');
  withGrace(48, () =>
    assert.equal(autoReleaseJob.deadlineFor(eventEnd).toISOString(), '2026-12-27T23:00:00.000Z')
  );
  withGrace(72, () =>
    assert.equal(autoReleaseJob.deadlineFor(eventEnd).toISOString(), '2026-12-28T23:00:00.000Z')
  );

  // A misconfigured value throws rather than falling back. A silent default
  // here is a payout timer nobody set.
  for (const bad of ['soon', '-1', '0']) {
    withGrace(bad as unknown as number, () => assert.throws(() => autoReleaseJob.graceHours(), /positive number of hours/));
  }
});

// ---------------------------------------------------------------------------
// Criterion: a silent client results in release
// ---------------------------------------------------------------------------

describe('with a one-minute grace period, a silent client results in release', async () => {
  const { booking, artist } = await overdue({ hoursSinceEnd: 1 });

  // One minute, expressed in the hours the setting takes.
  await withGrace(1 / 60, async () => {
    await prisma.booking.update({
      where: { id: booking.id },
      data: { autoReleaseAt: autoReleaseJob.deadlineFor(booking.eventEndAt) },
    });

    const outcome = await withProvider(releases, () => runJob(booking.id));

    assert.equal(outcome.released, true);
    assert.equal(outcome.reason, 'released');
  });

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'RELEASED');

  // The artist was actually paid, and the ledger balances.
  const entries = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });
  assert.equal(
    entries.reduce((sum: number, e: LedgerEntryRow) => sum + e.amountKobo, 0),
    0,
    'the ledger must sum to zero'
  );
  assert.ok(entries.some((e: LedgerEntryRow) => e.entryType === 'RELEASED'));
  assert.ok(artist);
});

// ---------------------------------------------------------------------------
// Criterion: running the job twice releases once
// ---------------------------------------------------------------------------

describe('running the job twice releases once', async () => {
  const { booking } = await overdue();

  const first = await withProvider(releases, () => runJob(booking.id));
  assert.equal(first.released, true);

  // The second run must not reach the provider at all.
  const second = await withProvider(noMoneyMayMove, () => runJob(booking.id));
  assert.equal(second.released, false);
  assert.equal(second.reason, 'already_settled');

  const releaseEntries = await prisma.ledgerEntry.findMany({
    where: { bookingId: booking.id, entryType: 'RELEASED' },
  });
  assert.equal(releaseEntries.length, 1, `${releaseEntries.length} release entries — it paid twice`);
});

describe('three concurrent runs release once', async () => {
  const { booking } = await overdue();

  // A job runner retrying after a partial failure, or two workers racing.
  const results = await withProvider(releases, () =>
    Promise.allSettled([runJob(booking.id), runJob(booking.id), runJob(booking.id)])
  );

  const released = results.filter(
    (r: any) => r.status === 'fulfilled' && r.value.released === true
  );
  assert.ok(released.length <= 1, `${released.length} of 3 runs reported a release`);

  const releaseEntries = await prisma.ledgerEntry.findMany({
    where: { bookingId: booking.id, entryType: 'RELEASED' },
  });
  assert.equal(releaseEntries.length, 1);
});

// ---------------------------------------------------------------------------
// Criterion: no check-in does not auto-release
// ---------------------------------------------------------------------------

describe('a booking with no check-in does not auto-release', async () => {
  const { booking } = await overdue({ checkedIn: false, state: 'FUNDED_HELD' });

  const outcome = await withProvider(noMoneyMayMove, () => runJob(booking.id));

  assert.equal(outcome.released, false);
  assert.equal(outcome.reason, 'no_check_in');

  // Nobody has evidence the event happened. It waits for a person.
  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'FUNDED_HELD');
  assert.equal(
    await prisma.ledgerEntry.count({ where: { bookingId: booking.id, entryType: 'RELEASED' } }),
    0
  );
});

// ---------------------------------------------------------------------------
// Criterion: an open dispute suppresses auto-release
// ---------------------------------------------------------------------------

describe('an open dispute suppresses auto-release', async () => {
  const { booking, clientUser } = await overdue();

  await prisma.dispute.create({
    data: {
      bookingId: booking.id,
      openedByUserId: clientUser.id,
      openedReason: 'The client reports a no-show against a recorded check-in.',
    },
  });
  await prisma.booking.update({ where: { id: booking.id }, data: { state: 'DISPUTED' } });

  const outcome = await withProvider(noMoneyMayMove, () => runJob(booking.id));

  assert.equal(outcome.released, false);
  assert.equal(outcome.reason, 'dispute_open');

  // Paying out on a timer would decide the dispute in the artist's favour by
  // default, which is exactly what docs/04 §5 forbids.
  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'DISPUTED');
});

describe('an open dispute suppresses it even from a non-DISPUTED state', async () => {
  // Defence in depth: the dispute row is checked, not only the booking state.
  const { booking, clientUser } = await overdue();
  await prisma.dispute.create({
    data: { bookingId: booking.id, openedByUserId: clientUser.id, openedReason: 'Contested.' },
  });

  const outcome = await withProvider(noMoneyMayMove, () => runJob(booking.id));
  assert.equal(outcome.reason, 'dispute_open');
});

// ---------------------------------------------------------------------------
// The other refusals
// ---------------------------------------------------------------------------

describe('a concluded booking is left alone, whatever the conclusion', async () => {
  for (const state of ['RELEASED', 'REFUNDED', 'CANCELLED', 'RESOLVED'] as BookingState[]) {
    const { booking } = await overdue();
    await prisma.booking.update({ where: { id: booking.id }, data: { state } });

    const outcome = await withProvider(noMoneyMayMove, () => runJob(booking.id));
    assert.equal(outcome.released, false, `${state} released`);
    assert.equal(outcome.reason, 'already_settled', `${state}: ${outcome.reason}`);
  }
});

describe('a booking whose client claimed a no-show is not released on a timer', async () => {
  const { booking } = await overdue();
  await prisma.booking.update({
    where: { id: booking.id },
    data: { clientNoShowClaimedAt: new Date(), clientNoShowReason: 'Nobody came.' },
  });

  const outcome = await withProvider(noMoneyMayMove, () => runJob(booking.id));
  assert.equal(outcome.reason, 'client_claimed_no_show');
});

describe('a job that wakes early does not pay early', async () => {
  const { booking } = await overdue({ hoursSinceEnd: 1 });
  await prisma.booking.update({
    where: { id: booking.id },
    data: { autoReleaseAt: new Date(Date.now() + 3600_000) },
  });

  // BullMQ should not deliver before the delay elapses. This job moves money,
  // so a delay miscalculated anywhere else must not become an early payout.
  const outcome = await withProvider(noMoneyMayMove, () => runJob(booking.id));
  assert.equal(outcome.released, false);
  assert.equal(outcome.reason, 'not_yet_due');
});

describe('a deleted booking is reported, not thrown', async () => {
  const outcome = await runJob('bkg_does_not_exist');
  assert.equal(outcome.released, false);
  assert.equal(outcome.reason, 'booking_missing');
});

// ---------------------------------------------------------------------------
// Scheduling and disclosure
// ---------------------------------------------------------------------------

describeQueue('scheduling records the deadline the client is shown', async () => {
  const { booking } = await overdue({ hoursSinceEnd: -24 });
  const queue = queueLib.getQueue(autoReleaseJob.QUEUE_NAME);
  await queue.remove(autoReleaseJob.jobIdFor(booking.id));

  const deadline = await withGrace(48, () => autoReleaseJob.schedule(booking));
  assert.ok(deadline, 'scheduling failed');

  const stored = await prisma.booking.findUnique({ where: { id: booking.id } });

  // The disclosed deadline and the scheduled job must be the same instant. A
  // deadline recomputed from live configuration would drift away from the job
  // that was actually queued, and the disclosure would become a lie.
  const job = await queue.getJob(autoReleaseJob.jobIdFor(booking.id));
  assert.ok(job, 'no job on the queue');

  const firesAt = job.timestamp + (job.opts.delay ?? 0);
  assert.ok(
    Math.abs(firesAt - new Date(stored.autoReleaseAt).getTime()) < 5_000,
    `disclosed ${stored.autoReleaseAt} but scheduled ${new Date(firesAt).toISOString()}`
  );

  // Scheduling twice cannot double-queue.
  await withGrace(48, () => autoReleaseJob.schedule(booking));
  const queued = await queue.getJobs(['delayed', 'waiting']);
  assert.equal(
    queued.filter((j: any) => j?.data?.bookingId === booking.id).length,
    1
  );

  // And concluding the booking clears it.
  await autoReleaseJob.cancel(booking.id);
  assert.equal(await queue.getJob(autoReleaseJob.jobIdFor(booking.id)), undefined);
});

test('the job id is stable, distinct, and acceptable to BullMQ', () => {
  assert.equal(autoReleaseJob.jobIdFor('b1'), autoReleaseJob.jobIdFor('b1'));
  assert.notEqual(autoReleaseJob.jobIdFor('b1'), autoReleaseJob.jobIdFor('b2'));
  assert.doesNotMatch(autoReleaseJob.jobIdFor('b1'), /:/);
});

// ---------------------------------------------------------------------------
// Criterion: the scheduled job survives a worker restart
// ---------------------------------------------------------------------------

describeQueue('the scheduled job survives a worker restart', async () => {
  const { booking } = await overdue({ hoursSinceEnd: 1 });

  const queue = queueLib.getQueue(autoReleaseJob.QUEUE_NAME);
  const jobId = autoReleaseJob.jobIdFor(booking.id);
  await queue.remove(jobId);

  // Queued with NOTHING running that could consume it.
  await queue.add(autoReleaseJob.JOB_NAME, { bookingId: booking.id }, { jobId, delay: 1500 });
  assert.equal(await (await queue.getJob(jobId)).getState(), 'delayed');

  // A worker in a genuinely separate OS process, started afterwards — which is
  // what makes auto-release survive a deploy.
  const worker = spawn('node', ['src/worker.ts'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, AUTO_RELEASE_GRACE_HOURS: String(1 / 60) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output: string[] = [];
  worker.stdout.on('data', (d: any) => output.push(d.toString()));
  worker.stderr.on('data', (d: any) => output.push(d.toString()));

  try {
    const deadline = Date.now() + 30000;
    let state = '';
    while (Date.now() < deadline) {
      const job = await queue.getJob(jobId);
      state = job ? await job.getState() : 'gone';
      if (state === 'completed' || state === 'failed') break;
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.equal(state, 'completed', `job ended as ${state}. worker output:\n${output.join('')}`);
    assert.match(output.join(''), /listening on queues/);
  } finally {
    worker.kill('SIGTERM');
  }
});
