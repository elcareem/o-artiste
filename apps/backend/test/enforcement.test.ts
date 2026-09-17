/**
 * Strike consequences and enforcement — issue #34, docs/06 §5.
 *
 * THE ACCOUNT CONSEQUENCE IS THE DETERRENT, NOT THE FEE. A ₦2,070 liability is
 * a rounding error to a working artist; losing listing visibility is not.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('enforcement');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const bookingService = require('../src/services/bookingService.ts');
const strikeService = require('../src/services/strikeService.ts');
const enforcement = require('../src/services/enforcementService.ts');

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
      email: `enf${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

async function seedConfig() {
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
  return admin;
}

async function login(email: string) {
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return ((await res.json()) as any).token as string;
}

const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const inTx = (fn: (tx: PrismaTx) => any): Promise<any> => prisma.$transaction(fn);

/** Accrues strikes until the user reaches the given weight. */
async function strikeUntil(userId: string, party: 'ARTIST' | 'CLIENT', weight: number) {
  let total = 0;
  while (total < weight) {
    const strike = await inTx((tx: PrismaTx) =>
      strikeService.accrueForDispute(tx, { userId, falseNoShowClaim: false, bookingId: null })
    );
    total += strike.weight;
  }
  return total;
}

// ---------------------------------------------------------------------------
// The ladders
// ---------------------------------------------------------------------------

test('the harshest matching rung wins, so accruing strikes never makes an account safer', () => {
  const { DEFAULT_LADDERS, rungFor } = enforcement;

  // A client at weight 5 matches WARNED, RESTRICTED and SUSPENDED. Picking the
  // lowest would mean more misconduct produced a lighter consequence.
  assert.equal(rungFor(DEFAULT_LADDERS, 'CLIENT', 5).standing, 'SUSPENDED');
  assert.equal(rungFor(DEFAULT_LADDERS, 'CLIENT', 3).standing, 'RESTRICTED');
  assert.equal(rungFor(DEFAULT_LADDERS, 'CLIENT', 1).standing, 'WARNED');
  assert.equal(rungFor(DEFAULT_LADDERS, 'CLIENT', 0), null);

  // The artist ladder has no warning rung: a cancellation severe enough to
  // strike is severe enough to review.
  assert.equal(rungFor(DEFAULT_LADDERS, 'ARTIST', 1), null);
  assert.equal(rungFor(DEFAULT_LADDERS, 'ARTIST', 3).standing, 'SUSPENDED');
  assert.equal(rungFor(DEFAULT_LADDERS, 'ARTIST', 6).standing, 'REMOVED');

  // The ladders do not bleed into each other.
  assert.equal(rungFor(DEFAULT_LADDERS, 'ARTIST', 3).party, 'ARTIST');
  assert.equal(rungFor(DEFAULT_LADDERS, 'CLIENT', 3).party, 'CLIENT');
});

test('the artist thresholds and the strike weights were chosen together', () => {
  const { DEFAULT_LADDERS, rungFor } = enforcement;
  const dayOf = strikeService.DEFAULT_RULES.find(
    (r: StrikeRuleInput) => r.trigger === 'ARTIST_CANCEL_DAY_OF'
  );

  // docs/06 §2: a day-of cancellation is "strike + suspension pending review".
  // That only holds if one day-of strike reaches the suspension threshold.
  assert.equal(rungFor(DEFAULT_LADDERS, 'ARTIST', dayOf.weight).standing, 'SUSPENDED');

  // And one attempt to obtain a performance for free restricts a client.
  const fraud = strikeService.DEFAULT_RULES.find(
    (r: StrikeRuleInput) => r.trigger === 'DISPUTE_FALSE_NO_SHOW_CLAIM'
  );
  assert.equal(rungFor(DEFAULT_LADDERS, 'CLIENT', fraud.weight).standing, 'RESTRICTED');
});

describe('a strike escalates standing in the same transaction that records it', async () => {
  const artist = await makeUser('ARTIST');

  const before = await prisma.user.findUnique({ where: { id: artist.id } });
  assert.equal(before.accountStanding, 'GOOD');

  await inTx((tx: PrismaTx) =>
    strikeService.accrueForCancellation(tx, {
      userId: artist.id,
      by: 'ARTIST',
      daysBefore: 0,
      bookingId: null,
    })
  );

  // An account whose conduct changed and one whose standing changed must never
  // be two different facts.
  const after = await prisma.user.findUnique({ where: { id: artist.id } });
  assert.equal(after.accountStanding, 'SUSPENDED');

  const audit = await prisma.auditLog.findFirst({
    where: { action: 'ACCOUNT_STANDING_CHANGED', entityId: artist.id },
  });
  assert.ok(audit, 'a change of standing left no record');
  assert.equal((audit.after as any).accountStanding, 'SUSPENDED');
});

describe('standing only ever escalates through accrual, never relaxes', async () => {
  const client = await makeUser('CLIENT');
  await strikeUntil(client.id, 'CLIENT', 5);
  assert.equal((await prisma.user.findUnique({ where: { id: client.id } })).accountStanding, 'SUSPENDED');

  // An admin lifts it by hand.
  await prisma.user.update({ where: { id: client.id }, data: { accountStanding: 'GOOD' } });

  // A later, unrelated strike must not silently overturn that decision by
  // recomputing from weight alone — but it must still apply its own rung.
  await inTx((tx: PrismaTx) =>
    strikeService.accrueForDispute(tx, { userId: client.id, falseNoShowClaim: false, bookingId: null })
  );

  const after = await prisma.user.findUnique({ where: { id: client.id } });
  assert.equal(after.accountStanding, 'SUSPENDED', 'the accumulated weight still applies');
});

// ---------------------------------------------------------------------------
// Criterion: a restricted client cannot book inside their lead time
// ---------------------------------------------------------------------------

describe('a restricted client cannot book inside their enforced lead time', async () => {
  await seedConfig();

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

  await prisma.user.update({
    where: { id: clientUser.id },
    data: { accountStanding: 'RESTRICTED', restrictedMinLeadDays: 14 },
  });

  const book = (daysOut: number) =>
    bookingService.createBooking({
      clientUserId: clientUser.id,
      artistId: artist.id,
      amountKobo: N(200000),
      eventDate: new Date(Date.now() + daysOut * 86400000),
    });

  // Inside the window: refused, and the message says the number and what to do.
  await assert.rejects(
    () => book(3),
    (err: ThrownError) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /at least 14 days ahead/);
      assert.match(err.message, /3 days away/);
      assert.match(err.message, /contact support/i);
      // Not a bare 403, and no system vocabulary.
      assert.doesNotMatch(err.message, /RESTRICTED|accountStanding|null/);
      return true;
    }
  );

  await assert.rejects(() => book(13), /at least 14 days ahead/);

  // OUTSIDE IT THEY CAN STILL BOOK. The restriction addresses last-minute
  // cancellation without removing an otherwise usable customer — that middle
  // rung is the point of the client ladder.
  const ok = await book(30);
  assert.ok(ok.id);

  // And exactly at the boundary.
  const atEdge = await book(14);
  assert.ok(atEdge.id);
});

describe('a client in good standing is unaffected by the lead-time rule', async () => {
  await seedConfig();

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

  const booking = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo: N(200000),
    eventDate: new Date(Date.now() + 86400000),
  });
  assert.ok(booking.id);
});

// ---------------------------------------------------------------------------
// Criterion: a suspended artist disappears from listings
// ---------------------------------------------------------------------------

describe('a suspended artist disappears from the listing and 404s on detail', async () => {
  const artistUser = await makeUser('ARTIST');
  const artist = await prisma.artist.create({
    data: {
      userId: artistUser.id,
      stageName: `Findable ${uniq()}`,
      category: 'Afrobeats',
      location: 'Lagos',
      baseRateKobo: N(200000),
      profileComplete: true,
    },
  });

  const listed = await call('GET', '/artists?limit=50');
  assert.ok(
    listed.body.artists.some((a: any) => a.id === artist.id),
    'the fixture artist is not listed to begin with'
  );
  assert.equal((await call('GET', `/artists/${artist.id}`)).status, 200);

  // Suspended by conduct, not by hand — the whole path.
  await inTx((tx: PrismaTx) =>
    strikeService.accrueForCancellation(tx, {
      userId: artistUser.id,
      by: 'ARTIST',
      daysBefore: 0,
      bookingId: null,
    })
  );
  assert.equal(
    (await prisma.user.findUnique({ where: { id: artistUser.id } })).accountStanding,
    'SUSPENDED'
  );

  // ABSENT, not greyed out and not marked unavailable. A suspended artist
  // appearing in a listing even briefly is a trust failure (docs/02 §4).
  const after = await call('GET', '/artists?limit=50');
  assert.ok(
    !after.body.artists.some((a: any) => a.id === artist.id),
    'a suspended artist is still listed'
  );

  const detail = await call('GET', `/artists/${artist.id}`);
  assert.equal(detail.status, 404);
  assert.doesNotMatch(JSON.stringify(detail.body), /suspend/i, 'the 404 explains too much');
});

// ---------------------------------------------------------------------------
// Criterion: a suspended client gets a clear, non-technical message
// ---------------------------------------------------------------------------

describe('a suspended client is told plainly, not given a bare 403', async () => {
  await seedConfig();

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

  await prisma.user.update({
    where: { id: clientUser.id },
    data: { accountStanding: 'SUSPENDED' },
  });

  await assert.rejects(
    () =>
      bookingService.createBooking({
        clientUserId: clientUser.id,
        artistId: artist.id,
        amountKobo: N(200000),
        eventDate: new Date(Date.now() + 30 * 86400000),
      }),
    (err: ThrownError) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /suspended/i);
      // It says what to do about it, rather than ending the conversation.
      assert.match(err.message, /contact support/i);
      assert.doesNotMatch(err.message, /[A-Z]{3,}_[A-Z]|403|null|undefined/);
      return true;
    }
  );
});

test('every standing change is explained in one plain-language message', () => {
  const { standingMessage } = enforcement;

  for (const to of ['WARNED', 'RESTRICTED', 'SUSPENDED', 'REMOVED'] as AccountStanding[]) {
    const message = standingMessage({
      userId: 'u',
      from: 'GOOD',
      to,
      weight: 3,
      minLeadDays: 14,
    });

    // A consequence discovered by failing to book is a support ticket; one
    // someone was told about is a deterrent (docs/06 §5).
    assert.ok(message.length > 40, `${to}: too terse`);
    assert.match(message, /o-artiste/);
    assert.match(message, /HELP/, `${to} offers no way to reply`);
    assert.doesNotMatch(message, /[A-Z]{3,}_[A-Z]|strike weight|null/i, `${to} leaks internals`);
    assert.ok(message.length <= 160, `${to} costs more than one SMS segment (${message.length})`);
  }

  // The restricted message names the actual number they must book outside.
  assert.match(
    standingMessage({ userId: 'u', from: 'GOOD', to: 'RESTRICTED', weight: 3, minLeadDays: 21 }),
    /21 days ahead/
  );
});

// ---------------------------------------------------------------------------
// Criterion: an admin override records the actor and reason
// ---------------------------------------------------------------------------

describe('an override records the actor and reason, and undoes what the strike caused', async () => {
  const artistUser = await makeUser('ARTIST');
  const strike = await inTx((tx: PrismaTx) =>
    strikeService.accrueForCancellation(tx, {
      userId: artistUser.id,
      by: 'ARTIST',
      daysBefore: 0,
      bookingId: null,
    })
  );

  assert.equal(
    (await prisma.user.findUnique({ where: { id: artistUser.id } })).accountStanding,
    'SUSPENDED'
  );

  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const reason = 'The client confirmed by email that they cancelled, not the artist.';
  const res = await call('POST', `/admin/strikes/${strike.id}/review`, token, { reason });

  assert.equal(res.status, 200, res.body.error);
  assert.equal(res.body.review.standing, 'GOOD');
  assert.equal(res.body.review.remainingWeight, 0);

  // THE STRIKE IS DEACTIVATED, NOT DELETED. It happened, and the record of it
  // happening and being overturned is more useful than its absence.
  const overturned = await prisma.strike.findUnique({ where: { id: strike.id } });
  assert.equal(overturned.active, false);
  assert.equal(overturned.overriddenByUserId, admin.id);
  assert.equal(overturned.overrideReason, reason);
  assert.ok(overturned.overriddenAt);
  assert.equal(overturned.weight, strike.weight, 'the original weight was rewritten');

  // Removing a strike that should not have been issued undoes what it caused.
  const user = await prisma.user.findUnique({ where: { id: artistUser.id } });
  assert.equal(user.accountStanding, 'GOOD');

  const audit = await prisma.auditLog.findFirst({
    where: { action: 'STRIKE_OVERRIDDEN', entityId: strike.id },
  });
  assert.equal(audit.actorUserId, admin.id);
  assert.equal(audit.reason, reason);
});

describe('an override without a reason is refused, and changes nothing', async () => {
  const client = await makeUser('CLIENT');
  const strike = await inTx((tx: PrismaTx) =>
    strikeService.accrueForDispute(tx, { userId: client.id, falseNoShowClaim: true, bookingId: null })
  );

  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
    const res = await call('POST', `/admin/strikes/${strike.id}/review`, token, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} was accepted`);
    assert.match(res.body.error, /record why/i);
  }

  assert.equal((await prisma.strike.findUnique({ where: { id: strike.id } })).active, true);
});

describe('a partial override leaves the remaining weight in force', async () => {
  const client = await makeUser('CLIENT');

  // Two strikes: one heavy, one light. Overturning the light one should not
  // clear a restriction the heavy one justifies on its own.
  const heavy = await inTx((tx: PrismaTx) =>
    strikeService.accrueForDispute(tx, { userId: client.id, falseNoShowClaim: true, bookingId: null })
  );
  const light = await inTx((tx: PrismaTx) =>
    strikeService.accrueForDispute(tx, { userId: client.id, falseNoShowClaim: false, bookingId: null })
  );

  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const res = await call('POST', `/admin/strikes/${light.id}/review`, token, {
    reason: 'This one was recorded against the wrong booking.',
  });

  assert.equal(res.body.review.remainingWeight, heavy.weight);
  assert.equal(res.body.review.standing, 'RESTRICTED');

  const user = await prisma.user.findUnique({ where: { id: client.id } });
  assert.equal(user.accountStanding, 'RESTRICTED');
  assert.equal(user.restrictedMinLeadDays, 14, 'the lead time was not restored with the standing');
});

describe('overriding the same strike twice is refused', async () => {
  const client = await makeUser('CLIENT');
  const strike = await inTx((tx: PrismaTx) =>
    strikeService.accrueForDispute(tx, { userId: client.id, falseNoShowClaim: false, bookingId: null })
  );

  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);
  const body = { reason: 'Reviewed and overturned.' };

  assert.equal((await call('POST', `/admin/strikes/${strike.id}/review`, token, body)).status, 200);

  const second = await call('POST', `/admin/strikes/${strike.id}/review`, token, body);
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already been overridden/i);
});

describe('only an admin may override a strike', async () => {
  const client = await makeUser('CLIENT');
  const strike = await inTx((tx: PrismaTx) =>
    strikeService.accrueForDispute(tx, { userId: client.id, falseNoShowClaim: false, bookingId: null })
  );

  for (const role of ['CLIENT', 'ARTIST'] as UserRole[]) {
    const user = await makeUser(role);
    const token = await login(user.email);
    const res = await call('POST', `/admin/strikes/${strike.id}/review`, token, {
      reason: 'Overturning my own strike.',
    });
    assert.equal(res.status, 403, `${role} overrode a strike`);
  }
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('changing a threshold changes enforcement, with no deploy', async () => {
  const superAdmin = await makeUser('SUPER_ADMIN');
  const token = await login(superAdmin.email);
  const artistUser = await makeUser('ARTIST');

  // Weight 1 does nothing under the shipped artist ladder.
  await inTx((tx: PrismaTx) =>
    strikeService.accrueForDispute(tx, {
      userId: artistUser.id,
      falseNoShowClaim: false,
      bookingId: null,
    })
  );
  assert.equal(
    (await prisma.user.findUnique({ where: { id: artistUser.id } })).accountStanding,
    'GOOD'
  );

  // The platform decides one strike is enough to review an artist.
  const published = await call('PUT', '/admin/config/enforcement', token, {
    rules: [
      { party: 'ARTIST', minWeight: 1, standing: 'SUSPENDED' },
      { party: 'ARTIST', minWeight: 6, standing: 'REMOVED' },
      { party: 'CLIENT', minWeight: 1, standing: 'WARNED' },
      { party: 'CLIENT', minWeight: 3, standing: 'RESTRICTED', minLeadDays: 30 },
      { party: 'CLIENT', minWeight: 5, standing: 'SUSPENDED' },
    ],
  });
  assert.equal(published.status, 201);

  // The SAME running process, and the next strike applies the new rung.
  const other = await makeUser('ARTIST');
  await inTx((tx: PrismaTx) =>
    strikeService.accrueForDispute(tx, {
      userId: other.id,
      falseNoShowClaim: false,
      bookingId: null,
    })
  );
  assert.equal(
    (await prisma.user.findUnique({ where: { id: other.id } })).accountStanding,
    'SUSPENDED'
  );

  // And the new lead time comes with it.
  const client = await makeUser('CLIENT');
  await strikeUntil(client.id, 'CLIENT', 3);
  const restricted = await prisma.user.findUnique({ where: { id: client.id } });
  assert.equal(restricted.accountStanding, 'RESTRICTED');
  assert.equal(restricted.restrictedMinLeadDays, 30);
});

test('a ladder that cannot be applied is refused, naming the rung', () => {
  const { validateLadders } = enforcement;

  assert.throws(() => validateLadders([]), /at least one enforcement rung/i);

  assert.throws(
    () => validateLadders([{ party: 'NOBODY', minWeight: 1, standing: 'SUSPENDED' } as any]),
    /artist or a client/i
  );

  for (const minWeight of [0, -1, 1.5]) {
    assert.throws(
      () => validateLadders([{ party: 'CLIENT', minWeight, standing: 'WARNED' } as any]),
      /whole number of at least 1/
    );
  }

  // A rung to GOOD is not a consequence, and having one would let a published
  // ladder silently clear an existing suspension.
  assert.throws(
    () => validateLadders([{ party: 'CLIENT', minWeight: 1, standing: 'GOOD' }]),
    /cannot set standing back to good/i
  );

  // A restricted rung with no lead time restricts nothing.
  assert.throws(
    () => validateLadders([{ party: 'CLIENT', minWeight: 3, standing: 'RESTRICTED' }]),
    /how many days ahead/i
  );

  validateLadders(enforcement.DEFAULT_LADDERS);
});

describe('only a super-admin may change the ladders', async () => {
  const body = { rules: [{ party: 'CLIENT', minWeight: 1, standing: 'WARNED' }] };

  for (const role of ['CLIENT', 'ARTIST', 'ADMIN'] as UserRole[]) {
    const user = await makeUser(role);
    const token = await login(user.email);
    assert.equal(
      (await call('PUT', '/admin/config/enforcement', token, body)).status,
      403,
      `${role} changed the ladders`
    );
  }
});
