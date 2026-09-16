/**
 * What is actually running — issue #41.
 *
 * WHY THIS EXISTS. `JWT_SECRET` was unset for four days and the provider
 * credentials had never been set at all, and in both cases `/health` answered
 * `ok`. A health check that reports only that a process is listening will
 * report `ok` for a service that cannot log anyone in, cannot take a payment,
 * and cannot verify a webhook.
 *
 * Separately, and just as often: after a deploy there was no way to tell from
 * outside which commit was serving. "Did that merge actually ship?" was
 * answered by poking at routes and inferring.
 *
 * So there are two endpoints, and the split is deliberate:
 *
 *   GET /health              public. Alive, and WHICH BUILD.
 *   GET /admin/diagnostics   ADMIN. Whether the dependencies actually answer.
 *
 * Dependency state is admin-only because "the database is down" is information
 * an attacker can use to pick a moment. Which build is running is not — it is
 * an opaque hash against a private repository, and being able to verify a
 * deploy from outside is worth more than the little it gives away.
 */

const BOOTED_AT = new Date();

/**
 * The commit this process was built from.
 *
 * `RENDER_GIT_COMMIT` is injected by Render automatically. `GIT_COMMIT` is the
 * generic fallback for any other host; null locally, where the answer is
 * whatever is checked out and the question is not interesting.
 */
function commit(): string | null {
  const sha = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null;
  return sha ? sha.slice(0, 7) : null;
}

function version(): string {
  try {
    return require('../../package.json').version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The public payload. Deliberately says nothing about dependencies. */
function healthPayload() {
  return {
    status: 'ok',
    version: version(),
    commit: commit(),
    startedAt: BOOTED_AT.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - BOOTED_AT.getTime()) / 1000),
  };
}

module.exports = { healthPayload, commit, version, BOOTED_AT };
