/**
 * Every role-restricted route refuses every role it excludes — issue #41.
 *
 * #41: "Super-admin fields are permission-checked server-side, not merely
 * hidden." A hand-picked list of routes proves that only for the routes someone
 * remembered. This walks the routers the app actually mounts, finds every route
 * carrying a role guard, and calls each one as each excluded role — so an
 * endpoint added next year is covered the day it is added.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('permsweep');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');

const describe = hasDatabase ? test : test.skip;

const ROLES = ['CLIENT', 'ARTIST', 'ADMIN', 'SUPER_ADMIN'] as const;
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

type Guarded = { method: string; path: string; roles: string[] };

/** Every route on every router the app mounts, with the roles its guard allows. */
function guardedRoutes(): Guarded[] {
  const routers = ['auth', 'admin', 'verification', 'artists', 'bookings', 'queue', 'webhooks'].map(
    (name) => require(`../src/routes/${name}.ts`).router
  );

  const found: Guarded[] = [];
  for (const router of routers) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const guard = layer.route.stack.find((s: any) => Array.isArray(s.handle?.roles));
      if (!guard) continue;
      for (const method of Object.keys(layer.route.methods)) {
        found.push({ method: method.toUpperCase(), path: layer.route.path, roles: [...guard.handle.roles] });
      }
    }
  }
  return found;
}

/** A concrete URL for a route pattern. Ids that do not exist are fine — the guard runs first. */
const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, 'clsweep0000000000000000000');

describe('every role guard refuses every role it excludes', async () => {
  const routes = guardedRoutes();

  // The sweep found something, and found the routes we know about. A sweep that
  // silently matches nothing would pass for ever.
  assert.ok(routes.length >= 30, `only ${routes.length} guarded routes found — the walk is broken`);
  for (const known of ['PUT /admin/config/commission', 'POST /admin/disputes/:id/resolve', 'POST /bookings/:id/check-in']) {
    assert.ok(
      routes.some((r) => `${r.method} ${r.path}` === known),
      `${known} was not found by the sweep`
    );
  }

  // One user per role.
  const { hashPassword } = require('../src/lib/auth.ts');
  const tokens: Record<string, string> = {};
  for (const role of ROLES) {
    const n = `${Date.now()}${role}`;
    const user = await prisma.user.create({
      data: {
        email: `sweep-${n}@example.test`.toLowerCase(),
        phone: `+23483${String(Math.abs(hashCode(n))).slice(-8).padStart(8, '0')}`,
        passwordHash: await hashPassword(PASSWORD),
        role,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    });
    const res = await fetch(`${server.url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: PASSWORD }),
    });
    const loginBody = (await res.json()) as any;
    if (!loginBody.token) throw new Error(`login as ${role} failed: ${res.status} ${JSON.stringify(loginBody)}`);
    tokens[role] = loginBody.token;
  }

  const failures: string[] = [];
  let checked = 0;

  for (const route of routes) {
    for (const role of ROLES.filter((r) => !route.roles.includes(r))) {
      const res = await fetch(`${server.url}${concrete(route.path)}`, {
        method: route.method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[role]}` },
        ...(route.method === 'GET' ? {} : { body: '{}' }),
      });
      checked++;
      if (res.status !== 403) {
        failures.push(`${route.method} ${route.path} as ${role} → ${res.status} (allowed: ${route.roles.join(', ')})`);
      }
    }
  }

  assert.deepEqual(failures, [], `role guards that let an excluded role through:\n${failures.join('\n')}`);
  assert.ok(checked > 50, `only ${checked} role/route pairs were exercised`);
});

describe('the super-admin-only routes are the ones that change what every booking pays', async () => {
  // Not just "refused for ADMIN" — this pins WHICH routes are super-admin, so a
  // commission or tier endpoint quietly widened to ADMIN fails here even though
  // the sweep above would happily confirm its new, weaker guard.
  const superOnly = guardedRoutes()
    .filter((r) => r.roles.length === 1 && r.roles[0] === 'SUPER_ADMIN')
    .map((r) => `${r.method} ${r.path}`)
    .sort();

  for (const mustBe of [
    'PUT /admin/config/commission',
    'PUT /admin/config/cancellation-tiers',
    'PUT /admin/config/auto-release',
    'PUT /admin/config/strikes',
    'PUT /admin/config/enforcement',
    'PUT /admin/config/reputation',
  ]) {
    assert.ok(superOnly.includes(mustBe), `${mustBe} is no longer SUPER_ADMIN-only: ${superOnly.join(', ')}`);
  }
});

function hashCode(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

// ---------------------------------------------------------------------------
// Shadowed routes — the bug class this sweep turned up
// ---------------------------------------------------------------------------

/** Every route in the order the app mounts them. */
function allRoutesInMountOrder(): { method: string; path: string; router: string }[] {
  const order = ['auth', 'admin', 'verification', 'artists', 'bookings', 'queue', 'webhooks'];
  const out: { method: string; path: string; router: string }[] = [];
  for (const name of order) {
    for (const layer of require(`../src/routes/${name}.ts`).router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: layer.route.path, router: name });
      }
    }
  }
  return out;
}

/** Whether `pattern` (which may contain :params) matches the literal `path`. */
function matches(pattern: string, path: string): boolean {
  const a = pattern.split('/');
  const b = path.split('/');
  return a.length === b.length && a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
}

describe('no route is shadowed by a parameter route registered before it', async () => {
  // Express matches in order. `/artists/:id` registered before `/artists/banks`
  // answered every request for the bank list with "Artist not found." — for
  // months, invisibly, because nothing called it through the router.
  const routes = allRoutesInMountOrder();
  const shadowed: string[] = [];

  routes.forEach((later, i) => {
    if (later.path.includes(':')) return; // only literal routes can be shadowed this way
    const earlier = routes
      .slice(0, i)
      .find((r) => r.method === later.method && r.path.includes(':') && matches(r.path, later.path));
    if (earlier) {
      shadowed.push(`${later.method} ${later.path} (${later.router}) is unreachable behind ${earlier.method} ${earlier.path} (${earlier.router})`);
    }
  });

  assert.deepEqual(shadowed, [], shadowed.join('\n'));
});

describe('an artist can actually load the bank list', async () => {
  const escrowpay = require('../src/lib/escrowpay.ts');
  const original = escrowpay.listBanks;
  escrowpay.listBanks = async () => ({ banks: [{ bank_code: '000013', bank_name: 'GTBANK PLC' }] });

  try {
    const { hashPassword } = require('../src/lib/auth.ts');
    const n = Date.now();
    const user = await prisma.user.create({
      data: {
        email: `banks${n}@example.test`,
        phone: `+23484${String(n).slice(-8)}`,
        passwordHash: await hashPassword(PASSWORD),
        role: 'ARTIST',
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    });
    const login = (await (
      await fetch(`${server.url}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: user.email, password: PASSWORD }),
      })
    ).json()) as any;

    const res = await fetch(`${server.url}/artists/banks`, { headers: { authorization: `Bearer ${login.token}` } });
    const body = (await res.json()) as any;
    assert.equal(res.status, 200, `the bank list answered ${res.status}: ${body.error}`);
    assert.ok(JSON.stringify(body).includes('000013'));
  } finally {
    escrowpay.listBanks = original;
  }
});

describe('every route written in a router file is registered when it loads', async () => {
  // Found while fixing the shadowed bank list: a route moved by cutting at the
  // wrong `});` ended up NESTED inside another handler. It compiled, every other
  // sweep here passed, and GET and PUT /artists/:id were only registered once
  // someone had loaded the bank list. Counting declarations against what the
  // router actually holds catches any route that is not registered at load.
  const fs = require('node:fs');
  const path = require('node:path');
  const problems: string[] = [];

  for (const name of ['auth', 'admin', 'verification', 'artists', 'bookings', 'queue', 'webhooks']) {
    const file = path.resolve(__dirname, `../src/routes/${name}.ts`);
    const source = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    const declared = (source.match(/\brouter\.(get|post|put|patch|delete)\(/g) ?? []).length;

    // Counted in a FRESH PROCESS. In this one, an earlier test has already
    // called /artists/banks — which, with the nested bug, runs the handler and
    // registers the hidden routes, so the counts would match and the check would
    // pass. The first version of this test did exactly that.
    const { execFileSync } = require('node:child_process');
    const registered = Number(
      execFileSync(
        process.execPath,
        ['-e', `console.log(require(${JSON.stringify(file)}).router.stack.filter((l) => l.route).length)`],
        { cwd: path.resolve(__dirname, '..'), env: { ...process.env, RATE_LIMITS: 'off' }, encoding: 'utf8' }
      ).trim().split('\n').pop()
    );
    if (declared !== registered) {
      problems.push(`${name}.ts declares ${declared} routes but ${registered} are registered at load`);
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});
