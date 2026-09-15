/**
 * Per-file database isolation for the test suite.
 *
 * WHY THIS EXISTS
 *
 * Every test file previously shared one database, and twice that produced a
 * failure where the code was correct and the test was wrong: a seed test
 * asserting "exactly one SUPER_ADMIN" counted users created by the auth suite,
 * and a commission test asserting a prior rate of 500 read a 700 written
 * moments earlier by a neighbouring case.
 *
 * Scoping each assertion works but depends on remembering forever, and the
 * stakes rise from here: #19's headline assertion is that a booking's ledger
 * entries sum to zero, which is worthless if another test can add rows to the
 * same table. A financial suite that fails intermittently is a suite people
 * stop believing.
 *
 * HOW IT WORKS
 *
 * Each test file gets its own PostgreSQL schema inside the same database.
 * `DATABASE_URL` is rewritten with `?schema=test_<name>` BEFORE the Prisma
 * singleton is constructed, so every module that later requires it — routes,
 * services, middleware — transparently talks to that schema.
 *
 * Call this FIRST in a test file, above any require of application code:
 *
 *   const { prisma, hasDatabase } = require('./db.ts')('auth');
 *   const { createApp } = require('../src/app.ts');   // now bound to test_auth
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BACKEND_ROOT = path.resolve(__dirname, '..');

require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });

const BASE_URL = process.env.DATABASE_URL;

/**
 * @param {string} name Short identifier, unique per test file.
 */
module.exports = function useTestSchema(name) {
  if (!BASE_URL) {
    // No database configured: the caller skips its database-dependent tests.
    return { prisma: null, hasDatabase: false, schema: null };
  }

  const schema = `test_${name}`;
  const url = new URL(BASE_URL);
  url.searchParams.set('schema', schema);

  // Prisma defaults to `cpus * 2 + 1` connections per client — 17 here. The
  // test files run in parallel, each with its own client, plus subprocesses for
  // the seed: comfortably past PostgreSQL's 100-connection ceiling.
  //
  // The failure mode is genuinely confusing rather than obvious: an interactive
  // transaction acquires a connection, completes one statement, then waits
  // forever for a second connection that the pool cannot give it. It shows up
  // as `idle in transaction` and eventually a transaction timeout, which reads
  // like a deadlock rather than exhaustion.
  //
  // A test client needs very few connections, so cap it.
  url.searchParams.set('connection_limit', '5');

  // Must happen before the Prisma singleton is constructed.
  process.env.DATABASE_URL = url.toString();

  // `db push` rather than `migrate deploy`: it creates the schema and applies
  // the current model state in one step, without needing migration history in
  // a throwaway schema. The migrations themselves are verified against a real
  // database in #4.
  execFileSync(
    'npx',
    ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: BACKEND_ROOT, env: process.env, stdio: 'pipe' }
  );

  const prisma = require('../src/lib/prisma.ts');

  return { prisma, hasDatabase: true, schema, ready: truncate(prisma, schema) };
};

/**
 * Empties every table in the schema.
 *
 * Schemas persist between runs — `db push` creates structure, not a clean
 * slate. Without this, a file that asserts "this schema starts empty" passes
 * the first time and fails every time after, which is the worst kind of test:
 * one that only fails on someone else's machine.
 *
 * TRUNCATE rather than per-table deletes so foreign keys do not dictate the
 * order, and RESTART IDENTITY so sequences do not drift between runs.
 */
async function truncate(prisma, schema) {
  const tables = await prisma.$queryRawUnsafe(
    `select tablename from pg_tables where schemaname = $1`,
    schema
  );

  const names = tables
    .map((t: any) => t.tablename)
    .filter((name) => name !== '_prisma_migrations')
    .map((name) => `"${schema}"."${name}"`);

  if (names.length === 0) return;

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${names.join(', ')} RESTART IDENTITY CASCADE`
  );
}
