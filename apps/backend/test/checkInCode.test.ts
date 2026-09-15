/**
 * Check-in code generation — issue #22.
 *
 * The code is the only evidence that the two parties were physically together,
 * and its value rests entirely on the artist being unable to obtain it any way
 * except from the client's hand. The tests here attack that property directly:
 * the endpoint sweep below hits EVERY registered booking route with an artist
 * token and fails if the code appears in any byte of any response.
 */

// Isolate this file's jobs the way db.ts isolates its schema. The funding path
// enqueues a real delivery job, so without this one suite's workers would
// consume another's.
process.env.QUEUE_PREFIX = `test-checkin-${process.pid}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('checkincode');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const checkInService = require('../src/services/checkInService.ts');
const checkInCodeJob = require('../src/jobs/checkInCodeJob.ts');
const notifications = require('../src/lib/notifications.ts');
const bookingService = require('../src/services/bookingService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const queueLib = require('../src/lib/queue.ts');

const describe = hasDatabase ? test : test.skip;

const SECRET = 'whsec_test_0123456789abcdef';
process.env.ESCROWPAY_WEBHOOK_SECRET = SECRET;

const PASSWORD = 'correct horse battery staple';

let server: TestServer;

test.before(async () => {
  if (ready) await ready;
  server = await startServer(createApp());
});

test.after(async () => {
  if (server) await server.close();
  // The funding path opens a real queue connection. Without closing it the
  // test process never exits.
  await queueLib.closeAll();
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
      email: `cic${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

/** A booking in PENDING_PAYMENT with an escrow id, ready to be funded. */
async function fundableBooking({ amountKobo = N(200000), eventInDays = 30 } = {}) {
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
      baseRateKobo: amountKobo,
      profileComplete: true,
    },
  });

  const created = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo,
    eventDate: new Date(Date.now() + eventInDays * 86400000),
  });

  const booking = await prisma.booking.update({
    where: { id: created.id },
    data: { escrowId: `TXN_${uniq()}` },
  });

  return { booking, clientUser, artistUser, artist };
}

/** Builds a signed delivery exactly as the provider does. */
function delivery(type: string, objectId: string) {
  const eventId = `WHEV_${uniq()}`;
  const payload = {
    id: eventId,
    type,
    api_version: '2026-07-24',
    created_at: new Date().toISOString(),
    object: 'transaction',
    object_id: objectId,
    data: {},
  };
  const raw = Buffer.from(JSON.stringify(payload, null, 1), 'utf8');
  const ts = Math.floor(Date.now() / 1000);
  const v1 = crypto
    .createHmac('sha256', SECRET)
    .update(Buffer.concat([Buffer.from(`${ts}.`), raw]))
    .digest('hex');

  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'escrowpay-signature': `t=${ts},v1=${v1}`,
      'escrowpay-event-id': eventId,
      'escrowpay-delivery-id': `WHDL_${uniq()}`,
    },
  };
}

async function deliverFunded(booking: BookingRow) {
  const d = delivery('transaction.funded', booking.escrowId as string);
  const res = await fetch(`${server.url}/webhooks/escrowpay`, {
    method: 'POST',
    headers: d.headers,
    body: d.raw,
  });
  return { status: res.status, body: (await res.json()) as any };
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

/** The provider reporting the full amount received. */
const funded = (booking: BookingRow) => ({
  getEscrow: async () => ({ id: booking.escrowId, funded_minor: booking.amountKobo }),
});

async function login(email: string) {
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return ((await res.json()) as any).token as string;
}

/** Captures everything written to stdout by the console for the duration. */
async function captureLog(fn: () => any): Promise<{ lines: string[]; result: any }> {
  const lines: string[] = [];
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
  }
  try {
    const result = await fn();
    return { lines, result };
  } finally {
    Object.assign(console, originals);
  }
}

// ---------------------------------------------------------------------------
// Criterion: codes are not predictable from a previously issued code
// ---------------------------------------------------------------------------

test('a code is drawn from an unambiguous alphabet at a length that can be read aloud', () => {
  const code = checkInService.generateCode();

  assert.equal(code.length, 8);
  assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);

  // The characters people mishear or mistype at a loud venue. A code that is
  // secure but mis-transcribed produces an artist who cannot check in.
  assert.doesNotMatch(checkInService.ALPHABET, /[01IOLU]/);
});

test('ten thousand codes collide with nobody and cover the whole alphabet', () => {
  const seen = new Set<string>();
  const charCounts = new Map<string, number>();

  for (let i = 0; i < 10_000; i++) {
    const code = checkInService.generateCode();
    seen.add(code);
    for (const ch of code) charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
  }

  assert.equal(seen.size, 10_000, 'a repeat in 10,000 draws from 6.6e11 means the source is not random');

  // Every character must appear. A generator that silently lost part of its
  // alphabet — an off-by-one on the modulo, say — would still look random.
  assert.equal(charCounts.size, checkInService.ALPHABET.length);

  // And roughly evenly. 80,000 characters over 30 symbols is ~2,667 each;
  // `randomBytes()[i] % 30` would push the first sixteen to ~3,137 and the rest
  // to ~2,500, which this bound catches while tolerating ordinary variance.
  for (const [ch, count] of charCounts) {
    assert.ok(
      count > 2_300 && count < 3_050,
      `'${ch}' appeared ${count} times in 80,000 — the draw is biased`
    );
  }
});

test('consecutive codes share no structure a previous holder could exploit', () => {
  const codes = Array.from({ length: 500 }, () => checkInService.generateCode());

  // Position by position, a successor character must not be predictable from
  // its predecessor. A counter, an LCG, or anything derived from time would
  // show up as one pair repeating far above chance (1/30 ≈ 3.3%).
  for (let position = 0; position < 8; position++) {
    const transitions = new Map<string, number>();
    for (let i = 1; i < codes.length; i++) {
      const key = `${codes[i - 1][position]}→${codes[i][position]}`;
      transitions.set(key, (transitions.get(key) ?? 0) + 1);
    }
    const worst = Math.max(...transitions.values());
    assert.ok(worst < 15, `position ${position}: one transition repeated ${worst}/499 times`);
  }
});

describe('a booking id tells you nothing about its code', async () => {
  const { booking } = await fundableBooking();
  const { booking: other } = await fundableBooking();

  const issued = await prisma.$transaction((tx: PrismaTx) =>
    checkInService.issueForBooking(tx, booking)
  );
  const issuedOther = await prisma.$transaction((tx: PrismaTx) =>
    checkInService.issueForBooking(tx, other)
  );

  assert.notEqual(issued.code, issuedOther.code);

  // The requirement is "not derived from the booking ID". A derivation would
  // leave the code's characters inside the id, or the reverse.
  const idChars = new Set(booking.id.toUpperCase());
  const shared = [...issued.code].filter((ch) => idChars.has(ch)).length;
  assert.ok(shared < 8, 'every character of the code appears in the booking id');
});

// ---------------------------------------------------------------------------
// Criterion: an artist token never receives the code from any booking endpoint
// ---------------------------------------------------------------------------

describe('no booking endpoint returns the code to an artist token', async () => {
  const { booking, artistUser, clientUser } = await fundableBooking();

  await withProvider(funded(booking), () => deliverFunded(booking));

  const stored = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.ok(stored.checkInCode, 'funding should have issued a code');

  const artistToken = await login(artistUser.email);

  // Every route the booking router registers, not a hand-picked list. A route
  // added later without thinking about the code is caught here rather than in
  // production.
  const { router } = require('../src/routes/bookings.ts');
  const paths: { method: string; path: string }[] = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      paths.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }

  assert.ok(paths.length >= 6, `expected the booking router to have routes, found ${paths.length}`);

  const bare = stored.checkInCode as string;
  const hyphenated = checkInService.formatCode(bare) as string;

  for (const { method, path } of paths) {
    const url = `${server.url}${path.replace(':id', booking.id)}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${artistToken}`,
        'Content-Type': 'application/json',
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify({}) }),
    });

    const text = await res.text();

    assert.ok(
      !text.includes(bare),
      `${method} ${path} returned the bare check-in code to an artist (${res.status})`
    );
    assert.ok(
      !text.includes(hyphenated),
      `${method} ${path} returned the hyphenated check-in code to an artist (${res.status})`
    );
    assert.ok(
      !text.includes('checkInCode'),
      `${method} ${path} exposed the field name to an artist (${res.status})`
    );
  }

  // And the dedicated endpoint is closed to them by role, before ownership is
  // even consulted.
  const direct = await fetch(`${server.url}/bookings/${booking.id}/check-in-code`, {
    headers: { Authorization: `Bearer ${artistToken}` },
  });
  assert.equal(direct.status, 403);
  assert.ok(!(await direct.text()).includes(bare));

  // The client gets it.
  const clientToken = await login(clientUser.email);
  const mine = await fetch(`${server.url}/bookings/${booking.id}/check-in-code`, {
    headers: { Authorization: `Bearer ${clientToken}` },
  });
  assert.equal(mine.status, 200);
  const payload = (await mine.json()) as any;
  assert.equal(payload.checkIn.code, hyphenated);
  assert.match(payload.checkIn.qrDataUrl, /^data:image\/png;base64,/);
});

describe('another client cannot read a code, and is not told the booking exists', async () => {
  const { booking } = await fundableBooking();
  await withProvider(funded(booking), () => deliverFunded(booking));

  const strangerUser = await makeUser('CLIENT');
  await prisma.client.create({ data: { userId: strangerUser.id, displayName: 'Stranger' } });
  const token = await login(strangerUser.email);

  const res = await fetch(`${server.url}/bookings/${booking.id}/check-in-code`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // 404, not 403: a 403 confirms the booking exists.
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as any).error, /not found/i);
});

// ---------------------------------------------------------------------------
// Criterion: the code is delivered by SMS ahead of the event, seen in the log
// ---------------------------------------------------------------------------

test('delivery is scheduled ahead of the event, not at funding', () => {
  const eventDate = new Date('2026-12-25T20:00:00Z');
  const fundedAt = new Date('2026-10-01T09:00:00Z');

  const delay = checkInCodeJob.delayFor(eventDate, fundedAt);
  const sendAt = new Date(fundedAt.getTime() + delay);

  assert.ok(sendAt < eventDate, 'the SMS must go out before the event');
  assert.equal(
    (eventDate.getTime() - sendAt.getTime()) / 3600_000,
    checkInService.SMS_LEAD_HOURS,
    'the lead time is configurable and must be honoured exactly'
  );

  // Funded the morning of the event: send now rather than schedule into the past.
  const sameDay = checkInCodeJob.delayFor(eventDate, new Date('2026-12-25T08:00:00Z'));
  assert.equal(sameDay, 0);
});

describe('the job sends the code by SMS and says so in the log', async () => {
  const { booking, clientUser } = await fundableBooking();
  await withProvider(funded(booking), () => deliverFunded(booking));

  const stored = await prisma.booking.findUnique({ where: { id: booking.id } });
  const hyphenated = checkInService.formatCode(stored.checkInCode) as string;

  const { lines, result } = await captureLog(() =>
    checkInCodeJob.process({ data: { bookingId: booking.id }, attemptsMade: 0 } as any)
  );

  assert.equal(result.sent, true);

  const log = lines.join('\n');
  assert.match(log, /\[notifications\] SMS/);
  assert.match(log, new RegExp(`\\[check-in-code\\] booking ${booking.id}`));

  // The code reached the message.
  assert.ok(log.includes(hyphenated), 'the SMS body must carry the code');

  // The number did not reach the log in full. It is personal data under the
  // NDPR, and logs get shipped to third parties.
  assert.ok(!log.includes(clientUser.phone), 'the full phone number was logged');
  assert.match(log, /\*\*\*/);

  // One segment, so it costs one message.
  const body = checkInService.smsBodyFor({ code: stored.checkInCode, artistName: 'Burna' });
  assert.ok(body.length <= 160, `SMS body is ${body.length} characters, over one segment`);
  assert.equal(notifications.segmentsFor(body), 1);
});

describe('a cancelled booking does not get a code texted to anyone', async () => {
  const { booking } = await fundableBooking();
  await withProvider(funded(booking), () => deliverFunded(booking));

  await prisma.booking.update({ where: { id: booking.id }, data: { state: 'CANCELLED' } });

  const { result } = await captureLog(() =>
    checkInCodeJob.process({ data: { bookingId: booking.id }, attemptsMade: 0 } as any)
  );

  assert.equal(result.sent, false);
  assert.equal(result.reason, 'booking_not_active');
});

test('the job id is stable per booking and distinct between bookings', () => {
  assert.equal(checkInCodeJob.jobIdFor('bkg_123'), checkInCodeJob.jobIdFor('bkg_123'));
  assert.notEqual(checkInCodeJob.jobIdFor('bkg_123'), checkInCodeJob.jobIdFor('bkg_124'));

  // BullMQ rejects a custom job id containing a colon, and `schedule()`
  // swallows its own failures — so the obvious `check-in-code:<id>` spelling
  // failed on every booking while every other test still passed.
  assert.doesNotMatch(checkInCodeJob.jobIdFor('bkg_123'), /:/);
});

describe('the delivery job really lands on the queue, at the right delay', async () => {
  const { booking } = await fundableBooking({ eventInDays: 30 });

  const queue = queueLib.getQueue(checkInCodeJob.QUEUE_NAME);
  await queue.remove(checkInCodeJob.jobIdFor(booking.id));

  const scheduled = await checkInCodeJob.schedule(booking);
  assert.equal(scheduled, true, 'schedule() reported failure — read the log line it printed');

  const job = await queue.getJob(checkInCodeJob.jobIdFor(booking.id));
  assert.ok(job, 'no job on the queue: the enqueue failed silently');
  assert.equal(job.name, checkInCodeJob.JOB_NAME);
  assert.equal(job.data.bookingId, booking.id);

  // Ahead of the event by the configured lead time, not at funding.
  const sendAt = job.timestamp + (job.opts.delay ?? 0);
  const eventAt = new Date(booking.eventDate).getTime();
  assert.ok(sendAt < eventAt, 'the SMS would go out after the event');
  assert.ok(
    Math.abs(eventAt - sendAt - checkInService.SMS_LEAD_HOURS * 3600_000) < 5_000,
    'the configured lead time was not honoured'
  );

  // A webhook redelivery must not put a second message in the client's inbox.
  await checkInCodeJob.schedule(booking);
  const waiting = await queue.getJobs(['delayed', 'waiting']);
  const mine = waiting.filter((j: any) => j?.data?.bookingId === booking.id);
  assert.equal(mine.length, 1, `${mine.length} delivery jobs queued for one booking`);

  await queue.remove(checkInCodeJob.jobIdFor(booking.id));
});

// ---------------------------------------------------------------------------
// Criterion: a code outside its validity window is rejected
// ---------------------------------------------------------------------------

test('the window opens before the event and closes after it ends', () => {
  const eventDate = new Date('2026-12-25T20:00:00Z');
  const eventEndAt = new Date('2026-12-25T23:00:00Z');

  const { validFrom, validTo } = checkInService.windowFor({ eventDate, eventEndAt });

  assert.equal(
    (eventDate.getTime() - validFrom.getTime()) / 3600_000,
    checkInService.WINDOW_BEFORE_HOURS
  );
  assert.equal(
    (validTo.getTime() - eventEndAt.getTime()) / 3600_000,
    checkInService.WINDOW_AFTER_HOURS
  );
});

test('a code is rejected before its window, after it, and once it is used', () => {
  const validFrom = new Date('2026-12-25T18:00:00Z');
  const validTo = new Date('2026-12-26T11:00:00Z');
  const booking = { checkInCodeValidFrom: validFrom, checkInCodeValidTo: validTo, checkIn: null };

  const early = checkInService.validityOf(booking, new Date('2026-12-25T17:59:59Z'));
  assert.equal(early.valid, false);
  assert.equal(early.reason, 'too_early');

  const late = checkInService.validityOf(booking, new Date('2026-12-26T11:00:01Z'));
  assert.equal(late.valid, false);
  assert.equal(late.reason, 'expired');

  assert.equal(checkInService.validityOf(booking, validFrom).valid, true);
  assert.equal(checkInService.validityOf(booking, validTo).valid, true);
  assert.equal(checkInService.validityOf(booking, new Date('2026-12-26T02:00:00Z')).valid, true);

  // Single use. Redemption beats the window in both directions.
  const used = checkInService.validityOf(
    { ...booking, checkIn: { id: 'chk_1' } },
    new Date('2026-12-26T02:00:00Z')
  );
  assert.equal(used.valid, false);
  assert.equal(used.reason, 'already_redeemed');

  // Each rejection carries its own message. "Wrong code" and "already used"
  // send an artist at a venue to different next actions (docs/39).
  const messages = new Set([early.message, late.message, used.message]);
  assert.equal(messages.size, 3);
  for (const message of messages) {
    assert.ok(message && message.length > 0);
    assert.doesNotMatch(message, /null|undefined|escrow|webhook|state/i);
  }
});

describe('the client is told why a code is not active yet, rather than shown a dead code', async () => {
  const { booking, clientUser } = await fundableBooking({ eventInDays: 30 });
  await withProvider(funded(booking), () => deliverFunded(booking));

  const token = await login(clientUser.email);
  const res = await fetch(`${server.url}/bookings/${booking.id}/check-in-code`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const { checkIn } = (await res.json()) as any;

  // The event is 30 days away and the window opens hours before it.
  assert.equal(checkIn.valid, false);
  assert.equal(checkIn.reason, 'too_early');
  assert.match(checkIn.message, /becomes active/i);

  // The code is still shown — the client needs it in the portal; it is
  // redemption that is gated, not visibility.
  assert.match(checkIn.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

describe('funding issues the code in the same transaction as the state change', async () => {
  const { booking } = await fundableBooking();

  const before = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(before.checkInCode, null, 'no code before funding');

  await withProvider(funded(booking), () => deliverFunded(booking));

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'FUNDED_HELD');
  assert.ok(after.checkInCode, 'a funded booking without a code cannot be completed by anyone');
  assert.ok(after.checkInCodeValidFrom);
  assert.ok(after.checkInCodeValidTo);
});

describe('a funding retry keeps the code the client already has', async () => {
  const { booking } = await fundableBooking();
  await withProvider(funded(booking), () => deliverFunded(booking));

  const first = await prisma.booking.findUnique({ where: { id: booking.id } });

  // A fresh event id for the same escrow: a redelivery the idempotency key
  // cannot absorb, which is exactly the case that could overwrite a code.
  await withProvider(funded(booking), () => deliverFunded(booking));

  const second = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(second.checkInCode, first.checkInCode);
  assert.deepEqual(second.checkInCodeValidFrom, first.checkInCodeValidFrom);

  // And calling the issuer directly is idempotent too.
  const again = await prisma.$transaction((tx: PrismaTx) =>
    checkInService.issueForBooking(tx, second)
  );
  assert.equal(again.code, first.checkInCode);
  assert.equal(again.issued, false);
});

describe('a client asking before payment gets an explanation, not an empty code', async () => {
  const { booking, clientUser } = await fundableBooking();
  const token = await login(clientUser.email);

  const res = await fetch(`${server.url}/bookings/${booking.id}/check-in-code`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(res.status, 409);
  assert.match(((await res.json()) as any).error, /once your payment/i);
});

// ---------------------------------------------------------------------------
// The QR
// ---------------------------------------------------------------------------

test('the QR encodes the bare code, not a URL', async () => {
  const code = checkInService.generateCode();

  assert.equal(checkInService.qrPayloadFor(code), code);
  assert.equal(checkInService.qrPayloadFor(checkInService.formatCode(code)), code);

  // A URL would make the symbol actionable in any camera app and would leak the
  // code into browser history, referrer headers and scanner telemetry.
  assert.doesNotMatch(checkInService.qrPayloadFor(code), /https?:|\/|\?/);

  const dataUrl = await checkInService.qrDataUrlFor(code);
  assert.match(dataUrl, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
});

test('a code typed with spaces, lower case or the dash still normalises', () => {
  assert.equal(checkInService.normaliseCode('k7qx-m2f9'), 'K7QXM2F9');
  assert.equal(checkInService.normaliseCode(' K7QX M2F9 '), 'K7QXM2F9');
  assert.equal(checkInService.normaliseCode('K7QXM2F9'), 'K7QXM2F9');
  assert.equal(checkInService.normaliseCode(null), '');
});
