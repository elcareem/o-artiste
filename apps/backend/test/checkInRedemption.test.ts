/**
 * Artist check-in redemption — issue #23.
 *
 * This produces the attendance record that is the primary evidence in every
 * subsequent dispute, and its entire value rests on the timestamp being ours.
 * The tests here attack that: a body that tries to supply a time, a code
 * redeemed twice at once, and every rejection path an artist could hit while
 * standing at a venue.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('checkinredeem');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const checkInService = require('../src/services/checkInService.ts');
const bookingService = require('../src/services/bookingService.ts');

const describe = hasDatabase ? test : test.skip;

const PASSWORD = 'correct horse battery staple';

let server: TestServer;

test.before(async () => {
  if (ready) await ready;
  server = await startServer(createApp());
});

test.after(async () => {
  if (server) await server.close();
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
      email: `rdm${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

/**
 * A funded booking whose event is happening now, with a code issued — the state
 * an artist is in when they walk through the door.
 */
async function checkInReady({
  state = 'FUNDED_HELD',
  hoursFromNow = 0,
}: { state?: BookingState; hoursFromNow?: number } = {}) {
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

  // The booking must be created with a future event date — that is a rule of
  // #15 — and then moved, because an artist checks in DURING the event, not
  // before it.
  let booking = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo: N(200000),
    eventDate: new Date(Date.now() + 30 * 86400000),
  });

  const eventDate = new Date(Date.now() + hoursFromNow * 3600_000);
  const eventEndAt = new Date(eventDate.getTime() + 3 * 3600_000);

  booking = await prisma.booking.update({
    where: { id: booking.id },
    data: { state: 'FUNDED_HELD', escrowId: `TXN_${uniq()}`, eventDate, eventEndAt },
  });

  const issued = await prisma.$transaction((tx: PrismaTx) =>
    checkInService.issueForBooking(tx, booking)
  );

  if (state !== 'FUNDED_HELD') {
    booking = await prisma.booking.update({ where: { id: booking.id }, data: { state } });
  } else {
    booking = await prisma.booking.findUnique({ where: { id: booking.id } });
  }

  return { booking, artist, artistUser, clientUser, code: issued.code as string };
}

async function login(email: string) {
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return ((await res.json()) as any).token as string;
}

async function checkIn(bookingId: string, token: string, body: Record<string, unknown>) {
  const res = await fetch(`${server.url}/bookings/${bookingId}/check-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

// ---------------------------------------------------------------------------
// Criterion: a correct code produces a CheckIn with a server timestamp
// ---------------------------------------------------------------------------

describe('a correct code produces a CheckIn with a server timestamp', async () => {
  const { booking, artistUser, code } = await checkInReady();
  const token = await login(artistUser.email);

  const before = Date.now();
  const res = await checkIn(booking.id, token, { code });
  const after = Date.now();

  assert.equal(res.status, 201);

  const record = await prisma.checkIn.findUnique({ where: { bookingId: booking.id } });
  assert.ok(record, 'no CheckIn row was written');
  assert.equal(record.redeemedByUser, artistUser.id);

  // Ours, and recent. A second of slack each way for the round trip and any
  // drift between the application clock and PostgreSQL's.
  const stamped = new Date(record.redeemedAt).getTime();
  assert.ok(
    stamped >= before - 1000 && stamped <= after + 1000,
    `redeemedAt ${record.redeemedAt} is outside the request window`
  );

  // And the booking moved.
  const updated = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(updated.state, 'CHECKED_IN');
  assert.equal(res.body.booking.state, 'CHECKED_IN');

  // The response does not hand the code back.
  assert.ok(!JSON.stringify(res.body).includes(code));
});

describe('the hyphenated form, lower case and stray spaces all redeem', async () => {
  for (const shape of [
    (c: string) => checkInService.formatCode(c),
    (c: string) => c.toLowerCase(),
    (c: string) => ` ${checkInService.formatCode(c).toLowerCase()} `,
  ]) {
    const { booking, artistUser, code } = await checkInReady();
    const token = await login(artistUser.email);

    const res = await checkIn(booking.id, token, { code: shape(code) });
    assert.equal(res.status, 201, `"${shape(code)}" was refused`);
  }
});

// ---------------------------------------------------------------------------
// Criterion: the same code cannot be redeemed twice (409)
// ---------------------------------------------------------------------------

describe('the same code cannot be redeemed twice', async () => {
  const { booking, artistUser, code } = await checkInReady();
  const token = await login(artistUser.email);

  const first = await checkIn(booking.id, token, { code });
  assert.equal(first.status, 201);

  const second = await checkIn(booking.id, token, { code });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already been used/i);

  // Exactly one record, and the first one.
  const rows = await prisma.checkIn.findMany({ where: { bookingId: booking.id } });
  assert.equal(rows.length, 1);
});

describe('two simultaneous redemptions produce one CheckIn, not two', async () => {
  const { booking, artistUser, code } = await checkInReady();
  const token = await login(artistUser.email);

  // The artist's phone and tablet submitting at the same moment. Both pass the
  // "has this been redeemed?" read before either writes; only the unique
  // constraint on CheckIn.bookingId separates them.
  const results = await Promise.all([
    checkIn(booking.id, token, { code }),
    checkIn(booking.id, token, { code }),
    checkIn(booking.id, token, { code }),
  ]);

  const created = results.filter((r) => r.status === 201);
  const refused = results.filter((r) => r.status === 409);

  assert.equal(created.length, 1, `${created.length} of 3 concurrent redemptions succeeded`);
  assert.equal(refused.length, 2);
  for (const r of refused) assert.match(r.body.error, /already been used/i);

  const rows = await prisma.checkIn.findMany({ where: { bookingId: booking.id } });
  assert.equal(rows.length, 1);
});

// ---------------------------------------------------------------------------
// Criterion: geolocation denied, unavailable, or absent still checks in
// ---------------------------------------------------------------------------

describe('check-in succeeds with geolocation denied, unavailable or absent', async () => {
  // Every shape a browser's geolocation API produces when it cannot get a fix,
  // plus values a careless client might send.
  const shapes: [string, Record<string, unknown>][] = [
    ['absent', {}],
    ['explicit nulls (permission denied)', { latitude: null, longitude: null }],
    ['undefined (position unavailable)', { latitude: undefined, longitude: undefined }],
    ['empty strings', { latitude: '', longitude: '', accuracyMeters: '' }],
    ['NaN from a failed parse', { latitude: 'NaN', longitude: 'NaN' }],
    ['out of range', { latitude: 999, longitude: -999 }],
    ['half a reading', { latitude: 6.5244 }],
    ['nonsense types', { latitude: {}, longitude: [], accuracyMeters: true }],
  ];

  for (const [label, geo] of shapes) {
    const { booking, artistUser, code } = await checkInReady();
    const token = await login(artistUser.email);

    const res = await checkIn(booking.id, token, { code, ...geo });
    assert.equal(res.status, 201, `${label}: check-in was refused (${res.body.error})`);

    const record = await prisma.checkIn.findUnique({ where: { bookingId: booking.id } });
    assert.equal(record.latitude, null, `${label}: stored a latitude it should have dropped`);
    assert.equal(record.longitude, null, `${label}: stored a longitude it should have dropped`);
    assert.equal(res.body.checkIn.hasLocation, false);
  }
});

describe('a real reading is captured as supporting metadata', async () => {
  const { booking, artistUser, code } = await checkInReady();
  const token = await login(artistUser.email);

  // Lagos.
  const res = await checkIn(booking.id, token, {
    code,
    latitude: 6.5244,
    longitude: 3.3792,
    accuracyMeters: 42,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.checkIn.hasLocation, true);

  const record = await prisma.checkIn.findUnique({ where: { bookingId: booking.id } });
  assert.equal(record.latitude, '6.5244');
  assert.equal(record.longitude, '3.3792');
  assert.equal(record.accuracyMeters, '42');

  // Text, not a float — docs/01 §1. It is evidence, not arithmetic.
  assert.equal(typeof record.latitude, 'string');
});

// ---------------------------------------------------------------------------
// Criterion: a client-supplied timestamp is ignored, not trusted
// ---------------------------------------------------------------------------

describe('a timestamp in the request body cannot reach the record', async () => {
  const bodies = [
    { redeemedAt: '2020-01-01T00:00:00.000Z' },
    { redeemed_at: '2020-01-01T00:00:00.000Z' },
    { createdAt: '2020-01-01T00:00:00.000Z' },
    { timestamp: 1577836800000 },
    { checkedInAt: new Date(Date.now() + 90 * 86400000).toISOString() },
  ];

  for (const injected of bodies) {
    const { booking, artistUser, code } = await checkInReady();
    const token = await login(artistUser.email);

    const before = Date.now();
    const res = await checkIn(booking.id, token, { code, ...injected });
    assert.equal(res.status, 201, `${JSON.stringify(injected)} broke the check-in`);

    const record = await prisma.checkIn.findUnique({ where: { bookingId: booking.id } });
    const stamped = new Date(record.redeemedAt).getTime();

    assert.ok(
      stamped >= before - 1000,
      `${JSON.stringify(injected)} moved redeemedAt to ${record.redeemedAt}`
    );
    assert.ok(new Date(record.createdAt).getTime() >= before - 1000);
  }
});

test('the redemption signature has no parameter a time could arrive through', () => {
  // The body-level test above proves nothing reaches the record today. This
  // proves it cannot start to: a field would have to be ADDED to accept one,
  // rather than an ignore-this line being removed.
  const source = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../src/services/checkInService.ts'),
    'utf8'
  );
  const signature = source.slice(source.indexOf('async function redeem({'));
  const params = signature.slice(0, signature.indexOf('}:'));

  assert.doesNotMatch(params, /At\b|time|date|stamp/i, `redeem() accepts a time: ${params}`);

  // And nothing writes the column.
  assert.doesNotMatch(source, /redeemedAt\s*:/, 'something assigns redeemedAt');
});

// ---------------------------------------------------------------------------
// Rejections — each with its own message (docs/04 §2)
// ---------------------------------------------------------------------------

describe('an incorrect code is refused, and says so distinctly', async () => {
  const { booking, artistUser, code } = await checkInReady();
  const token = await login(artistUser.email);

  const wrong = code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA';
  const res = await checkIn(booking.id, token, { code: wrong });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /not right/i);
  assert.doesNotMatch(res.body.error, /already|expired|window/i);

  // A refusal writes nothing and moves nothing.
  assert.equal(await prisma.checkIn.count({ where: { bookingId: booking.id } }), 0);
  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'FUNDED_HELD');
});

test('code comparison is constant-time and length-tolerant', () => {
  assert.equal(checkInService.codesMatch('K7QXM2F9', 'K7QXM2F9'), true);
  assert.equal(checkInService.codesMatch('K7QXM2F9', 'k7qx-m2f9'), true);
  assert.equal(checkInService.codesMatch('K7QXM2F9', 'K7QXM2F8'), false);

  // A different length must not throw — timingSafeEqual does on mismatched
  // buffers, and an exception here would be a 500 instead of a 409.
  assert.equal(checkInService.codesMatch('K7QXM2F9', 'K7QX'), false);
  assert.equal(checkInService.codesMatch('K7QXM2F9', ''), false);
  assert.equal(checkInService.codesMatch('K7QXM2F9', null), false);
  assert.equal(checkInService.codesMatch('K7QXM2F9', 'K7QXM2F9EXTRA'), false);
});

describe('a code outside its window is refused, with the reason', async () => {
  // The event is three days out; the window opens hours before it.
  const early = await checkInReady({ hoursFromNow: 72 });
  const earlyToken = await login(early.artistUser.email);
  const tooEarly = await checkIn(early.booking.id, earlyToken, { code: early.code });

  assert.equal(tooEarly.status, 409);
  assert.match(tooEarly.body.error, /becomes active/i);

  // The event ended two days ago; the window closed twelve hours after it.
  const late = await checkInReady({ hoursFromNow: -48 });
  const lateToken = await login(late.artistUser.email);
  const expired = await checkIn(late.booking.id, lateToken, { code: late.code });

  assert.equal(expired.status, 409);
  assert.match(expired.body.error, /expired/i);

  // Different messages, and neither leaks a state name or a system word.
  assert.notEqual(tooEarly.body.error, expired.body.error);
  for (const message of [tooEarly.body.error, expired.body.error]) {
    assert.doesNotMatch(message, /[A-Z]{3,}_[A-Z]|escrow|webhook|null|undefined/);
  }
});

describe('a booking in an ineligible state is refused in words an artist can act on', async () => {
  const cases: [BookingState, RegExp][] = [
    ['PENDING_PAYMENT', /has not been paid for/i],
    ['CANCELLED', /cancelled/i],
    ['AWAITING_CONFIRMATION', /already moved on/i],
    ['DISPUTED', /dispute/i],
    ['RELEASED', /already been paid out/i],
  ];

  for (const [state, expected] of cases) {
    const { booking, artistUser, code } = await checkInReady({ state });
    const token = await login(artistUser.email);

    const res = await checkIn(booking.id, token, { code });

    assert.equal(res.status, 409, `${state} did not return 409`);
    assert.match(res.body.error, expected, `${state}: "${res.body.error}"`);

    // The raw state name never reaches the artist. PENDING_PAYMENT tells them
    // nothing they can do; "the client has not paid" tells them who to talk to.
    assert.doesNotMatch(res.body.error, /[A-Z]{3,}_[A-Z]/, `${state} leaked its enum name`);

    assert.equal(await prisma.checkIn.count({ where: { bookingId: booking.id } }), 0);
  }
});

describe('a booking with no code yet says so, rather than "wrong code"', async () => {
  const { booking, artistUser } = await checkInReady();
  await prisma.booking.update({
    where: { id: booking.id },
    data: { checkInCode: null, checkInCodeValidFrom: null, checkInCodeValidTo: null },
  });

  const token = await login(artistUser.email);
  const res = await checkIn(booking.id, token, { code: 'ABCD2345' });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /not been paid for/i);
});

describe('a missing code is a 400 naming what to do, not a 409', async () => {
  const { booking, artistUser } = await checkInReady();
  const token = await login(artistUser.email);

  const res = await checkIn(booking.id, token, {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /enter the check-in code/i);
});

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

describe('another artist cannot redeem, and is not told the booking exists', async () => {
  const { booking, code } = await checkInReady();
  const other = await makeUser('ARTIST');
  await prisma.artist.create({
    data: {
      userId: other.id,
      stageName: `Other ${uniq()}`,
      category: 'Afrobeats',
      location: 'Abuja',
      baseRateKobo: N(200000),
      profileComplete: true,
    },
  });

  const token = await login(other.email);
  const res = await checkIn(booking.id, token, { code });

  // 404, not 403: a 403 confirms the booking exists, and an artist enumerating
  // bookings is exactly the threat.
  assert.equal(res.status, 404);
  assert.match(res.body.error, /not found/i);
  assert.equal(await prisma.checkIn.count({ where: { bookingId: booking.id } }), 0);
});

describe('the client cannot redeem their own code', async () => {
  const { booking, clientUser, code } = await checkInReady();
  const token = await login(clientUser.email);

  const res = await checkIn(booking.id, token, { code });

  // The direction is the entire mechanism: a client who could redeem their own
  // code could manufacture attendance for an event nobody played.
  assert.equal(res.status, 403);
  assert.equal(await prisma.checkIn.count({ where: { bookingId: booking.id } }), 0);
});

describe('an unauthenticated request is refused', async () => {
  const { booking, code } = await checkInReady();

  const res = await fetch(`${server.url}/bookings/${booking.id}/check-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });

  assert.equal(res.status, 401);
});
