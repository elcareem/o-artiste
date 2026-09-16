/**
 * Startup configuration check — fail at boot, not at the first user.
 *
 * WHY THIS EXISTS. `JWT_SECRET` was unset on the deployed API for four days and
 * nothing said so. The guard in `lib/auth.ts` throws on first use, which is
 * correct — defaulting to a guessable key would let anyone mint a SUPER_ADMIN
 * token — but "first use" turned out to be a real person's first login,
 * answered with a 500. `/health` returned `ok` throughout, the deploy was green,
 * and the API had never been able to issue a single token.
 *
 * A missing secret is not a runtime condition. It is a deployment that is not
 * finished, and it should look like one: the process refuses to start, the
 * deploy fails, and the previous version keeps serving.
 *
 * EVERY missing variable is reported at once. Finding them one restart at a
 * time is three deploys to learn three names.
 *
 * This runs in the entry points only — `index.ts` and `worker.ts` — never in
 * `createApp()`, so tests can assemble the app without a full environment.
 */

/** Without these, nothing works. */
const ALWAYS: EnvRequirement[] = [
  {
    name: 'DATABASE_URL',
    why: 'Prisma has nothing to connect to.',
  },
  {
    name: 'JWT_SECRET',
    why: 'Logins return 500 — the API cannot sign a session token.',
    minLength: 32,
    generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
  },
];

/** Only when this process runs job workers. */
const FOR_WORKERS: EnvRequirement[] = [
  {
    name: 'REDIS_URL',
    why: 'BullMQ cannot start, so webhook retries and auto-release never run.',
  },
];

/**
 * Only in production. Absent locally these merely disable provider calls; in
 * production they mean bookings cannot be funded and webhooks cannot be
 * verified — which is indistinguishable, from the outside, from an outage.
 */
const IN_PRODUCTION: EnvRequirement[] = [
  {
    name: 'ESCROWPAY_API_KEY',
    why: 'No booking can be funded, released or refunded.',
  },
  {
    name: 'ESCROWPAY_WEBHOOK_SECRET',
    why: 'Every inbound webhook is rejected as unsigned, so funding is never recorded.',
  },
];

/**
 * Throws with everything that is wrong, or returns silently.
 *
 * @param runsWorkers whether this process will start job workers
 */
function assertRequiredEnv({ runsWorkers = false }: { runsWorkers?: boolean } = {}): void {
  const required = [
    ...ALWAYS,
    ...(runsWorkers ? FOR_WORKERS : []),
    ...(process.env.NODE_ENV === 'production' ? IN_PRODUCTION : []),
  ];

  const problems: string[] = [];

  for (const { name, why, minLength, generate } of required) {
    const value = process.env[name];

    if (!value) {
      problems.push(`  ${name} is not set — ${why}${generate ? `\n      generate one: ${generate}` : ''}`);
      continue;
    }

    // A six-character signing key is not meaningfully better than none: the
    // threat is someone minting their own SUPER_ADMIN token, and that is an
    // offline search against a value we chose.
    if (minLength && value.length < minLength) {
      problems.push(
        `  ${name} is only ${value.length} characters — at least ${minLength} are needed.` +
          (generate ? `\n      generate one: ${generate}` : '')
      );
    }
  }

  // Not fatal. A wrong origin breaks the browser client while leaving the API,
  // the webhooks and the workers entirely functional, so refusing to boot would
  // take down more than it protects.
  if (process.env.NODE_ENV === 'production' && !process.env.WEB_ORIGIN) {
    console.warn(
      '[backend] WARNING: WEB_ORIGIN is not set, so CORS defaults to http://localhost:3000.' +
        ' The deployed web app will be blocked by the browser.'
    );
  }

  if (problems.length === 0) return;

  throw new Error(
    `Refusing to start. ${problems.length} configuration problem${problems.length > 1 ? 's' : ''}:\n\n` +
      problems.join('\n') +
      '\n\nSet these on the service and redeploy. See DEPLOYMENT-CHECKLIST.md.'
  );
}

module.exports = { assertRequiredEnv, ALWAYS, FOR_WORKERS, IN_PRODUCTION };
