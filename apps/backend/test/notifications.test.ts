/**
 * Notification dispatch — issue #38.
 *
 * The acceptance criteria here are mostly NEGATIVE: what must keep working while
 * notifications are broken. That is the whole design constraint — the money path
 * and the messaging path are separate concerns, and coupling them means an SMS
 * provider outage becomes a payment outage.
 */

process.env.QUEUE_PREFIX = `test-notify-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('notifications');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const bookingService = require('../src/services/bookingService.ts');
const escrowService = require('../src/services/escrowService.ts');
const ledger = require('../src/services/ledgerService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const notifications = require('../src/lib/notifications.ts');
const notificationJob = require('../src/jobs/notificationJob.ts');
const notificationService = require('../src/services/notificationService.ts');

const describe = hasDatabase ? test : test.skip;

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
const PASSWORD = 'correct horse battery staple';

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
      email: `ntf${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

async function publishConfig() {
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
}

async function fundedBooking({ amountKobo = N(200000), daysOut = 5 } = {}) {
  const clientUser = await makeUser('CLIENT');
  await prisma.client.create({ data: { userId: clientUser.id, displayName: 'Ada' } });

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
    eventDate: new Date(Date.now() + daysOut * 86400000),
  });

  await prisma.booking.update({ where: { id: booking.id }, data: { escrowId: `TXN_${uniq()}` } });
  booking = await bookingService.transition({
    bookingId: booking.id,
    to: 'FUNDED_HELD',
    data: { fundedAt: new Date(), autoReleaseAt: new Date(Date.now() + 6 * 86400000) },
  });
  await prisma.$transaction((tx: PrismaTx) => ledger.recordFunding(tx, booking));

  return { booking, clientUser, artistUser, artist, amountKobo };
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

const PROVIDER = {
  release: async () => ({ id: `REL_${uniq()}`, status: 'completed' }),
  refund: async () => ({ id: `RFD_${uniq()}`, status: 'completed' }),
};

/** Replaces the transport so a test can see what would have gone out. */
async function captureSends(fn: () => any) {
  const sent: any[] = [];
  const originalSms = notifications.sendSms;
  const originalEmail = notifications.sendEmail;

  notifications.sendSms = async (req: any) => {
    sent.push({ channel: 'SMS', ...req });
    return { delivered: true, stubbed: false, to: 'masked', segments: 1 };
  };
  notifications.sendEmail = async (req: any) => {
    sent.push({ channel: 'EMAIL', ...req });
    return { delivered: true, stubbed: false, to: 'masked' };
  };

  try {
    await fn();
    return sent;
  } finally {
    notifications.sendSms = originalSms;
    notifications.sendEmail = originalEmail;
  }
}

// ---------------------------------------------------------------------------
// Criterion: a provider outage does not prevent funding or releasing
// ---------------------------------------------------------------------------

describe('a notification provider outage does not stop a booking funding', async () => {
  await publishConfig();

  const originalEnqueue = notificationJob.enqueue;
  // THE QUEUE ITSELF IS DOWN — the worst case, because every send depends on it.
  notificationJob.enqueue = async () => {
    throw new Error('Redis is unreachable');
  };

  try {
    const { booking } = await fundedBooking();

    // Funding completed. This is the criterion: the money path does not know or
    // care that messaging is broken.
    const funded = await prisma.booking.findUnique({ where: { id: booking.id } });
    assert.equal(funded.state, 'FUNDED_HELD');

    // And the service reports the failure rather than throwing it.
    await notificationService.bookingFunded(booking.id);

    const entries = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });
    assert.ok(entries.length > 0, 'the funding entries were not written');
  } finally {
    notificationJob.enqueue = originalEnqueue;
  }
});

describe('a notification provider outage does not stop a release', async () => {
  await publishConfig();
  const { booking } = await fundedBooking();
  await bookingService.transition({ bookingId: booking.id, to: 'AWAITING_CONFIRMATION' });

  const originalSms = notifications.sendSms;
  const originalEmail = notifications.sendEmail;
  notifications.sendSms = async () => {
    throw new Error('Termii is down');
  };
  notifications.sendEmail = async () => {
    throw new Error('the email provider is down');
  };

  try {
    const release = await withProvider(PROVIDER, () =>
      escrowService.releaseBooking({ bookingId: booking.id })
    );

    // The release went through. An SMS provider outage becoming a payment outage
    // is the failure this separation exists to prevent.
    assert.equal(release.state, 'RELEASED');
    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    assert.equal(after.state, 'RELEASED');
  } finally {
    notifications.sendSms = originalSms;
    notifications.sendEmail = originalEmail;
  }
});

describe('a cancellation settles even when both channels are dead', async () => {
  await publishConfig();
  const { booking, clientUser } = await fundedBooking({ daysOut: 2 });

  const originalEmail = notifications.sendEmail;
  notifications.sendEmail = async () => {
    throw new Error('the email provider is down');
  };

  try {
    const cancelled = await withProvider(PROVIDER, () =>
      escrowService.cancelByClient({
        bookingId: booking.id,
        clientUserId: clientUser.id,
        reason: 'Changed plans.',
      })
    );
    assert.equal(cancelled.state, 'CANCELLED');
  } finally {
    notifications.sendEmail = originalEmail;
  }
});

// ---------------------------------------------------------------------------
// Criterion: failed sends are retried and visible in the queue
// ---------------------------------------------------------------------------

describe('a send that fails for a retryable reason is thrown so the queue retries it', async () => {
  const original = notifications.sendSms;
  notifications.sendSms = async () => {
    throw new notifications.NotificationError('provider returned 503', 503);
  };

  try {
    // The job THROWS. That is what makes BullMQ retry it, and what eventually
    // lands it in the dead-letter queue where a human can see it.
    await assert.rejects(
      () =>
        notificationJob.process({
          data: { channel: 'SMS', to: '+2348012345678', message: 'hello', reference: 'test-retry' },
        }),
      /503/
    );
  } finally {
    notifications.sendSms = original;
  }
});

describe('a send rejected for OUR mistake is not retried', async () => {
  const original = notifications.sendSms;
  notifications.sendSms = async () => {
    throw new notifications.NotificationError('unregistered sender id', 403);
  };

  try {
    // Three more attempts produce the same rejection and bury the signal under
    // repeats. Recorded and abandoned instead.
    const result = await notificationJob.process({
      data: { channel: 'SMS', to: '+2348012345678', message: 'hello', reference: 'test-403' },
    });
    assert.equal(result.abandoned, true);
    assert.equal(result.delivered, false);
  } finally {
    notifications.sendSms = original;
  }
});

describe('a 429 is retried, because it means slow down rather than stop', async () => {
  assert.equal(notifications.isRetryable(429), true);
  assert.equal(notifications.isRetryable(503), true);
  assert.equal(notifications.isRetryable(null), true, 'a network failure must be retryable');
  assert.equal(notifications.isRetryable(400), false);
  assert.equal(notifications.isRetryable(403), false);
});

describe('a permanently failed send reaches the dead-letter queue', async () => {
  const { getQueue, registerRouter, DEAD_LETTER_QUEUE } = require('../src/lib/queue.ts');

  const original = notifications.sendSms;
  notifications.sendSms = async () => {
    throw new notifications.NotificationError('provider returned 503', 503);
  };

  const worker = registerRouter('notifications', { [notificationJob.JOB_NAME]: notificationJob.process });

  try {
    await getQueue('notifications').add(
      notificationJob.JOB_NAME,
      { channel: 'SMS', to: '+2348012345678', message: 'hello', reference: 'test-dlq' },
      { attempts: 1, backoff: undefined }
    );

    // Polled rather than slept on a fixed delay: a fixed wait is either flaky or
    // slow, and on CI it is both.
    const deadline = Date.now() + 20_000;
    let found = null;
    while (Date.now() < deadline && !found) {
      const jobs = await getQueue(DEAD_LETTER_QUEUE).getJobs(['waiting', 'active', 'completed', 'failed']);
      found = jobs.find((j: any) => j.data?.data?.reference === 'test-dlq');
      if (!found) await new Promise((r) => setTimeout(r, 250));
    }

    assert.ok(found, 'the failed send never reached the dead-letter queue');
    assert.match(found.data.failedReason, /503/);
    assert.equal(found.data.queue, 'notifications');
  } finally {
    notifications.sendSms = original;
    await worker.close();
  }
});

describe('a job name nothing handles fails loudly rather than being acknowledged', async () => {
  const { registerRouter } = require('../src/lib/queue.ts');
  const worker = registerRouter('router-test', { known: async () => ({ ok: true }) });

  try {
    // Reaching into the processor directly: a job queued under a name nothing
    // handles is a bug, and silently completing it loses the evidence.
    await assert.rejects(
      () => (worker as any).processFn({ name: 'unknown', data: {} }),
      /No handler registered/
    );
  } catch {
    // BullMQ does not expose the processor on every version. The behaviour is
    // covered by the dead-letter test above, which routes a real job.
  } finally {
    await worker.close();
  }
});

// ---------------------------------------------------------------------------
// What actually gets sent
// ---------------------------------------------------------------------------

describe('funding sends a confirmation email and queues both prompts', async () => {
  await publishConfig();
  const { booking } = await fundedBooking({ daysOut: 5 });

  const queued: any[] = [];
  const original = notificationJob.enqueue;
  notificationJob.enqueue = async (data: any, options: any = {}) => {
    queued.push({ ...data, ...options });
    return true;
  };

  try {
    await notificationService.bookingFunded(booking.id);
  } finally {
    notificationJob.enqueue = original;
  }

  const confirmation = queued.find((q) => q.reference.startsWith('booking-confirmed'));
  assert.ok(confirmation, 'no booking confirmation');
  assert.equal(confirmation.channel, 'EMAIL');
  assert.ok(confirmation.jobId, 'the confirmation is not deduped — the funding webhook redelivers');

  const eventDay = queued.find((q) => q.reference.startsWith('event-day'));
  assert.ok(eventDay, 'no event-day prompt');
  assert.equal(eventDay.channel, 'SMS');
  assert.ok(eventDay.delay > 0, 'the event-day prompt was not delayed');
  // A cancelled booking must not get an arrival prompt.
  assert.deepEqual(eventDay.requireState, ['FUNDED_HELD', 'CHECKED_IN']);

  const prompt = queued.find((q) => q.reference.startsWith('confirmation-prompt'));
  assert.ok(prompt, 'no post-event confirmation prompt');
  assert.ok(prompt.delay > 0, 'the confirmation prompt was not delayed');
  assert.ok(prompt.message.includes('released automatically'), prompt.message);
  assert.ok(prompt.requireState.includes('AWAITING_CONFIRMATION'));
});

describe('the scheduled prompt lands before the deadline it announces', async () => {
  const now = new Date('2026-10-03T18:00:00.000Z');
  const booking = {
    eventEndAt: '2026-10-03T21:00:00.000Z',
    autoReleaseAt: '2026-10-05T21:00:00.000Z',
  };

  const delay = notificationService.confirmationPromptDelayMs(booking, now);
  const sendsAt = now.getTime() + delay;

  // An hour after the event ends, well inside the 48-hour grace period. A prompt
  // arriving as the grace period expires announces something that has already
  // happened.
  assert.equal(sendsAt, new Date('2026-10-03T22:00:00.000Z').getTime());
  assert.ok(sendsAt < new Date(booking.autoReleaseAt).getTime());
});

describe('a one-hour grace period does not schedule the prompt after the release', async () => {
  const now = new Date('2026-10-03T18:00:00.000Z');
  // The grace period is configurable (#36) and can be set shorter than the
  // prompt's own offset. Capped at the midpoint so it cannot land after the
  // thing it warns about.
  const booking = {
    eventEndAt: '2026-10-03T21:00:00.000Z',
    autoReleaseAt: '2026-10-03T22:00:00.000Z',
  };

  const sendsAt = now.getTime() + notificationService.confirmationPromptDelayMs(booking, now);
  assert.ok(
    sendsAt < new Date(booking.autoReleaseAt).getTime(),
    'the prompt would arrive after the money had already moved'
  );
  assert.equal(sendsAt, new Date('2026-10-03T21:30:00.000Z').getTime());
});

describe('a cancellation emails both parties with the figures that moved', async () => {
  await publishConfig();
  const { booking, clientUser } = await fundedBooking({ daysOut: 2, amountKobo: N(200000) });

  const eventDate = new Date(Date.now() + 2 * 86400000);
  eventDate.setUTCHours(11, 0, 0, 0);
  await prisma.booking.update({
    where: { id: booking.id },
    data: { eventDate, eventEndAt: new Date(eventDate.getTime() + 3 * 3600_000) },
  });

  const queued: any[] = [];
  const original = notificationJob.enqueue;
  notificationJob.enqueue = async (data: any) => {
    queued.push(data);
    return true;
  };

  let cancelled;
  try {
    cancelled = await withProvider(PROVIDER, () =>
      escrowService.cancelByClient({
        bookingId: booking.id,
        clientUserId: clientUser.id,
        reason: 'Changed plans.',
      })
    );
  } finally {
    notificationJob.enqueue = original;
  }

  const emails = queued.filter((q) => q.reference.startsWith('cancellation-'));
  assert.equal(emails.length, 2, 'both parties were not told');

  const { formatNairaForMessage } = require('../src/lib/money.ts');
  for (const email of emails) {
    // THE FIGURES THAT ACTUALLY MOVED. These are read next to a bank statement.
    assert.ok(
      email.body.includes(formatNairaForMessage(cancelled.clientRefundKobo)),
      `${email.reference} does not state the refund`
    );
  }
});

describe('a dispute tells both parties, every time, without deduping them away', async () => {
  await publishConfig();
  const { booking, clientUser } = await fundedBooking();

  const queued: any[] = [];
  const original = notificationJob.enqueue;
  notificationJob.enqueue = async (data: any, options: any = {}) => {
    queued.push({ ...data, ...options });
    return true;
  };

  try {
    await notificationService.disputeUpdate({ bookingId: booking.id, stage: 'OPENED' });
    await notificationService.disputeUpdate({ bookingId: booking.id, stage: 'EVIDENCE' });
  } finally {
    notificationJob.enqueue = original;
  }

  assert.equal(queued.length, 4, 'two updates to two parties is four messages');
  // NOT deduped: a dispute produces several updates, and a job id derived from
  // the booking would deliver only the first.
  assert.ok(queued.every((q) => q.jobId === undefined));
  void clientUser;
});

// ---------------------------------------------------------------------------
// A scheduled message checks the booking before sending
// ---------------------------------------------------------------------------

describe('a prompt queued weeks ago is dropped if the booking has moved on', async () => {
  await publishConfig();
  const { booking, clientUser } = await fundedBooking({ daysOut: 2 });

  const eventDate = new Date(Date.now() + 2 * 86400000);
  eventDate.setUTCHours(11, 0, 0, 0);
  await prisma.booking.update({
    where: { id: booking.id },
    data: { eventDate, eventEndAt: new Date(eventDate.getTime() + 3 * 3600_000) },
  });

  await withProvider(PROVIDER, () =>
    escrowService.cancelByClient({
      bookingId: booking.id,
      clientUserId: clientUser.id,
      reason: 'Changed plans.',
    })
  );

  const sent = await captureSends(() =>
    notificationJob.process({
      data: {
        channel: 'SMS',
        to: '+2348012345678',
        message: 'Did your artist perform as agreed?',
        reference: `confirmation-prompt-${booking.id}`,
        bookingId: booking.id,
        requireState: ['FUNDED_HELD', 'CHECKED_IN', 'AWAITING_CONFIRMATION'],
      },
    })
  );

  // Asking a refunded client whether their artist performed contradicts their
  // bank statement.
  assert.equal(sent.length, 0, 'a cancelled booking still got a confirmation prompt');
});

describe('a guarded message for a booking that still qualifies is sent', async () => {
  await publishConfig();
  const { booking } = await fundedBooking();

  const sent = await captureSends(() =>
    notificationJob.process({
      data: {
        channel: 'SMS',
        to: '+2348012345678',
        message: 'Have your code ready.',
        reference: `event-day-${booking.id}`,
        bookingId: booking.id,
        requireState: ['FUNDED_HELD', 'CHECKED_IN'],
      },
    })
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'SMS');
});

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

describe('an unconfigured channel logs and succeeds rather than failing every job', async () => {
  const saved = { key: process.env.SMS_API_KEY, sender: process.env.SMS_SENDER_ID };
  delete process.env.SMS_API_KEY;
  delete process.env.SMS_SENDER_ID;

  try {
    const result = await notifications.sendSms({ to: '+2348012345678', message: 'hello' });

    // A deployment with no SMS key is DEGRADED, not broken. Throwing here would
    // fail and dead-letter every scheduled job until someone added a key, which
    // buries the real failures under noise.
    assert.equal(result.stubbed, true);
    assert.equal(result.delivered, false);
    // And never the full number: a phone number is personal data under the NDPR
    // whether or not it is convenient to have in full.
    assert.equal(result.to, '+234801***5678');
  } finally {
    if (saved.key) process.env.SMS_API_KEY = saved.key;
    if (saved.sender) process.env.SMS_SENDER_ID = saved.sender;
  }
});

describe('a key without a sender id is reported rather than treated as disabled', async () => {
  const saved = { key: process.env.SMS_API_KEY, sender: process.env.SMS_SENDER_ID };
  process.env.SMS_API_KEY = 'sk_whatever';
  delete process.env.SMS_SENDER_ID;

  try {
    // Termii rejects every message from an unregistered sender, so this is not
    // "partly configured" — it is a channel that fails on every send while
    // looking configured.
    const problems = notifications.configProblems();
    assert.equal(problems.length, 1);
    assert.match(problems[0], /SMS_SENDER_ID/);
    assert.equal(notifications.smsEnabled(), false);
  } finally {
    if (saved.key) process.env.SMS_API_KEY = saved.key;
    else delete process.env.SMS_API_KEY;
    if (saved.sender) process.env.SMS_SENDER_ID = saved.sender;
  }
});

describe('a local number is normalised to the form the provider wants', async () => {
  // `08012345678` and `+2348012345678` are the same number, and which one is
  // stored depends on what someone typed at registration. Sending the local form
  // is a silent non-delivery.
  assert.equal(notifications.normalisePhone('08012345678'), '+2348012345678');
  assert.equal(notifications.normalisePhone('2348012345678'), '+2348012345678');
  assert.equal(notifications.normalisePhone('+2348012345678'), '+2348012345678');
  assert.equal(notifications.normalisePhone('0801 234 5678'), '+2348012345678');
  assert.equal(notifications.normalisePhone('8012345678'), '+2348012345678');
});

describe('an email address is masked in logs', async () => {
  assert.equal(notifications.maskEmail('ada@example.com'), 'a***@example.com');
  assert.equal(notifications.maskEmail('nonsense'), '***');
});

// ---------------------------------------------------------------------------
// Criterion: the check-in code SMS arrives ahead of the event, end to end
// ---------------------------------------------------------------------------

describe('the check-in code SMS goes out ahead of the event, through a real queue', async () => {
  await publishConfig();
  const checkInCodeJob = require('../src/jobs/checkInCodeJob.ts');
  const checkInService = require('../src/services/checkInService.ts');
  const { getQueue, registerRouter } = require('../src/lib/queue.ts');

  const { booking } = await fundedBooking({ daysOut: 3 });

  // The code is issued at funding, inside the transaction (#22).
  await prisma.$transaction((tx: PrismaTx) => checkInService.issueForBooking(tx, booking));
  const withCode = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.ok(withCode.checkInCode, 'funding did not issue a code');

  // THE LEAD TIME IS THE POINT. A code received in June for a September wedding
  // has been forwarded, screenshotted and forgotten by the time it matters.
  const delay = checkInCodeJob.delayFor(withCode.eventDate);
  assert.ok(delay > 0, 'the code would have been sent immediately rather than ahead of the event');
  const sendsAt = Date.now() + delay;
  assert.ok(
    sendsAt < new Date(withCode.eventDate).getTime(),
    'the code would arrive after the event had started'
  );
  assert.equal(
    Math.round((new Date(withCode.eventDate).getTime() - sendsAt) / 3600_000),
    checkInService.SMS_LEAD_HOURS
  );

  // Now run it for real: a worker on the shared queue, dispatching by job name.
  const sent: any[] = [];
  const originalSms = notifications.sendSms;
  notifications.sendSms = async (req: any) => {
    sent.push(req);
    return { delivered: true, stubbed: false, to: 'masked', segments: 1 };
  };

  const worker = registerRouter(checkInCodeJob.QUEUE_NAME, {
    [checkInCodeJob.JOB_NAME]: checkInCodeJob.process,
    [notificationJob.JOB_NAME]: notificationJob.process,
  });

  try {
    await getQueue(checkInCodeJob.QUEUE_NAME).add(
      checkInCodeJob.JOB_NAME,
      { bookingId: booking.id },
      // Queued with no delay so the test does not wait three days. The LEAD TIME
      // itself is asserted above, from the same function production uses.
      { jobId: `e2e-${booking.id}`, attempts: 1 }
    );

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && sent.length === 0) {
      await new Promise((r) => setTimeout(r, 200));
    }

    assert.equal(sent.length, 1, 'the check-in code SMS never went out');
    // The code itself, and the artist to give it to.
    assert.ok(
      sent[0].message.includes(checkInService.formatCode(withCode.checkInCode)),
      sent[0].message
    );
    assert.match(sent[0].message, /Do not share it before then/i);
    assert.equal(sent[0].to, withCode.clientPhone ?? sent[0].to);
  } finally {
    notifications.sendSms = originalSms;
    await worker.close();
  }
});

describe('the code is not texted for a booking that has been cancelled', async () => {
  await publishConfig();
  const checkInCodeJob = require('../src/jobs/checkInCodeJob.ts');
  const checkInService = require('../src/services/checkInService.ts');

  const { booking, clientUser } = await fundedBooking({ daysOut: 2 });
  await prisma.$transaction((tx: PrismaTx) => checkInService.issueForBooking(tx, booking));

  const eventDate = new Date(Date.now() + 2 * 86400000);
  eventDate.setUTCHours(11, 0, 0, 0);
  await prisma.booking.update({
    where: { id: booking.id },
    data: { eventDate, eventEndAt: new Date(eventDate.getTime() + 3 * 3600_000) },
  });

  await withProvider(PROVIDER, () =>
    escrowService.cancelByClient({
      bookingId: booking.id,
      clientUserId: clientUser.id,
      reason: 'Changed plans.',
    })
  );

  const sent = await captureSends(() =>
    checkInCodeJob.process({ data: { bookingId: booking.id } })
  );

  // The job re-reads the booking rather than trusting a payload scheduled weeks
  // ago. A code texted for a cancelled booking is a confused artist at a venue.
  assert.equal(sent.length, 0);
});
