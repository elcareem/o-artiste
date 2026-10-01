/**
 * The configuration surface — issue #36, docs/07 §6.
 *
 * Every tunable decision in this system was built as configuration rather than
 * a constant precisely so a settings screen could exist. These tests are about
 * the half of that which the screen cannot guarantee: the server remaining
 * authoritative whichever path a request arrives by.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('adminsettings');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
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
  { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
  { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
  { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
  { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
];

async function makeUser(role: UserRole) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  return prisma.user.create({
    data: {
      email: `set${n}@example.test`,
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

/** A published baseline so the settings endpoint has something to report. */
async function baseline(superAdminToken: string) {
  await call('PUT', '/admin/config/commission', superAdminToken, {
    rateBasisPoints: 500,
    reason: 'Baseline for this test run.',
  });
  await call('PUT', '/admin/config/cancellation-tiers', superAdminToken, {
    tiers: DEFAULT_TIERS,
    reason: 'Baseline for this test run.',
  });
}

// ---------------------------------------------------------------------------
// Bootstrap — this runs FIRST, on a schema where nothing has been published
// ---------------------------------------------------------------------------

describe('the settings screen works on a system with nothing configured yet', async () => {
  const superAdmin = await makeUser('SUPER_ADMIN');
  const token = await login(superAdmin.email);

  // No cancellation table exists yet. `resolveTierSet` throws on that, and must
  // — a booking cannot be created against a table that does not exist. But the
  // settings screen is HOW THE FIRST TABLE GETS PUBLISHED, so it cannot be the
  // thing that fails without one.
  const settings = await call('GET', '/admin/settings', token);
  assert.equal(settings.status, 200, settings.body.error);
  assert.equal(settings.body.settings.cancellationTiers.configured, false);
  assert.deepEqual(settings.body.settings.cancellationTiers.tiers, []);

  const tiers = await call('GET', '/admin/config/cancellation-tiers', token);
  assert.equal(tiers.status, 200, tiers.body.error);
  assert.equal(tiers.body.current, null);
  assert.deepEqual(tiers.body.history, []);

  // And publishing the first one from that state works.
  const first = await call('PUT', '/admin/config/cancellation-tiers', token, {
    tiers: DEFAULT_TIERS,
    reason: 'The first table on this deployment.',
  });
  assert.equal(first.status, 201, first.body.error);

  const after = await call('GET', '/admin/settings', token);
  assert.equal(after.body.settings.cancellationTiers.configured, true);
  assert.equal(after.body.settings.cancellationTiers.tiers.length, 4);
});

// ---------------------------------------------------------------------------
// Every change is attributable, so every change carries a reason
// ---------------------------------------------------------------------------

describe('a config change without a written reason is refused', async () => {
  const superAdmin = await makeUser('SUPER_ADMIN');
  const token = await login(superAdmin.email);

  // The history exists to answer "who changed this, when, and WHY". The third
  // is the one the system cannot reconstruct later, so it is mandatory at the
  // point of change (docs/07 §5).
  for (const body of [
    { rateBasisPoints: 600 },
    { rateBasisPoints: 600, reason: '' },
    { rateBasisPoints: 600, reason: '   ' },
  ]) {
    const res = await call('PUT', '/admin/config/commission', token, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, /reason/i);
  }

  const tiers = await call('PUT', '/admin/config/cancellation-tiers', token, {
    tiers: DEFAULT_TIERS,
  });
  assert.equal(tiers.status, 400);
  assert.match(tiers.body.error, /reason/i);
});

// ---------------------------------------------------------------------------
// Criterion: adding a tier row persists as a new version, existing bookings unaffected
// ---------------------------------------------------------------------------

describe('adding a band publishes a new version and leaves existing bookings alone', async () => {
  const superAdmin = await makeUser('SUPER_ADMIN');
  const token = await login(superAdmin.email);
  await baseline(token);

  // A booking made under the current bands.
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
    eventDate: new Date(Date.now() + 30 * 86400000),
  });

  const before = (booking.cancellationTiersSnapshot as unknown as CancellationTierSnapshot[]).length;
  assert.equal(before, 4);

  // The bands are restructured: the 3–6 band is split into 3–4 and 5–6.
  const restructured = [
    { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
    { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
    { minDaysBefore: 3, maxDaysBefore: 4, clientRefundBps: 6000, artistCompensationBps: 4000 },
    { minDaysBefore: 5, maxDaysBefore: 6, clientRefundBps: 8000, artistCompensationBps: 2000 },
    { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
  ];

  const published = await call('PUT', '/admin/config/cancellation-tiers', token, {
    tiers: restructured,
    reason: 'Splitting the 3-6 day band so notice is rewarded more finely.',
  });
  assert.equal(published.status, 201, published.body.error);

  // ROWS ARE ADDABLE, not merely editable — the band structure itself changes.
  const current = await call('GET', '/admin/config/cancellation-tiers', token);
  assert.equal(current.body.current.tiers.length, 5);

  // THE EXISTING BOOKING IS UNTOUCHED. That is the entire purpose of the
  // snapshot: the client acknowledged specific percentages, and those execute
  // however the table changes afterwards.
  const reread = await prisma.booking.findUnique({ where: { id: booking.id } });
  const snapshot = reread.cancellationTiersSnapshot as unknown as CancellationTierSnapshot[];
  assert.equal(snapshot.length, 4, 'a config change reached an existing booking');
  assert.equal(snapshot.find((t) => t.minDaysBefore === 3)?.clientRefundBps, 7000);

  // A new booking gets the new table.
  const after = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo: N(200000),
    eventDate: new Date(Date.now() + 30 * 86400000),
  });
  assert.equal(
    (after.cancellationTiersSnapshot as unknown as CancellationTierSnapshot[]).length,
    5
  );
});

// ---------------------------------------------------------------------------
// Criterion: an ADMIN cannot see or reach the commission field
// ---------------------------------------------------------------------------

describe('an admin sees that commission exists and cannot change it', async () => {
  const superAdmin = await makeUser('SUPER_ADMIN');
  await baseline(await login(superAdmin.email));

  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const settings = await call('GET', '/admin/settings', token);
  assert.equal(settings.status, 200);

  // MARKED, NOT OMITTED. A screen that silently lacks a section tells an admin
  // less than one that says "not yours to change" — and the server refuses the
  // write regardless of what the screen offers.
  assert.equal(settings.body.settings.commission.editable, false);
  assert.equal(settings.body.settings.cancellationTiers.editable, false);
  assert.equal(settings.body.viewerRole, 'ADMIN');

  // And reaching for it directly is refused.
  const attempt = await call('PUT', '/admin/config/commission', token, {
    rateBasisPoints: 100,
    reason: 'Trying it on.',
  });
  assert.equal(attempt.status, 403);

  const rate = await call('GET', '/admin/config/commission', token);
  assert.equal(rate.body.current.rateBasisPoints, 500, 'the rate moved');
});

describe('a super-admin sees every section as editable', async () => {
  const superAdmin = await makeUser('SUPER_ADMIN');
  const token = await login(superAdmin.email);
  await baseline(token);

  const settings = await call('GET', '/admin/settings', token);

  for (const section of [
    'commission',
    'cancellationTiers',
    'autoRelease',
    'strikes',
    'enforcement',
    'reputation',
  ]) {
    assert.equal(
      settings.body.settings[section].editable,
      true,
      `${section} is not editable by a super-admin`
    );
  }
});

describe('the settings endpoint is closed below ADMIN', async () => {
  for (const role of ['CLIENT', 'ARTIST'] as UserRole[]) {
    const user = await makeUser(role);
    const token = await login(user.email);
    assert.equal((await call('GET', '/admin/settings', token)).status, 403, role);
  }
  assert.equal((await call('GET', '/admin/settings')).status, 401);
});

// ---------------------------------------------------------------------------
// Criterion: an invalid tier set via direct API call is rejected
// ---------------------------------------------------------------------------

describe('an invalid tier set is rejected even though the screen prevented it', async () => {
  const superAdmin = await makeUser('SUPER_ADMIN');
  const token = await login(superAdmin.email);
  await baseline(token);

  // THE SERVER IS AUTHORITATIVE. The editor refuses to submit these, and that
  // is a convenience — a set with a hole must be unsaveable whichever path the
  // request arrives by, including this one.
  const invalid: [string, any[], RegExp][] = [
    [
      'a gap',
      [
        { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
        { minDaysBefore: 5, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
      ],
      /gap|cover/i,
    ],
    [
      'an overlap',
      [
        { minDaysBefore: 0, maxDaysBefore: 3, clientRefundBps: 1500, artistCompensationBps: 8500 },
        { minDaysBefore: 2, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
      ],
      /overlap/i,
    ],
    [
      'day 0 uncovered',
      [{ minDaysBefore: 1, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 }],
      /day 0|zero/i,
    ],
    [
      'halves that do not sum to 100%',
      [{ minDaysBefore: 0, maxDaysBefore: null, clientRefundBps: 5000, artistCompensationBps: 4000 }],
      /10000|100%/i,
    ],
  ];

  for (const [label, tiers, expected] of invalid) {
    const res = await call('PUT', '/admin/config/cancellation-tiers', token, {
      tiers,
      reason: 'A set the editor would have refused to submit.',
    });
    assert.equal(res.status, 400, `${label} was accepted`);
    assert.match(res.body.error, expected, `${label}: "${res.body.error}"`);
  }

  // Nothing was published: the table in force is still the valid one.
  const current = await call('GET', '/admin/config/cancellation-tiers', token);
  assert.equal(current.body.current.tiers.length, 4);
});

// ---------------------------------------------------------------------------
// Criterion: change history names the actor for each prior version
// ---------------------------------------------------------------------------

describe('the change history names the person who made each change', async () => {
  const first = await makeUser('SUPER_ADMIN');
  const second = await makeUser('SUPER_ADMIN');

  await call('PUT', '/admin/config/commission', await login(first.email), {
    rateBasisPoints: 500,
    reason: 'Opening rate.',
  });
  await call('PUT', '/admin/config/commission', await login(second.email), {
    rateBasisPoints: 700,
    reason: 'Raised after the first quarter.',
  });

  const history = await call('GET', '/admin/config/commission', await login(first.email));
  assert.ok(history.body.history.length >= 2);

  // NAMED, NOT REFERENCED. A history answering "who" with an id sends the
  // reader to a second query they will not run (docs/07 §5).
  const newest = history.body.history[0];
  assert.equal(newest.rateBasisPoints, 700);
  assert.ok(newest.setBy, 'the prior version does not name its author');
  assert.equal(newest.setBy.email, second.email);
  assert.equal(newest.setBy.role, 'SUPER_ADMIN');

  const previous = history.body.history[1];
  assert.equal(previous.setBy.email, first.email);

  // The password hash must not ride along with the author.
  assert.doesNotMatch(JSON.stringify(history.body), /passwordHash|\$2[aby]\$/);
});

describe('the tier history names its author too', async () => {
  const superAdmin = await makeUser('SUPER_ADMIN');
  const token = await login(superAdmin.email);

  await call('PUT', '/admin/config/cancellation-tiers', token, {
    tiers: DEFAULT_TIERS,
    reason: 'The opening table.',
  });

  const history = await call('GET', '/admin/config/cancellation-tiers', token);
  const newest = history.body.history[0];

  assert.ok(newest.setBy, 'the tier history does not name its author');
  assert.equal(newest.setBy.email, superAdmin.email);
  assert.doesNotMatch(JSON.stringify(history.body), /passwordHash/);
});

// ---------------------------------------------------------------------------
// The grace period, moved out of an environment variable
// ---------------------------------------------------------------------------

describe('the grace period is configuration, and says which source is in force', async () => {
  const superAdmin = await makeUser('SUPER_ADMIN');
  const token = await login(superAdmin.email);

  const autoReleaseJob = require('../src/jobs/autoReleaseJob.ts');
  const saved = process.env.AUTO_RELEASE_GRACE_HOURS;
  delete process.env.AUTO_RELEASE_GRACE_HOURS;

  try {
    // Nothing published: the shipped default.
    assert.equal(await autoReleaseJob.resolveGraceHours(), 48);
    const fresh = await call('GET', '/admin/config/auto-release', token);
    assert.equal(fresh.body.current.source, 'default');

    const published = await call('PUT', '/admin/config/auto-release', token, { graceHours: 72 });
    assert.equal(published.status, 201);
    assert.equal(published.body.warning, undefined);

    // The SAME running process, no restart — which an environment variable
    // could never give us on a host that redeploys to apply one.
    assert.equal(await autoReleaseJob.resolveGraceHours(), 72);

    const after = await call('GET', '/admin/config/auto-release', token);
    assert.equal(after.body.current.graceHours, 72);
    assert.equal(after.body.current.source, 'published');
    assert.equal(after.body.history[0].setBy.email, superAdmin.email);

    // An environment variable still wins, and the endpoint SAYS SO rather than
    // letting someone save a row that quietly does nothing.
    process.env.AUTO_RELEASE_GRACE_HOURS = '6';
    assert.equal(await autoReleaseJob.resolveGraceHours(), 6);

    const warned = await call('PUT', '/admin/config/auto-release', token, { graceHours: 96 });
    assert.match(warned.body.warning, /takes precedence/i);
  } finally {
    if (saved === undefined) delete process.env.AUTO_RELEASE_GRACE_HOURS;
    else process.env.AUTO_RELEASE_GRACE_HOURS = saved;
  }
});

describe('an indefensible grace period is refused', async () => {
  const superAdmin = await makeUser('SUPER_ADMIN');
  const token = await login(superAdmin.email);

  for (const graceHours of [0, -1, 1.5, 'soon', null]) {
    const res = await call('PUT', '/admin/config/auto-release', token, { graceHours });
    assert.equal(res.status, 400, `${graceHours} was accepted`);
  }

  // Not a limit of the system — a limit of what is defensible. An artist
  // waiting a month to be paid on a client's silence is the failure
  // auto-release exists to prevent.
  const tooLong = await call('PUT', '/admin/config/auto-release', token, { graceHours: 24 * 31 });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /leaves artists unpaid/i);
});

describe('only a super-admin may change the grace period', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  // Readable — seeing when money moves does not carry the risk of changing it.
  assert.equal((await call('GET', '/admin/config/auto-release', token)).status, 200);
  assert.equal(
    (await call('PUT', '/admin/config/auto-release', token, { graceHours: 12 })).status,
    403
  );
});
