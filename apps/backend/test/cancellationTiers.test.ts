/**
 * Versioned cancellation tier configuration — issue #8.
 *
 * The validation is the substance. A gap means a booking cancelled in that
 * window has no applicable rule, and there is no safe default: refunding
 * everything harms the artist, refunding nothing is FCCPA exposure. These
 * assertions are what make an unresolvable state unsaveable.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('tiers');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const service = require('../src/services/cancellationTierService.ts');

const describe = hasDatabase ? test : test.skip;

// The schema is emptied before anything runs, so a rerun behaves like a first run.
test.before(async () => { if (ready) await ready; });

const VALID = [
  { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
  { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
  { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
  { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
];

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

async function makeUser(role) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  const password = 'correct horse battery staple';
  const user = await prisma.user.create({
    data: {
      email: `tier${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(password),
      role,
    },
  });
  return { user, password };
}

async function withServer(fn) {
  const server = await startServer(createApp());
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

async function tokenFor(server, role) {
  const { user, password } = await makeUser(role);
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password }),
  });
  return { ...(await res.json()), user };
}

const putTiers = (server, body, token) =>
  fetch(`${server.url}/admin/config/cancellation-tiers`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** Asserts a 400 whose message actually names the problem. */
async function rejectsNaming(server, token, tiers, pattern, label) {
  const res = await putTiers(server, { tiers, reason: 'test' }, token);
  assert.equal(res.status, 400, `${label}: expected 400`);
  const { error } = await res.json();
  assert.match(error, pattern, `${label}: message must name the problem, got: ${error}`);
  return error;
}

// ---------------------------------------------------------------------------

describe('submitting overlapping ranges returns 400 with a message naming the conflict', async () => {
  await withServer(async (server) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');

    const overlapping = [
      { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
      { minDaysBefore: 1, maxDaysBefore: 6, clientRefundBps: 4000, artistCompensationBps: 6000 },
      // Starts at 5, but the previous band runs to 6 — they overlap on 5 and 6.
      { minDaysBefore: 5, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
    ];

    const message = await rejectsNaming(server, token, overlapping, /overlap/i, 'overlap');
    // Both offending bands are named, not merely "invalid tier set".
    assert.match(message, /day 1 to 6/i);
    assert.match(message, /day 5 and above/i);
  });
});

describe('submitting a set with a gap at days 3-4 returns 400 naming that window', async () => {
  await withServer(async (server) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');

    const gapped = [
      { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
      { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
      // 3 and 4 are covered by nothing.
      { minDaysBefore: 5, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
      { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
    ];

    const message = await rejectsNaming(server, token, gapped, /not covered/i, 'gap');
    assert.match(message, /Days 3 to 4/, `the uncovered window must be named, got: ${message}`);
  });
});

describe('a single-day gap is named in the singular', async () => {
  await withServer(async (server) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');

    const gapped = [
      { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
      { minDaysBefore: 2, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
    ];

    const message = await rejectsNaming(server, token, gapped, /not covered/i, 'single-day gap');
    assert.match(message, /Day 1 is/, `got: ${message}`);
  });
});

describe('submitting a row summing to 9500 bps returns 400', async () => {
  await withServer(async (server) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');

    const wrongSum = [
      { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
      // 4000 + 5500 = 9500. The missing 500 bps belongs to nobody.
      { minDaysBefore: 1, maxDaysBefore: null, clientRefundBps: 4000, artistCompensationBps: 5500 },
    ];

    const message = await rejectsNaming(server, token, wrongSum, /9500/, 'wrong sum');
    assert.match(message, /must sum to 10000/i);
    assert.match(message, /day 1 and above/i, 'the offending band is named');
  });
});

describe('a set that does not cover day 0 is rejected', async () => {
  await withServer(async (server) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');

    const noDayZero = [
      { minDaysBefore: 1, maxDaysBefore: 6, clientRefundBps: 4000, artistCompensationBps: 6000 },
      { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
    ];

    const message = await rejectsNaming(server, token, noDayZero, /day 0/i, 'no day 0');
    assert.match(message, /event day/i, 'says why it matters');
  });
});

describe('the open-ended band is required, unique, and must be the top band', async () => {
  await withServer(async (server) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');

    // None open-ended: cancellations made far in advance match nothing.
    await rejectsNaming(
      server,
      token,
      [
        { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
        { minDaysBefore: 1, maxDaysBefore: 30, clientRefundBps: 10000, artistCompensationBps: 0 },
      ],
      /open-ended/i,
      'none open-ended'
    );

    // Two open-ended: a cancellation would match both.
    await rejectsNaming(
      server,
      token,
      [
        { minDaysBefore: 0, maxDaysBefore: null, clientRefundBps: 1500, artistCompensationBps: 8500 },
        { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
      ],
      /only one band may be open-ended/i,
      'two open-ended'
    );
  });
});

describe('rows are validated individually before the set is considered', async () => {
  await withServer(async (server) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');

    const cases = [
      [[{ minDaysBefore: 0, maxDaysBefore: null, clientRefundBps: 5000.5, artistCompensationBps: 4999.5 }], /whole number of basis points/i, 'fractional bps'],
      [[{ minDaysBefore: 0, maxDaysBefore: null, clientRefundBps: '10000', artistCompensationBps: 0 }], /whole number of basis points/i, 'string bps'],
      [[{ minDaysBefore: -1, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 }], /0 or more/i, 'negative day'],
      [[{ minDaysBefore: 5, maxDaysBefore: 2, clientRefundBps: 10000, artistCompensationBps: 0 }], /ends at day 2 but starts at day 5/i, 'inverted band'],
      [[], /at least one/i, 'empty set'],
    ];

    for (const [tiers, pattern, label] of cases) {
      await rejectsNaming(server, token, tiers, pattern, label);
    }
  });
});

describe('a prior tier set remains queryable after a change', async () => {
  await withServer(async (server) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');

    const first = await (await putTiers(server, { tiers: VALID, reason: 'initial' }, token)).json();

    // A restructured table — a new 14-day band, which is exactly the change the
    // issue says rows must be addable for.
    const restructured = [
      { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1000, artistCompensationBps: 9000 },
      { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 3000, artistCompensationBps: 7000 },
      { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 6000, artistCompensationBps: 4000 },
      { minDaysBefore: 7, maxDaysBefore: 13, clientRefundBps: 8000, artistCompensationBps: 2000 },
      { minDaysBefore: 14, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
    ];
    const second = await (
      await putTiers(server, { tiers: restructured, reason: 'added a 14-day band' }, token)
    ).json();

    assert.notEqual(second.current.versionId, first.current.versionId);
    assert.equal(second.current.tiers.length, 5, 'rows are addable, not only editable');

    // The prior version is untouched and still readable in full.
    const prior = await prisma.cancellationTier.findMany({
      where: { versionId: first.current.versionId },
      orderBy: { minDaysBefore: 'asc' },
    });
    assert.equal(prior.length, 4);
    assert.equal(prior[0].clientRefundBps, 1500, 'the old day-0 band still reads 1500, not 1000');

    // And the resolver now returns the new one.
    const current = await service.resolveTierSet();
    assert.equal(current.versionId, second.current.versionId);
    assert.equal(current.tiers.length, 5);
  });
});

describe('a non-super-admin receives 403', async () => {
  await withServer(async (server) => {
    for (const role of ['CLIENT', 'ARTIST', 'ADMIN']) {
      const { token } = await tokenFor(server, role);
      const res = await putTiers(server, { tiers: VALID, reason: 'attempt' }, token);
      assert.equal(res.status, 403, `${role} must not be able to change the tier table`);
    }

    assert.equal((await putTiers(server, { tiers: VALID, reason: 'x' })).status, 401);

    // ADMIN may read it — seeing the table does not carry the risk of changing it.
    const { token: adminToken } = await tokenFor(server, 'ADMIN');
    const read = await fetch(`${server.url}/admin/config/cancellation-tiers`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(read.status, 200);
  });
});

describe('a change requires a written reason and is recorded in the audit log', async () => {
  await withServer(async (server) => {
    const { token, user } = await tokenFor(server, 'SUPER_ADMIN');

    assert.equal((await putTiers(server, { tiers: VALID }, token)).status, 400);
    assert.equal((await putTiers(server, { tiers: VALID, reason: '  ' }, token)).status, 400);

    const saved = await (
      await putTiers(server, { tiers: VALID, reason: 'aligning with provider fees' }, token)
    ).json();

    const row = await prisma.auditLog.findFirst({
      where: { action: 'CANCELLATION_TIERS_CHANGED', entityId: saved.current.versionId },
    });

    assert.ok(row, 'every change must be attributable');
    assert.equal(row.actorUserId, user.id);
    assert.equal(row.reason, 'aligning with provider fees');
    assert.equal(row.after.tiers.length, 4, 'the whole set is recorded, not just that it changed');
  });
});

describe('the validator is pure, so the same rules hold without a request', async () => {
  // #36 mirrors these client-side for immediate feedback; the server stays
  // authoritative. Exercising the function directly proves the rules live in
  // one place rather than in the route handler.
  const sorted = service.validateTierSet(VALID);
  assert.equal(sorted[0].minDaysBefore, 0, 'returns the set sorted ascending');
  assert.equal(sorted[3].maxDaysBefore, null);

  assert.throws(() => service.validateTierSet([]), /at least one/i);
  assert.throws(
    () =>
      service.validateTierSet([
        { minDaysBefore: 0, maxDaysBefore: 1, clientRefundBps: 5000, artistCompensationBps: 5000 },
        { minDaysBefore: 1, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
      ]),
    /overlap/i
  );
});

describe('every day resolves to exactly one band in a saved set', async () => {
  await withServer(async (server) => {
    const { token } = await tokenFor(server, 'SUPER_ADMIN');
    await putTiers(server, { tiers: VALID, reason: 'coverage check' }, token);

    const { tiers } = await service.resolveTierSet();

    for (let day = 0; day <= 400; day++) {
      const matching = tiers.filter(
        (t) => day >= t.minDaysBefore && (t.maxDaysBefore === null || day <= t.maxDaysBefore)
      );
      assert.equal(matching.length, 1, `day ${day} matched ${matching.length} bands`);
    }
  });
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
