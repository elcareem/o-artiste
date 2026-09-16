/**
 * Strike accrual — issue #33, docs/06.
 *
 * The engine, not its triggers. #28 and #29 call it when a cancellation is
 * recorded and #32 when a dispute is ruled; building it first is how the
 * circular dependency in the backlog was resolved (docs/08 §2).
 *
 * The ordering of the weights is the substance. A client who cancels late has
 * inconvenienced an artist; a client who receives a performance and then claims
 * it never happened has attempted theft. A system that prices those the same is
 * mispricing the behaviour it most needs to deter.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('strikes');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const strikeService = require('../src/services/strikeService.ts');

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

async function makeUser(role: UserRole) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  return prisma.user.create({
    data: {
      email: `stk${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
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

/**
 * A complete rule set with the named rows replaced.
 *
 * Complete because a partial set is refused: publishing one would silently stop
 * accrual for every trigger left out, which is how this very file first went
 * wrong — one case published an artist-only set and two later cases quietly
 * stopped recording client strikes.
 */
function completeSet(overrides: Partial<Record<StrikeTrigger, Partial<StrikeRuleInput>>> = {}) {
  return strikeService.DEFAULT_RULES.map((rule: StrikeRuleInput) => ({
    ...rule,
    ...(overrides[rule.trigger] ?? {}),
  }));
}

// ---------------------------------------------------------------------------
// Criterion: each trigger produces a strike of the correct weight
// ---------------------------------------------------------------------------

describe('each trigger produces a strike of the correct weight', async () => {
  const { rules } = await strikeService.resolveRules();

  // Artist cancellations — docs/06 §2.
  const artistCases: [number, StrikeTrigger | null][] = [
    [30, null],
    [7, null],
    [6, 'ARTIST_CANCEL_3_6_DAYS'],
    [3, 'ARTIST_CANCEL_3_6_DAYS'],
    [2, 'ARTIST_CANCEL_1_2_DAYS'],
    [1, 'ARTIST_CANCEL_1_2_DAYS'],
    [0, 'ARTIST_CANCEL_DAY_OF'],
  ];

  for (const [days, expected] of artistCases) {
    const rule = strikeService.triggerForCancellation(rules, 'ARTIST', days);
    assert.equal(rule?.trigger ?? null, expected, `artist, ${days} day(s) out`);
  }

  // Client cancellations — docs/06 §3. Only the two tightest bands.
  const clientCases: [number, StrikeTrigger | null][] = [
    [30, null],
    [7, null],
    [3, null],
    [2, 'CLIENT_CANCEL_1_2_DAYS'],
    [1, 'CLIENT_CANCEL_1_2_DAYS'],
    [0, 'CLIENT_CANCEL_DAY_OF'],
  ];

  for (const [days, expected] of clientCases) {
    const rule = strikeService.triggerForCancellation(rules, 'CLIENT', days);
    assert.equal(rule?.trigger ?? null, expected, `client, ${days} day(s) out`);
  }

  // Disputes.
  assert.equal(strikeService.triggerForDispute(rules, false).trigger, 'DISPUTE_RULED_AGAINST');
  assert.equal(
    strikeService.triggerForDispute(rules, true).trigger,
    'DISPUTE_FALSE_NO_SHOW_CLAIM'
  );

  // And the weights actually land on the row.
  const artist = await makeUser('ARTIST');
  const strike = await inTx((tx: PrismaTx) =>
    strikeService.accrueForCancellation(tx, {
      userId: artist.id,
      by: 'ARTIST',
      daysBefore: 0,
      bookingId: null,
    })
  );

  assert.equal(strike.trigger, 'ARTIST_CANCEL_DAY_OF');
  assert.equal(strike.weight, 3);
  assert.equal(strike.active, true);
  assert.match(strike.reason, /Artist cancelled 0 day\(s\)/);
  assert.ok(strike.createdAt);
});

// ---------------------------------------------------------------------------
// Criterion: a false-no-show ruling is heavier than a late cancellation
// ---------------------------------------------------------------------------

describe('a false-no-show ruling weighs more than a late cancellation', async () => {
  const client = await makeUser('CLIENT');

  const late = await inTx((tx: PrismaTx) =>
    strikeService.accrueForCancellation(tx, {
      userId: client.id,
      by: 'CLIENT',
      daysBefore: 0,
      bookingId: null,
    })
  );

  const fraud = await inTx((tx: PrismaTx) =>
    strikeService.accrueForDispute(tx, {
      userId: client.id,
      falseNoShowClaim: true,
      bookingId: null,
    })
  );

  // THE WHOLE POINT OF docs/06 §1. One is poor planning; the other is an
  // attempt to obtain a performance for free.
  assert.ok(
    fraud.weight > late.weight,
    `false no-show weighed ${fraud.weight}, late cancellation ${late.weight}`
  );

  // And heavier than an ordinary adverse ruling, too.
  const ordinary = await inTx((tx: PrismaTx) =>
    strikeService.accrueForDispute(tx, {
      userId: client.id,
      falseNoShowClaim: false,
      bookingId: null,
    })
  );
  assert.ok(fraud.weight > ordinary.weight);

  assert.match(fraud.reason, /contradicted by a check-in/i);
});

// ---------------------------------------------------------------------------
// Criterion: a 7+ day artist cancellation produces no strike
// ---------------------------------------------------------------------------

describe('an artist cancelling seven days out gets no strike at all', async () => {
  const artist = await makeUser('ARTIST');

  for (const days of [7, 8, 30, 365]) {
    const result = await inTx((tx: PrismaTx) =>
      strikeService.accrueForCancellation(tx, {
        userId: artist.id,
        by: 'ARTIST',
        daysBefore: days,
        bookingId: null,
      })
    );

    // `null` is a real answer, not a failure. A week is enough time for the
    // client to rebook, so there is nothing to deter — the artist still bears
    // the fee liability, which is #28's concern rather than this module's.
    assert.equal(result, null, `${days} days out produced a strike`);
  }

  assert.equal(await prisma.strike.count({ where: { userId: artist.id } }), 0);
});

// ---------------------------------------------------------------------------
// Criterion: changing a threshold changes behaviour without a deploy
// ---------------------------------------------------------------------------

describe('changing a threshold changes accrual, with no deploy and no restart', async () => {
  const superAdmin = await makeUser('SUPER_ADMIN');
  const token = await login(superAdmin.email);
  const artist = await makeUser('ARTIST');

  // Before: seven days out is a normal business event.
  const before = await inTx((tx: PrismaTx) =>
    strikeService.accrueForCancellation(tx, {
      userId: artist.id,
      by: 'ARTIST',
      daysBefore: 7,
      bookingId: null,
    })
  );
  assert.equal(before, null);

  // The platform decides late cancellation starts a week out instead, and
  // raises the day-of weight. Published through the API, as an admin would.
  const published = await call('PUT', '/admin/config/strikes', token, {
    rules: completeSet({
      ARTIST_CANCEL_3_6_DAYS: { maxDaysBefore: 7 },
      ARTIST_CANCEL_DAY_OF: { weight: 9 },
      DISPUTE_FALSE_NO_SHOW_CLAIM: { weight: 12 },
    }),
  });
  assert.equal(published.status, 201);

  // After: the SAME running process, no restart, no redeployment.
  const after = await inTx((tx: PrismaTx) =>
    strikeService.accrueForCancellation(tx, {
      userId: artist.id,
      by: 'ARTIST',
      daysBefore: 7,
      bookingId: null,
    })
  );

  assert.ok(after, 'the new threshold did not take effect');
  assert.equal(after.trigger, 'ARTIST_CANCEL_3_6_DAYS');

  const dayOf = await inTx((tx: PrismaTx) =>
    strikeService.accrueForCancellation(tx, {
      userId: artist.id,
      by: 'ARTIST',
      daysBefore: 0,
      bookingId: null,
    })
  );
  assert.equal(dayOf.weight, 9, 'the new weight did not take effect');

  // Older strikes keep the weight that was in force when they were issued. The
  // table is append-only precisely so a strike issued last month can still be
  // explained by the rules of last month.
  const reread = await prisma.strike.findUnique({ where: { id: dayOf.id } });
  assert.equal(reread.weight, 9);

  // And the change is attributable.
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'STRIKE_RULES_UPDATED', actorUserId: superAdmin.id },
  });
  assert.ok(audit, 'a rule change was not recorded in the audit log');
});

// ---------------------------------------------------------------------------
// Configuration behaviour
// ---------------------------------------------------------------------------

describe('an empty table falls back to the shipped defaults, and says so', async () => {
  // Checked before anything is published in this schema.
  const fresh = await strikeService.resolveRules(new Date('2000-01-01T00:00:00Z'));

  assert.equal(fresh.isDefault, true);
  assert.equal(fresh.versionId, null);
  assert.ok(fresh.rules.length > 0);

  // A system that quietly stops recording misconduct because a table is empty
  // is worse than one that refuses to start.
  assert.ok(strikeService.triggerForCancellation(fresh.rules, 'ARTIST', 0));
});

describe('the admin surface distinguishes "nobody decided" from "somebody decided this"', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const res = await call('GET', '/admin/config/strikes', token);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.current.isDefault, 'boolean');
  assert.ok(Array.isArray(res.body.current.rules));
});

test('a rule set that cannot be applied is refused, naming the row', () => {
  const { validateRules } = strikeService;

  assert.throws(() => validateRules([]), /at least one strike rule/i);

  assert.throws(
    () =>
      validateRules([
        { trigger: 'ARTIST_CANCEL_DAY_OF', weight: 1, minDaysBefore: 0, maxDaysBefore: 0 },
        { trigger: 'ARTIST_CANCEL_DAY_OF', weight: 2, minDaysBefore: 0, maxDaysBefore: 0 },
      ]),
    /appears twice/
  );

  // A zero or negative weight is a strike that does not count, recorded as
  // though it does.
  for (const weight of [0, -1, 1.5]) {
    assert.throws(
      () => validateRules(completeSet({ DISPUTE_RULED_AGAINST: { weight } })),
      /weight must be a whole number/
    );
  }

  assert.throws(
    () => validateRules(completeSet({ ARTIST_CANCEL_1_2_DAYS: { minDaysBefore: 5, maxDaysBefore: 2 } })),
    /is before minDaysBefore/
  );

  // A PARTIAL SET IS REFUSED, naming what is missing. An admin editing the
  // artist bands and submitting only those would switch off client misconduct
  // entirely, and nothing would say so.
  assert.throws(
    () =>
      validateRules([
        { trigger: 'ARTIST_CANCEL_3_6_DAYS', weight: 1, minDaysBefore: 3, maxDaysBefore: 6 },
      ]),
    /must price every trigger/
  );
  assert.throws(
    () => validateRules(strikeService.DEFAULT_RULES.slice(0, -1)),
    /Missing: DISPUTE_FALSE_NO_SHOW_CLAIM/
  );

  // The shipped defaults are themselves a valid, complete set.
  validateRules(strikeService.DEFAULT_RULES);
});

describe('only a super-admin may change how conduct is priced', async () => {
  const body = { rules: completeSet({ DISPUTE_RULED_AGAINST: { weight: 5 } }) };

  for (const role of ['CLIENT', 'ARTIST', 'ADMIN'] as UserRole[]) {
    const user = await makeUser(role);
    const token = await login(user.email);
    const res = await call('PUT', '/admin/config/strikes', token, body);
    assert.equal(res.status, 403, `${role} changed the strike rules`);
  }

  assert.equal((await call('PUT', '/admin/config/strikes', undefined, body)).status, 401);
});

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

describe('every strike carries its cause, and the whole record is reviewable', async () => {
  const client = await makeUser('CLIENT');
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  await inTx((tx: PrismaTx) =>
    strikeService.accrueForCancellation(tx, {
      userId: client.id,
      by: 'CLIENT',
      daysBefore: 1,
      bookingId: null,
    })
  );
  await inTx((tx: PrismaTx) =>
    strikeService.accrueForDispute(tx, {
      userId: client.id,
      falseNoShowClaim: true,
      bookingId: null,
    })
  );

  const res = await call('GET', `/admin/users/${client.id}/strikes`, token);
  assert.equal(res.status, 200);

  const { history } = res.body;
  assert.equal(history.total, 2);
  assert.equal(history.activeCount, 2);

  // Weight, not count. Three late cancellations and one attempted fraud are not
  // the same account, and it is weight that #34's ladders read.
  //
  // Expected from the rules IN FORCE rather than a literal: an earlier case in
  // this file publishes a new set, and a hardcoded total would be asserting the
  // defaults while the service is correctly using something else.
  const { rules } = await strikeService.resolveRules();
  const weightOf = (trigger: StrikeTrigger) =>
    rules.find((r: StrikeRuleRow) => r.trigger === trigger).weight;

  assert.equal(
    history.activeWeight,
    weightOf('CLIENT_CANCEL_1_2_DAYS') + weightOf('DISPUTE_FALSE_NO_SHOW_CLAIM')
  );

  // And the relationship that matters survives whatever the numbers are.
  assert.ok(weightOf('DISPUTE_FALSE_NO_SHOW_CLAIM') > weightOf('CLIENT_CANCEL_1_2_DAYS'));

  // Newest first, and each one reconstructable: trigger, weight, reason, time.
  for (const strike of history.strikes) {
    assert.ok(strike.trigger);
    assert.ok(strike.weight >= 1);
    assert.ok(strike.reason && strike.reason.length > 10, `thin reason: "${strike.reason}"`);
    assert.ok(strike.createdAt);
  }
  assert.equal(history.strikes[0].trigger, 'DISPUTE_FALSE_NO_SHOW_CLAIM');
});

describe('a strike and its audit row commit together, or neither does', async () => {
  const client = await makeUser('CLIENT');

  // A strike recorded without its cause cannot be reviewed, and every one of
  // these is appealable.
  const strike = await inTx((tx: PrismaTx) =>
    strikeService.accrueForDispute(tx, {
      userId: client.id,
      falseNoShowClaim: false,
      bookingId: null,
    })
  );

  const audit = await prisma.auditLog.findFirst({
    where: { action: 'STRIKE_ACCRUED', entityId: strike.id },
  });
  assert.ok(audit, 'no audit row for an adverse action against an account');
  assert.equal(audit.entityType, 'Strike');
  assert.equal((audit.after as any).trigger, 'DISPUTE_RULED_AGAINST');
});

describe('a strike must name a user and a reason', async () => {
  const rule = { trigger: 'DISPUTE_RULED_AGAINST' as StrikeTrigger, weight: 1 };

  await assert.rejects(
    () => inTx((tx: PrismaTx) => strikeService.accrue(tx, { userId: '', rule, reason: 'x' })),
    /must name the user/
  );

  const client = await makeUser('CLIENT');
  await assert.rejects(
    () => inTx((tx: PrismaTx) => strikeService.accrue(tx, { userId: client.id, rule, reason: '' })),
    /must record why/
  );
});

describe('strikes are attached to the booking that caused them', async () => {
  const artist = await makeUser('ARTIST');
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  // A strike whose cause cannot be reconstructed is not reviewable, and the
  // booking is most of the cause.
  const clientUser = await makeUser('CLIENT');
  await prisma.client.create({ data: { userId: clientUser.id, displayName: 'C' } });
  const artistProfile = await prisma.artist.create({
    data: {
      userId: artist.id,
      stageName: `A ${uniq()}`,
      category: 'Afrobeats',
      location: 'Lagos',
      baseRateKobo: 20000000,
      profileComplete: true,
    },
  });

  const superAdmin = await makeUser('SUPER_ADMIN');
  await prisma.commissionRate.create({
    data: { rateBasisPoints: 500, effectiveFrom: new Date(), setByUserId: superAdmin.id },
  });
  await prisma.cancellationTier.createMany({
    data: [
      { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
      { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
      { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
      { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
    ].map((t) => ({ ...t, versionId: `v_${uniq()}`, effectiveFrom: new Date(), setByUserId: superAdmin.id })),
  });

  const booking = await require('../src/services/bookingService.ts').createBooking({
    clientUserId: clientUser.id,
    artistId: artistProfile.id,
    amountKobo: 20000000,
    eventDate: new Date(Date.now() + 5 * 86400000),
  });

  const strike = await inTx((tx: PrismaTx) =>
    strikeService.accrueForCancellation(tx, {
      userId: artist.id,
      by: 'ARTIST',
      daysBefore: 5,
      bookingId: booking.id,
    })
  );

  assert.equal(strike.bookingId, booking.id);

  const res = await call('GET', `/admin/users/${artist.id}/strikes`, token);
  assert.equal(res.body.history.strikes[0].booking.id, booking.id);
});
