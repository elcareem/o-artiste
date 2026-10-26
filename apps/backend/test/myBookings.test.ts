/**
 * A person's own bookings — issue #45.
 */

process.env.QUEUE_PREFIX = `test-mybookings-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('mybookings');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const bookingService = require('../src/services/bookingService.ts');
const { nextActionFor, groupFor } = require('../src/services/myBookingsService.ts');

const describe = hasDatabase ? test : test.skip;
const PASSWORD = 'correct horse battery staple';

let server: TestServer;
test.before(async () => {
  if (ready) await ready;
  server = await startServer(createApp());
});
test.after(async () => {
  if (server) await server.close();
  await require('../src/lib/queue.ts').closeAll().catch(() => {});
});

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;
const N = (naira: number) => naira * 100;

async function user(role: UserRole) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  const u = await prisma.user.create({
    data: {
      email: `mb${n}@example.test`,
      phone: `+23485${String(n).slice(-8).padStart(8, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
    },
  });
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: u.email, password: PASSWORD }),
  });
  return { ...u, token: ((await res.json()) as any).token as string };
}

async function config() {
  const admin = await user('SUPER_ADMIN');
  await prisma.commissionRate.create({ data: { rateBasisPoints: 500, effectiveFrom: new Date(), setByUserId: admin.id } });
  const versionId = `v_${uniq()}`;
  await prisma.cancellationTier.createMany({
    data: [
      { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
      { minDaysBefore: 0, maxDaysBefore: 6, clientRefundBps: 5000, artistCompensationBps: 5000 },
    ].map((t) => ({ ...t, versionId, effectiveFrom: new Date(), setByUserId: admin.id })),
  });
}

async function party(role: 'CLIENT' | 'ARTIST', name: string) {
  const u = await user(role);
  const profile =
    role === 'CLIENT'
      ? await prisma.client.create({ data: { userId: u.id, displayName: name } })
      : await prisma.artist.create({
          data: { userId: u.id, stageName: name, category: 'DJ', location: 'Lagos', baseRateKobo: N(200000), profileComplete: true },
        });
  return { ...u, profileId: profile.id };
}

const book = (client: any, artist: any, daysOut = 10) =>
  bookingService.createBooking({
    clientUserId: client.id,
    artistId: artist.profileId,
    amountKobo: N(200000),
    eventDate: new Date(Date.now() + daysOut * 86400000),
  });

const mine = async (token: string) => {
  const res = await fetch(`${server.url}/me/bookings`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as any };
};

describe('each person sees only their own bookings — with a stranger’s booking present', async () => {
  await config();
  const ada = await party('CLIENT', 'Ada');
  const tobi = await party('CLIENT', 'Tobi');
  const burna = await party('ARTIST', 'Burna');
  const wiz = await party('ARTIST', 'Wiz');

  const adaWithBurna = await book(ada, burna);
  const tobiWithWiz = await book(tobi, wiz); // the third party's booking
  const tobiWithBurna = await book(tobi, burna);

  const forAda = (await mine(ada.token)).body.bookings.map((b: any) => b.id);
  assert.deepEqual(forAda, [adaWithBurna.id], 'a client saw a booking that is not theirs');

  const forBurna = (await mine(burna.token)).body.bookings.map((b: any) => b.id).sort();
  assert.deepEqual(forBurna, [adaWithBurna.id, tobiWithBurna.id].sort(), 'an artist saw a booking that is not for them');

  const forWiz = (await mine(wiz.token)).body.bookings.map((b: any) => b.id);
  assert.deepEqual(forWiz, [tobiWithWiz.id]);
});

describe('the other party is named by the name they chose', async () => {
  await config();
  const ada = await party('CLIENT', 'Ada Obi');
  const burna = await party('ARTIST', 'Burna Boy');
  await book(ada, burna);

  assert.equal((await mine(ada.token)).body.bookings[0].counterparty.name, 'Burna Boy');
  assert.equal((await mine(burna.token)).body.bookings[0].counterparty.name, 'Ada Obi');
  // And nothing private about them comes along.
  assert.doesNotMatch(JSON.stringify((await mine(burna.token)).body), /@example\.test|\+2348|passwordHash/);
});

describe('the action needed comes from the backend, and moves as the booking does', async () => {
  await config();
  const ada = await party('CLIENT', 'Ada');
  const burna = await party('ARTIST', 'Burna');
  const b = await book(ada, burna);

  let row = (await mine(ada.token)).body.bookings[0];
  assert.equal(row.action.code, 'ACCEPT_TERMS');
  assert.equal(row.group, 'attention');

  await prisma.termsAcknowledgement.create({
    data: {
      bookingId: b.id,
      clientUserId: ada.id,
      tiersAsDisplayed: b.cancellationTiersSnapshot,
      commissionRateBpsAsDisplayed: 500,
    },
  });
  row = (await mine(ada.token)).body.bookings[0];
  assert.equal(row.action.code, 'PAY');

  // The artist has nothing to do on an unpaid booking.
  const artistRow = (await mine(burna.token)).body.bookings[0];
  assert.equal(artistRow.action, null);
  assert.equal(artistRow.group, 'upcoming');
});

describe('admins and anonymous callers are refused', async () => {
  const admin = await user('ADMIN');
  assert.equal((await mine(admin.token)).status, 403);
  assert.equal((await fetch(`${server.url}/me/bookings`)).status, 401);
});

// ---------------------------------------------------------------------------
// The rules, without a database
// ---------------------------------------------------------------------------

const now = new Date('2026-10-10T12:00:00Z');
const hours = (h: number) => new Date(now.getTime() + h * 3600_000);
const base = {
  eventDate: hours(-5),
  eventEndAt: hours(-2),
  checkInCodeValidFrom: hours(-7),
  checkInCodeValidTo: hours(10),
  autoReleaseAt: hours(46),
  acknowledged: true,
};

test('a client is asked to confirm after the event, with the deadline', () => {
  const a = nextActionFor({ ...base, state: 'AWAITING_CONFIRMATION' }, 'CLIENT', now);
  assert.equal(a.code, 'CONFIRM');
  assert.equal(a.deadline, hours(46).toISOString());
});

test('a client is NOT asked to confirm before the event ends', () => {
  assert.equal(nextActionFor({ ...base, eventEndAt: hours(2), state: 'FUNDED_HELD' }, 'CLIENT', now), null);
});

test('a client who has confirmed is not asked again', () => {
  assert.equal(nextActionFor({ ...base, state: 'AWAITING_CONFIRMATION', clientConfirmedAt: hours(-1) }, 'CLIENT', now), null);
});

test('an artist is asked to check in only inside the window', () => {
  const inside = { ...base, eventDate: hours(1), eventEndAt: hours(4), checkInCodeValidFrom: hours(-1), state: 'FUNDED_HELD' };
  assert.equal(nextActionFor(inside, 'ARTIST', now).code, 'CHECK_IN');
  assert.equal(nextActionFor({ ...inside, checkInCodeValidFrom: hours(1) }, 'ARTIST', now), null, 'too early');
  assert.equal(nextActionFor({ ...inside, checkInCodeValidTo: hours(-1) }, 'ARTIST', now), null, 'too late');
});

test('both parties are pointed at an open dispute', () => {
  assert.equal(nextActionFor({ ...base, state: 'DISPUTED' }, 'CLIENT', now).code, 'DISPUTE_OPEN');
  assert.equal(nextActionFor({ ...base, state: 'DISPUTED' }, 'ARTIST', now).code, 'DISPUTE_OPEN');
});

test('a settled booking asks nothing of anyone and sits in the past', () => {
  for (const state of ['RELEASED', 'REFUNDED', 'CANCELLED', 'RESOLVED']) {
    for (const role of ['CLIENT', 'ARTIST']) {
      const a = nextActionFor({ ...base, state }, role, now);
      assert.equal(a, null, `${state} as ${role}`);
      assert.equal(groupFor({ ...base, state }, a, now), 'past');
    }
  }
});

test('after the event, an artist who never checked in is told to check in — while the window is open', () => {
  // The window stays open 12 hours AFTER the event on purpose (#22): a
  // forgotten check-in must not become a payment dispute. So the prompt is
  // "check in", not "confirm" — confirming an event with no check-in on record
  // is not something the artist can do.
  const forgot = nextActionFor({ ...base, state: 'FUNDED_HELD' }, 'ARTIST', now);
  assert.equal(forgot.code, 'CHECK_IN');

  // Once the window has closed there is nothing the artist can do; a missing
  // check-in is now the client's no-show to raise.
  assert.equal(nextActionFor({ ...base, state: 'FUNDED_HELD', checkInCodeValidTo: hours(-1) }, 'ARTIST', now), null);
});
