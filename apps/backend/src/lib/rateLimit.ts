/**
 * Rate limiting — issue #41.
 *
 * Counters live in REDIS, not in process memory. The web service can run as more
 * than one instance, and a per-process counter would give an attacker one full
 * allowance per instance — a limit that weakens every time we scale.
 *
 * Fixed windows: a counter per key per window, incremented and expired
 * atomically. Simpler than a sliding window and adequate here — the point is to
 * make brute force and abuse expensive, not to meter fairly to the second.
 *
 * IT FAILS OPEN. If Redis is unreachable the request goes through and the
 * outage is logged loudly. Failing closed would turn a Redis blip into nobody
 * being able to sign in or book, which is the same coupling #38 refused for
 * notifications. That is safe for every endpoint this guards: none of them is
 * protected ONLY by the limit — passwords are bcrypt-hashed, check-in codes are
 * 30^8 and single-use, and verification is cached per person.
 */

const IORedis = require('ioredis');
const { AppError } = require('./errors.ts');

let client: any = null;

/** The longest a request waits on Redis before failing open. */
const REDIS_WAIT_MS = Number(process.env.RATE_LIMIT_REDIS_WAIT_MS) || 750;
let warnedAt = 0;

function redis() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      // QUEUE while connecting. This was `false` at first, which made every
      // command sent before the connection was ready fail at once — so the
      // limiter failed open and DID NOT COUNT those attempts. Every deploy and
      // every reconnect handed out a free allowance. A dead Redis is handled by
      // the timeout in `hit` instead, which keeps failing open fast.
      enableOfflineQueue: true,
      lazyConnect: false,
    });
    client.on('error', () => {}); // reported per request below, not per socket event
  }
  return client;
}

/** Isolated per test run, the same way queue names are. */
const PREFIX = `${process.env.QUEUE_PREFIX || 'artist-escrow'}:ratelimit`;

type LimitOptions = {
  /** Names the limit in the key and the log. */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
  /** What is being counted. Return null to skip limiting this request. */
  key: (req: any) => string | null;
  /** What the person is told. Written for them, like every other error here. */
  message: string;
};

/**
 * One counter step. Exported so tests can exercise the arithmetic without
 * going through HTTP.
 */
async function hit(name: string, key: string, limit: number, windowSeconds: number) {
  const r = redis();
  if (!r) return { allowed: true, remaining: limit, retryAfter: 0, degraded: true };

  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const redisKey = `${PREFIX}:${name}:${key}:${window}`;

  // INCR and EXPIRE together, so a key never outlives its window — a counter
  // left without an expiry would lock its owner out until someone noticed.
  //
  // Bounded: a request never waits more than this on Redis. Long enough to ride
  // out a connection still being established, short enough that an outage
  // costs a sign-in half a second rather than a timeout.
  const exec = r.multi().incr(redisKey).expire(redisKey, windowSeconds + 1).exec();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no reply within ${REDIS_WAIT_MS}ms`)), REDIS_WAIT_MS);
  });
  let replies: any;
  try {
    replies = await Promise.race([exec, timeout]);
  } finally {
    clearTimeout(timer);
  }
  const [[, count]] = replies;

  const retryAfter = (window + 1) * windowSeconds - Math.floor(Date.now() / 1000);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfter, degraded: false };
}

/**
 * Whether limiting is switched off — for the test suite and the e2e run only.
 *
 * Both create dozens of accounts from one address in seconds, and Redis keeps
 * counters between runs, so a limited suite fails on its second run within the
 * hour. The limiter's own behaviour is tested in rateLimit.test.ts with limits
 * on.
 *
 * THE SWITCH DOES NOTHING ON RENDER. A variable left set in a deploy would
 * otherwise remove brute-force protection from sign-in without anyone
 * noticing, so on the host the limits are on whatever it says.
 */
function limitsDisabled(): boolean {
  if (process.env.RATE_LIMITS !== 'off') return false;
  if (process.env.RENDER === 'true') {
    if (!warnedIgnoringSwitch) {
      warnedIgnoringSwitch = true;
      console.error('[rate-limit] RATE_LIMITS=off is set on Render and is being IGNORED — limits stay on.');
    }
    return false;
  }
  return true;
}
let warnedIgnoringSwitch = false;

function rateLimit({ name, limit, windowSeconds, key, message }: LimitOptions) {
  return async (req: any, res: any, next: any) => {
    if (limitsDisabled()) return next();

    const k = key(req);
    if (!k) return next();

    try {
      const result = await hit(name, k, limit, windowSeconds);
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfter));
        return next(new AppError(429, message));
      }
      return next();
    } catch (err) {
      // Failing open, loudly — but not once per request during an outage,
      // which would bury every other log line.
      if (Date.now() - warnedAt > 60_000) {
        warnedAt = Date.now();
        console.error(`[rate-limit] Redis unavailable, NOT LIMITING: ${(err as Error).message}`);
      }
      return next();
    }
  };
}

/** The caller's address. Correct only because `trust proxy` is set — see app.ts. */
const ip = (req: any) => String(req.ip ?? 'unknown');

/** Normalised so `Ada@x.com` and `ada@x.com ` share one allowance. */
const email = (req: any) => String(req.body?.email ?? '').trim().toLowerCase();

const LIMITS = {
  /**
   * Password guessing. Per address AND account, so one attacker cannot lock a
   * victim out from elsewhere by exhausting a per-account limit alone.
   */
  login: rateLimit({
    name: 'login',
    limit: 10,
    windowSeconds: 15 * 60,
    key: (req) => `${ip(req)}:${email(req)}`,
    message: 'Too many sign-in attempts. Wait a few minutes and try again.',
  }),

  /** Account farming. */
  register: rateLimit({
    name: 'register',
    limit: 5,
    windowSeconds: 60 * 60,
    key: ip,
    message: 'Too many accounts created from this connection. Try again in an hour.',
  }),

  /**
   * Identity verification COSTS ₦50 PER ATTEMPT at the provider. Without a limit,
   * a script with one valid token is a way to spend our money.
   */
  verification: rateLimit({
    name: 'verification',
    limit: 5,
    windowSeconds: 24 * 60 * 60,
    key: (req) => req.user?.id ?? null,
    message: 'Too many verification attempts today. Contact support if your details keep being rejected.',
  }),

  /** Booking spam against artists. */
  createBooking: rateLimit({
    name: 'create-booking',
    limit: 20,
    windowSeconds: 60 * 60,
    key: (req) => req.user?.id ?? null,
    message: 'Too many booking requests in the last hour. Try again later.',
  }),

  /**
   * Code guessing, per artist AND booking. The code space makes guessing
   * hopeless already (30^8), so this is a second line, not the first.
   */
  checkIn: rateLimit({
    name: 'check-in',
    limit: 10,
    windowSeconds: 10 * 60,
    key: (req) => (req.user?.id ? `${req.user.id}:${req.params.id}` : null),
    message: 'Too many check-in attempts for this booking. Wait ten minutes, then check the code with the client.',
  }),
};

async function closeRateLimit() {
  if (client) {
    await client.quit().catch(() => {});
    client = null;
  }
}

module.exports = { rateLimit, hit, LIMITS, closeRateLimit, limitsDisabled, PREFIX };
