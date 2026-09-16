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

const { assertRequiredEnv, ALWAYS, IN_PRODUCTION } = require('../src/lib/requiredEnv.ts');

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
        for (const name of [
          'DATABASE_URL',
          'JWT_SECRET',
          'ESCROWPAY_API_KEY',
          'ESCROWPAY_WEBHOOK_SECRET',
        ]) {
          assert.match(message, new RegExp(name), `${name} was not reported`);
        }
        assert.match(message, /4 configuration problems/);
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

test('provider credentials are required in production and optional outside it', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@x/db', JWT_SECRET: GOOD_SECRET };

  withEnv(
    { ...base, NODE_ENV: 'development', ESCROWPAY_API_KEY: undefined, ESCROWPAY_WEBHOOK_SECRET: undefined },
    () => assertRequiredEnv()
  );

  withEnv(
    {
      ...base,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://example.test',
      ESCROWPAY_API_KEY: undefined,
      ESCROWPAY_WEBHOOK_SECRET: undefined,
    },
    () => {
      assert.throws(() => assertRequiredEnv(), /ESCROWPAY_API_KEY/);
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

test('the requirements say what breaks, not merely that they are required', () => {
  // A configuration error is read by someone under time pressure who did not
  // write the code. "X is required" sends them to the source; "logins return
  // 500" sends them to the fix.
  for (const requirement of [...ALWAYS, ...IN_PRODUCTION]) {
    assert.ok(requirement.why.length > 20, `${requirement.name}: "${requirement.why}"`);
    assert.doesNotMatch(
      requirement.why,
      /^is required|^required|^must be set/i,
      `${requirement.name} restates the problem instead of naming the consequence`
    );
  }
});
