/**
 * Startup configuration check — issue #5 / #41.
 *
 * Written after `JWT_SECRET` was missing from the deployed API for four days
 * with nothing reporting it. `/health` said `ok`, the deploy was green, and the
 * first real login returned 500. These tests are about the difference between a
 * service that is running and a service that works.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { assertRequiredEnv, ALWAYS, FOR_WORKERS, CAPABILITIES } = require('../src/lib/requiredEnv.ts');

const BACKEND_ROOT = path.resolve(__dirname, '..');

/** Runs the check against exactly this environment, restoring the real one after. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const GOOD_SECRET = 'x'.repeat(48);

test('a complete environment passes', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      JWT_SECRET: GOOD_SECRET,
    },
    () => assertRequiredEnv()
  );
});

test('a missing JWT_SECRET is refused, in the terms a user would notice', () => {
  withEnv(
    { NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@x/db', JWT_SECRET: undefined },
    () => {
      assert.throws(
        () => assertRequiredEnv(),
        (err: ThrownError) => {
          assert.match(err.message, /JWT_SECRET is not set/);
          // The message says what breaks, not merely what is absent. "JWT_SECRET
          // is required" tells an operator nothing they can act on at 2am.
          assert.match(err.message, /Logins return 500/);
          // And how to produce an acceptable value.
          assert.match(err.message, /randomBytes/);
          return true;
        }
      );
    }
  );
});

test('every missing variable is reported at once', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      DATABASE_URL: undefined,
      JWT_SECRET: undefined,
      ESCROWPAY_API_KEY: undefined,
      ESCROWPAY_WEBHOOK_SECRET: undefined,
      WEB_ORIGIN: 'https://example.test',
    },
    () => {
      try {
        assertRequiredEnv();
        assert.fail('should have thrown');
      } catch (err) {
        const message = (err as Error).message;
        // Four names in one failure. Discovering them one restart at a time is
        // four deploys to learn four names.
        for (const name of ['DATABASE_URL', 'JWT_SECRET']) {
          assert.match(message, new RegExp(name), `${name} was not reported`);
        }
        assert.match(message, /2 configuration problems/);
      }
    }
  );
});

test('a short signing key is refused as firmly as a missing one', () => {
  withEnv(
    { NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@x/db', JWT_SECRET: 'hunter2' },
    () => {
      assert.throws(() => assertRequiredEnv(), /only 7 characters/);
    }
  );

  // The threat is an offline search against a value we chose, so length is the
  // whole defence. One character under the bar still fails.
  withEnv(
    { NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@x/db', JWT_SECRET: 'y'.repeat(31) },
    () => assert.throws(() => assertRequiredEnv(), /at least 32/)
  );

  withEnv(
    { NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@x/db', JWT_SECRET: 'y'.repeat(32) },
    () => assertRequiredEnv()
  );
});

test('a missing provider credential degrades the service, it does not stop it', () => {
  // This was fatal until it blocked four consecutive deploys — including the
  // deploy of the diagnostics endpoint that would have explained why. Without
  // these the service still serves auth, discovery, admin and the queues; it
  // simply cannot move money. Refusing to boot took down more than it protected.
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

  try {
    withEnv(
      {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@x/db',
        JWT_SECRET: GOOD_SECRET,
        WEB_ORIGIN: 'https://example.test',
        ESCROWPAY_API_KEY: undefined,
        ESCROWPAY_WEBHOOK_SECRET: undefined,
      },
      () => assertRequiredEnv()
    );
  } finally {
    console.warn = original;
  }

  const banner = warnings.join('\n');
  assert.match(banner, /DEGRADED/);
  assert.match(banner, /ESCROWPAY_API_KEY/);
  assert.match(banner, /ESCROWPAY_WEBHOOK_SECRET/);
  assert.match(banner, /Starting anyway/);
});

test('an API key without a webhook secret refuses to start', () => {
  // THE ONE ARRANGEMENT WHERE MONEY CAN BE LOST rather than merely not moved.
  // The key lets a client fund an escrow; without the secret the provider's
  // notification is rejected as unsigned, and their money sits against a
  // booking that stays PENDING_PAYMENT forever, with nobody told.
  withEnv(
    {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@x/db',
      JWT_SECRET: GOOD_SECRET,
      WEB_ORIGIN: 'https://example.test',
      ESCROWPAY_API_KEY: 'sk_test_abc',
      ESCROWPAY_WEBHOOK_SECRET: undefined,
    },
    () => {
      assert.throws(
        () => assertRequiredEnv(),
        (err: ThrownError) => {
          assert.match(err.message, /ESCROWPAY_API_KEY is set but ESCROWPAY_WEBHOOK_SECRET is not/);
          assert.match(err.message, /never record it/);
          assert.match(err.message, /PENDING_PAYMENT/);
          return true;
        }
      );
    }
  );

  // Neither set is incomplete, not dangerous: nothing can be funded at all.
  withEnv(
    {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@x/db',
      JWT_SECRET: GOOD_SECRET,
      WEB_ORIGIN: 'https://example.test',
      ESCROWPAY_API_KEY: undefined,
      ESCROWPAY_WEBHOOK_SECRET: undefined,
    },
    () => {
      const original = console.warn;
      console.warn = () => {};
      try {
        assertRequiredEnv();
      } finally {
        console.warn = original;
      }
    }
  );

  // And a webhook secret without a key is harmless — nothing can be funded, so
  // no delivery can arrive to be rejected.
  withEnv(
    {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@x/db',
      JWT_SECRET: GOOD_SECRET,
      WEB_ORIGIN: 'https://example.test',
      ESCROWPAY_API_KEY: undefined,
      ESCROWPAY_WEBHOOK_SECRET: 'whsec_abc',
    },
    () => {
      const original = console.warn;
      console.warn = () => {};
      try {
        assertRequiredEnv();
      } finally {
        console.warn = original;
      }
    }
  );
});

test('REDIS_URL is required only where this process runs workers', () => {
  const base = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://u:p@x/db',
    JWT_SECRET: GOOD_SECRET,
    REDIS_URL: undefined,
  };

  withEnv(base, () => assertRequiredEnv({ runsWorkers: false }));
  withEnv(base, () => {
    assert.throws(() => assertRequiredEnv({ runsWorkers: true }), /REDIS_URL/);
  });
});

test('a missing WEB_ORIGIN warns but does not stop the service', () => {
  // A wrong origin breaks the browser client while the API, the webhooks and
  // the workers stay entirely functional. Refusing to boot would take down more
  // than it protects.
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

  try {
    withEnv(
      {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@x/db',
        JWT_SECRET: GOOD_SECRET,
        ESCROWPAY_API_KEY: 'sk_test_x',
        ESCROWPAY_WEBHOOK_SECRET: 'whsec_x',
        WEB_ORIGIN: undefined,
      },
      () => assertRequiredEnv()
    );
  } finally {
    console.warn = original;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WEB_ORIGIN is not set/);
  assert.match(warnings[0], /blocked by the browser/);
});

test('a worker is not warned about CORS, which it has nothing to do with', () => {
  // Noise in exactly the log someone reads when a job has gone wrong.
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

  try {
    withEnv(
      {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@x/db',
        JWT_SECRET: GOOD_SECRET,
        REDIS_URL: 'redis://localhost:6379',
        ESCROWPAY_API_KEY: 'sk_test_x',
        ESCROWPAY_WEBHOOK_SECRET: 'whsec_x',
        WEB_ORIGIN: undefined,
      },
      () => assertRequiredEnv({ runsWorkers: true, servesHttp: false })
    );
  } finally {
    console.warn = original;
  }

  assert.deepEqual(warnings, []);
});

test('the API refuses to start, rather than 500ing the first person who logs in', () => {
  // The end-to-end property. An empty JWT_SECRET rather than an absent one,
  // because Prisma loads apps/backend/.env when it initialises and dotenv never
  // overwrites a variable that is already present — including an empty one.
  // On a deployed host there is no .env at all and the variable is simply
  // missing, which this same check catches.
  try {
    execFileSync('node', ['src/index.ts'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, JWT_SECRET: '', PORT: '4399' },
      stdio: 'pipe',
      timeout: 20000,
    });
    assert.fail('the server started without a signing key');
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer };
    assert.equal(e.status, 1, 'it must exit non-zero so the deploy fails');

    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    assert.match(output, /Refusing to start/);
    assert.match(output, /JWT_SECRET is not set/);
    assert.doesNotMatch(output, /listening on/, 'it bound a port anyway');
  }
});

test('the worker refuses too, and asks for what a worker actually needs', () => {
  try {
    execFileSync('node', ['src/worker.ts'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, REDIS_URL: '', JWT_SECRET: GOOD_SECRET },
      stdio: 'pipe',
      timeout: 20000,
    });
    assert.fail('the worker started without Redis');
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer };
    assert.equal(e.status, 1);

    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    assert.match(output, /REDIS_URL/);
    assert.match(output, /auto-release never run/);
    assert.doesNotMatch(output, /listening on queues/);
  }
});

test('a missing provider credential says where to find one', () => {
  // The person reading a failed deploy at 2am is often not the person who knows
  // where the secret lives. A real failure of this exact check said only what
  // was absent, which sent the operator back to the source.
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

  try {
    withEnv(
      {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@x/db',
        JWT_SECRET: GOOD_SECRET,
        WEB_ORIGIN: 'https://example.test',
        ESCROWPAY_API_KEY: undefined,
        ESCROWPAY_WEBHOOK_SECRET: undefined,
      },
      () => assertRequiredEnv()
    );
  } finally {
    console.warn = original;
  }

  const banner = warnings.join('\n');
  assert.match(banner, /EscrowPay dashboard/);
  // The two are different secrets and get confused for one another.
  assert.match(banner, /sk_test_/);
  assert.match(banner, /whsec_/);
  assert.match(banner, /Not the API key/);
});

test('every requirement that can be obtained says how', () => {
  for (const requirement of [...ALWAYS, ...FOR_WORKERS, ...CAPABILITIES]) {
    assert.ok(
      requirement.how && requirement.how.length > 10,
      `${requirement.name} gives no way to obtain a value`
    );
  }
});

test('the requirements say what breaks, not merely that they are required', () => {
  // A configuration error is read by someone under time pressure who did not
  // write the code. "X is required" sends them to the source; "logins return
  // 500" sends them to the fix.
  for (const requirement of [...ALWAYS, ...CAPABILITIES]) {
    assert.ok(requirement.why.length > 20, `${requirement.name}: "${requirement.why}"`);
    assert.doesNotMatch(
      requirement.why,
      /^is required|^required|^must be set/i,
      `${requirement.name} restates the problem instead of naming the consequence`
    );
  }
});
