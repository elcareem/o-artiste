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
    how: 'Render → the Postgres instance → Connections. Internal from a Render service, External from a laptop.',
  },
  {
    name: 'JWT_SECRET',
    why: 'Logins return 500 — the API cannot sign a session token.',
    minLength: 32,
    how: `generate one: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
  },
];

/** Only when this process runs job workers. */
const FOR_WORKERS: EnvRequirement[] = [
  {
    name: 'REDIS_URL',
    why: 'BullMQ cannot start, so webhook retries and auto-release never run.',
    how: 'Render → the Key Value instance → Connections. It must use the noeviction policy, or queued jobs are silently dropped.',
  },
];

/**
 * Capabilities, not prerequisites.
 *
 * WITHOUT THESE THE SERVICE STILL WORKS — it just cannot move money. Auth,
 * artist discovery, admin and the queues are unaffected, so refusing to boot
 * takes down more than it protects.
 *
 * This was fatal until it blocked four consecutive deploys, including the
 * deploy of the diagnostics endpoint that would have explained why. A check
 * that prevents shipping the tool which diagnoses the check is worse than the
 * problem it guards against — and that problem, a missing value being
 * invisible, is now solved better: by the banner below, by `/health` reporting
 * which build is live, and by `GET /admin/diagnostics`.
 *
 * The one genuinely unsafe arrangement is still fatal — see `assertCoherent`.
 */
const CAPABILITIES: EnvRequirement[] = [
  {
    name: 'ESCROWPAY_API_KEY',
    why: 'No booking can be funded, released or refunded.',
    how: 'EscrowPay dashboard → API keys. sk_test_… is the sandbox book, sk_live_… is real money.',
  },
  {
    name: 'ESCROWPAY_WEBHOOK_SECRET',
    why: 'Every inbound webhook is rejected as unsigned, so funding is never recorded.',
    how: 'whsec_… shown once when the webhook endpoint was created. Not the API key.',
  },
];

/**
 * The combination that is unsafe, as opposed to merely incomplete.
 *
 * An API key WITHOUT a webhook secret is the one arrangement where money can be
 * LOST rather than simply not moved: a client funds an escrow — which the key
 * makes possible — the provider notifies us, we reject the delivery as
 * unsigned, and their money sits in escrow against a booking that stays
 * `PENDING_PAYMENT` forever. Nobody is told, on either side.
 *
 * With neither set, nothing can be funded at all, so nothing is at risk. That
 * is an incomplete deployment, not a dangerous one, and the difference is worth
 * the extra check.
 */
function assertCoherent(): void {
  if (process.env.ESCROWPAY_API_KEY && !process.env.ESCROWPAY_WEBHOOK_SECRET) {
    throw new Error(
      'Refusing to start. ESCROWPAY_API_KEY is set but ESCROWPAY_WEBHOOK_SECRET is not.\n\n' +
        "  That combination can take a client's money and never record it: the key lets an\n" +
        "  escrow be funded, and without the secret the provider's notification is rejected\n" +
        '  as unsigned, leaving the booking in PENDING_PAYMENT with the money held.\n\n' +
        '  Set ESCROWPAY_WEBHOOK_SECRET (whsec_…, shown once when the webhook endpoint was\n' +
        '  created), or unset ESCROWPAY_API_KEY to run without the money path at all.'
    );
  }
}

/**
 * Throws with everything that is wrong, or returns silently.
 *
 * @param runsWorkers whether this process will start job workers
 */
function assertRequiredEnv({
  runsWorkers = false,
  servesHttp = true,
}: { runsWorkers?: boolean; servesHttp?: boolean } = {}): void {
  // Prerequisites only. A capability gap is reported loudly below and does not
  // stop the process.
  const required = [...ALWAYS, ...(runsWorkers ? FOR_WORKERS : [])];

  const problems: string[] = [];

  for (const { name, why, minLength, how } of required) {
    const value = process.env[name];
    const hint = how ? `\n      ${how}` : '';

    if (!value) {
      problems.push(`  ${name} is not set — ${why}${hint}`);
      continue;
    }

    // A six-character signing key is not meaningfully better than none: the
    // threat is someone minting their own SUPER_ADMIN token, and that is an
    // offline search against a value we chose.
    if (minLength && value.length < minLength) {
      problems.push(
        `  ${name} is only ${value.length} characters — at least ${minLength} are needed.${hint}`
      );
    }
  }

  // Not fatal. A wrong origin breaks the browser client while leaving the API,
  // the webhooks and the workers entirely functional, so refusing to boot would
  // take down more than it protects.
  //
  // Only for a process that answers requests. A worker serves no HTTP and has
  // no CORS, so warning it about an origin is noise in exactly the log someone
  // reads when a job has gone wrong.
  if (servesHttp && process.env.NODE_ENV === 'production' && !process.env.WEB_ORIGIN) {
    console.warn(
      '[backend] WARNING: WEB_ORIGIN is not set, so CORS defaults to http://localhost:3000.' +
        ' The deployed web app will be blocked by the browser.'
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start. ${problems.length} configuration problem${problems.length > 1 ? 's' : ''}:\n\n` +
        problems.join('\n') +
        '\n\nSet these on the service and redeploy. See DEPLOYMENT-CHECKLIST.md.'
    );
  }

  // Unsafe rather than incomplete. This one does stop the process.
  assertCoherent();

  // Capability gaps: loud, specific, and impossible to read as routine — but
  // not fatal. `GET /admin/diagnostics` reports the same thing on demand, and
  // `/health` says which build is answering.
  const missing = CAPABILITIES.filter((c) => !process.env[c.name]);
  if (missing.length > 0) {
    console.warn('');
    console.warn('  ───────────────────────────────────────────────────────────────');
    console.warn(`  DEGRADED — ${missing.length} capabilit${missing.length === 1 ? 'y' : 'ies'} unavailable`);
    console.warn('');
    for (const { name, why, how } of missing) {
      console.warn(`    ${name} is not set — ${why}`);
      if (how) console.warn(`      ${how}`);
    }
    console.warn('');
    console.warn('  Starting anyway. Everything except the money path works.');
    console.warn('  ───────────────────────────────────────────────────────────────');
    console.warn('');
  }
}

module.exports = { assertRequiredEnv, assertCoherent, ALWAYS, FOR_WORKERS, CAPABILITIES };
