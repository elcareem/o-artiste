/**
 * Identity verification — issue #10.
 *
 * The provider calls are stubbed so the failure modes can be exercised
 * deliberately. #17 already proved the real provider path end to end against
 * the sandbox; what matters here is how *we* react to each outcome.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('verification');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const { AppError } = require('../src/lib/errors.ts');
const service = require('../src/services/verificationService.ts');

const describe = hasDatabase ? test : test.skip;

test.before(async () => {
  if (ready) await ready;
});

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

async function makeUser(role = 'CLIENT') {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  const password = 'correct horse battery staple';
  const user = await prisma.user.create({
    data: {
      email: `verify${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(password),
      role,
    },
  });
  return { user, password };
}

async function withServer(fn: (server: TestServer) => Promise<void>) {
  const server = await startServer(createApp());
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

async function tokenFor(server, role = 'CLIENT') {
  const { user, password } = await makeUser(role);
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password }),
  });
  return { token: (((await res.json()) as any)).token, user };
}

/** Replaces onboardParty for one call, restoring it afterwards. */
async function withStub(impl, fn) {
  const original = escrowpay.onboardParty;
  escrowpay.onboardParty = impl;
  try {
    return await fn();
  } finally {
    escrowpay.onboardParty = original;
  }
}

const successResponse = (suffix = uniq()) => ({
  party: { id: `PAR_${suffix}`, status: 'active', payout_eligible: true },
  identity: {
    id: `IDN_${suffix}`,
    masked_identifier: '*******8902',
    verification_status: 'verified',
  },
});

function providerError(code, message, status = 502) {
  const err = new AppError(status, 'The payment provider could not complete that request.');
  err.providerCode = code;
  err.providerMessage = message;
  return err;
}

// ---------------------------------------------------------------------------

describe('a successful verification stores the result and the party, never the identifier', async () => {
  const { user } = await makeUser();

  const result = await withStub(async () => successResponse('abc123'), () =>
    service.verifyUser({ userId: user.id, method: 'NIN', identifier: '12345678902' })
  );

  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.cached, false);
  assert.equal(result.partyId, 'PAR_abc123');

  const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(stored.verificationStatus, 'VERIFIED');
  assert.equal(stored.verificationMethod, 'NIN');
  assert.equal(stored.verificationReference, 'IDN_abc123');
  assert.equal(stored.escrowPartyId, 'PAR_abc123');
  assert.ok(stored.verifiedAt);

  // The raw NIN must appear nowhere on the record.
  assert.ok(
    !JSON.stringify(stored).includes('12345678902'),
    'the raw identifier must never be persisted — NDPR exposure with no benefit'
  );
});

describe('re-running verification for an already-verified user makes NO provider call', async () => {
  const { user } = await makeUser();

  await withStub(async () => successResponse('cached1'), () =>
    service.verifyUser({ userId: user.id, method: 'NIN', identifier: '12345678902' })
  );

  // The stub now throws if called at all, so a second provider call fails loudly.
  let called = false;
  const result = await withStub(
    async () => {
      called = true;
      throw new Error('the provider must not be called for a verified user');
    },
    () => service.verifyUser({ userId: user.id, method: 'NIN', identifier: '12345678902' })
  );

  assert.equal(called, false, 'no provider call for a returning user');
  assert.equal(result.cached, true);
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.partyId, 'PAR_cached1');
});

describe('a returning user is charged once, not twice', async () => {
  const { user } = await makeUser();

  await withStub(async () => successResponse('cost1'), () =>
    service.verifyUser({ userId: user.id, method: 'NIN', identifier: '12345678902' })
  );
  await withStub(async () => successResponse('cost1'), () =>
    service.verifyUser({ userId: user.id, method: 'NIN', identifier: '12345678902' })
  );

  const costs = await prisma.platformCost.findMany({ where: { userId: user.id } });
  assert.equal(costs.length, 1, 'the ₦50 is once per person for life');
  assert.equal(costs[0].amountKobo, 5000);
  assert.equal(costs[0].category, 'IDENTITY_VERIFICATION');

  // Recorded as a platform cost, NOT a ledger entry — every ledger row belongs
  // to a booking, and a lifetime cost belongs to none.
  const ledger = await prisma.ledgerEntry.count();
  assert.equal(ledger, 0, 'verification must never touch per-booking economics');
});

describe('a provider timeout leaves the user RETRYABLE, not failed', async () => {
  const { user } = await makeUser();

  await assert.rejects(
    () =>
      withStub(
        async () => {
          throw providerError('provider_unreachable', 'timeout of 15000ms exceeded');
        },
        () => service.verifyUser({ userId: user.id, method: 'NIN', identifier: '12345678902' })
      ),
    (err: ThrownError) => {
      // 503, not 403 — this is our partner being unreachable, not a rejection.
      assert.equal(err.status, 503);
      assert.match((err as ThrownError).message, /try again/i);
      return true;
    }
  );

  const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(stored.verificationStatus, 'RETRYABLE_FAILURE');
  assert.notEqual(stored.verificationStatus, 'REJECTED', 'a network blip must not be permanent');

  const status = await service.getStatus(user.id);
  assert.equal(status.retryable, true);

  // And a later attempt succeeds, so the state really was recoverable.
  const retry = await withStub(async () => successResponse('after_retry'), () =>
    service.verifyUser({ userId: user.id, method: 'NIN', identifier: '12345678902' })
  );
  assert.equal(retry.status, 'VERIFIED');
});

describe('a 4xx from the provider is a fixable request, not an outage', async () => {
  // Caught by running against the real sandbox: a malformed email returns 422,
  // and the original catch-all reported it as "we could not reach our
  // verification partner — try again in a few minutes". Retrying unchanged
  // fails identically forever, so that message was actively misleading.
  const { user } = await makeUser();

  await assert.rejects(
    () =>
      withStub(
        async () => {
          const err = providerError('validation_error', 'body.email: not a valid email address');
          err.providerStatus = 422;
          throw err;
        },
        () => service.verifyUser({ userId: user.id, method: 'NIN', identifier: '12345678902' })
      ),
    (err: ThrownError) => {
      assert.equal(err.status, 400, 'a fixable request is 400, not 503');
      assert.match((err as ThrownError).message, /check your email address/i);
      assert.doesNotMatch((err as ThrownError).message, /few minutes/i, 'must not suggest waiting');
      return true;
    }
  );

  const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  // Back to UNVERIFIED: nothing is broken, the details need correcting.
  assert.equal(stored.verificationStatus, 'UNVERIFIED');
  assert.equal((await service.getStatus(user.id)).retryable, true);
});

describe('a genuine mismatch is REJECTED and is not retryable', async () => {
  const { user } = await makeUser();

  await assert.rejects(
    () =>
      withStub(
        async () => {
          throw providerError(
            'identity_verification_failed',
            'Identity verification did not succeed; party was not created (data_mismatch).'
          );
        },
        () => service.verifyUser({ userId: user.id, method: 'NIN', identifier: '12345678901' })
      ),
    (err: ThrownError) => err.status === 403
  );

  const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(stored.verificationStatus, 'REJECTED');
  assert.match(stored.verificationFailureReason, /data_mismatch/);

  assert.equal((await service.getStatus(user.id)).retryable, false);

  // A resubmission is refused without reaching the provider.
  let called = false;
  await assert.rejects(() =>
    withStub(
      async () => {
        called = true;
        return successResponse();
      },
      () => service.verifyUser({ userId: user.id, method: 'NIN', identifier: '12345678901' })
    )
  );
  assert.equal(called, false, 'a rejected identity is not retried against the provider');

  // No cost was incurred for a failed check.
  assert.equal(await prisma.platformCost.count({ where: { userId: user.id } }), 0);
});

describe('409 identity_already_exists is treated as success, not failure', async () => {
  // Found while building #17: identities are unique per environment, so a user
  // whose identity was onboarded before gets a 409. Treating that as an error
  // would lock out exactly the returning users the caching exists to serve.
  const { user } = await makeUser();

  const result = await withStub(
    async () => {
      throw providerError(
        'identity_already_exists',
        'An identity with this identifier already exists in this environment.',
        502
      );
    },
    () => service.verifyUser({ userId: user.id, method: 'BVN', identifier: '22222222222' })
  );

  assert.equal(result.status, 'VERIFIED');
  const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(stored.verificationStatus, 'VERIFIED');

  // Not billable — the provider does not charge for an existing identity.
  assert.equal(await prisma.platformCost.count({ where: { userId: user.id } }), 0);
});

describe('input is validated before the provider is troubled', async () => {
  const { user } = await makeUser();

  for (const [method, identifier] of [
    ['PASSPORT', '12345678902'],
    ['', '12345678902'],
    ['NIN', 'xx'],
    ['NIN', ''],
  ]) {
    let called = false;
    await assert.rejects(
      () =>
        withStub(
          async () => {
            called = true;
            return successResponse();
          },
          () => service.verifyUser({ userId: user.id, method, identifier })
        ),
      (err: ThrownError) => err.status === 400
    );
    assert.equal(called, false, `${method}/${identifier} must not reach the provider`);
  }

  // Both accepted methods work.
  assert.deepEqual(service.METHODS, ['NIN', 'BVN']);
});

describe('the endpoints require auth and report status', async () => {
  await withServer(async (server: TestServer) => {
    assert.equal((await fetch(`${server.url}/me/verification`)).status, 401);

    const { token, user } = await tokenFor(server);

    const before = ((await (
      await fetch(`${server.url}/me/verification`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as any);
    assert.equal(before.verification.status, 'UNVERIFIED');
    assert.equal(before.verification.retryable, true);

    const res = await withStub(async () => successResponse('endpoint1'), () =>
      fetch(`${server.url}/me/verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ method: 'NIN', identifier: '12345678902' }),
      })
    );
    assert.equal(res.status, 201);

    const after = ((await (
      await fetch(`${server.url}/me/verification`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as any);
    assert.equal(after.verification.status, 'VERIFIED');

    // GET /me reflects it too.
    const me = ((await (
      await fetch(`${server.url}/me`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as any);
    assert.equal(me.user.verificationStatus, 'VERIFIED');
    void user;
  });
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
});
