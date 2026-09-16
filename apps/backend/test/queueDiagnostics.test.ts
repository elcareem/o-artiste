/**
 * Queue diagnostics — issue #5.
 *
 * `echoJob` exists so that "is the queue running at all?" has an answer with no
 * dependencies. On a deployed host that answer was a log line nobody could
 * reach, which left two of #5's acceptance criteria unverifiable. These
 * endpoints make it reachable, and this file is what proves the answer is real
 * rather than an echo of the request.
 */

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// Before anything requires lib/queue.ts.
// Unique per RUN, not merely per process: Redis keeps keys forever and the
// OS reuses pids, so a prefix of pid alone can land on a dead run's queue —
// including its job-id counter, which makes `getJob('1')` return a stranger.
process.env.QUEUE_PREFIX = `test-qdiag-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('queuediag');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const queueLib = require('../src/lib/queue.ts');
const echoJob = require('../src/jobs/echoJob.ts');
const { MAX_DELAY_MS } = require('../src/routes/queue.ts');

const hasRedis = Boolean(process.env.REDIS_URL);
const describe = hasDatabase && hasRedis ? test : test.skip;

const PASSWORD = 'correct horse battery staple';

let server: TestServer;

test.before(async () => {
  if (ready) await ready;
  server = await startServer(createApp());
});

test.after(async () => {
  if (server) await server.close();
  if (hasRedis) await queueLib.closeAll();
});

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

async function makeUser(role: UserRole) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  return prisma.user.create({
    data: {
      email: `qd${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
    },
  });
}

async function login(email: string) {
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return ((await res.json()) as any).token as string;
}

const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

async function until<T>(check: () => Promise<T> | T, timeout = 20000): Promise<T | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

// ---------------------------------------------------------------------------

describe('a scheduled echo job reports back as having actually run', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const scheduled = await call('POST', '/admin/queue/echo', token, {
    delayMs: 500,
    label: 'diagnostic test',
  });

  assert.equal(scheduled.status, 202);
  assert.ok(scheduled.body.job.id);
  assert.equal(scheduled.body.job.queue, echoJob.QUEUE_NAME);
  assert.equal(scheduled.body.job.delayMs, 500);

  const id = scheduled.body.job.id;

  // Before a worker exists it is delayed, not done. Without this the test
  // could pass against an endpoint that simply reported success.
  const pending = await call('GET', `/admin/queue/echo/${id}`, token);
  assert.equal(pending.status, 200);
  assert.ok(['delayed', 'waiting'].includes(pending.body.job.state), pending.body.job.state);
  assert.equal(pending.body.job.ranAt, null);

  const worker = queueLib.registerWorker(echoJob.QUEUE_NAME, echoJob.process);
  try {
    // Polls for `ranAt`, not for `state`. `ranAt` is generated INSIDE the
    // processor: a `completed` state proves the queue finished the job, while a
    // timestamp from the processor proves a worker executed it — which is the
    // question actually being asked on a deployed host. Waiting on the state
    // and then asserting the timestamp leaves a window between the two.
    const done = await until(async () => {
      const res = await call('GET', `/admin/queue/echo/${id}`, token);
      return res.body.job.ranAt ? res.body.job : null;
    });

    assert.ok(done, 'the job never reported having run');
    assert.equal(done!.state, 'completed');
    assert.ok(new Date(done!.ranAt).getTime() >= new Date(done!.scheduledAt).getTime() - 1000);
    assert.equal(done!.failedReason, null);
  } finally {
    await worker.close();
  }
});

describe('the delay is bounded, and its default is the figure #5 names', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const defaulted = await call('POST', '/admin/queue/echo', token, {});
  assert.equal(defaulted.status, 202);
  assert.equal(defaulted.body.job.delayMs, 10_000, "#5's criterion is ten seconds out");

  // NaN and Infinity are absent on purpose: JSON.stringify turns both into
  // null, so they can never arrive as themselves. Null is covered below.
  //
  // `true` and `[]` are here because `Number(true)` is 1 and `Number([])` is 0
  // — a bare Number() would read a boolean as a one-millisecond delay and an
  // array as "run now".
  for (const delayMs of [-1, MAX_DELAY_MS + 1, 'soon', true, [], {}]) {
    const res = await call('POST', '/admin/queue/echo', token, { delayMs });
    assert.equal(res.status, 400, `delayMs=${JSON.stringify(delayMs)} was accepted`);
    assert.match(res.body.error, /delayMs must be a number/);
  }

  // Nothing can be parked in the queue indefinitely.
  const atLimit = await call('POST', '/admin/queue/echo', token, { delayMs: MAX_DELAY_MS });
  assert.equal(atLimit.status, 202);
});

describe('the dead-letter queue is readable without shell access to the host', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const queue = queueLib.getQueue(echoJob.QUEUE_NAME);
  const worker = queueLib.registerWorker(echoJob.QUEUE_NAME, echoJob.process);
  const marker = `doomed-${uniq()}`;

  try {
    await queue.add(
      echoJob.JOB_NAME,
      { message: marker, failTimes: 99 },
      { jobId: marker, attempts: 2, backoff: { type: 'fixed', delay: 100 } }
    );

    const listed = await until(async () => {
      const res = await call('GET', '/admin/queue/dead-letter', token);
      return res.body.jobs?.some((j: any) => /deliberate failure/.test(j.failedReason ?? ''))
        ? res.body
        : null;
    }, 25000);

    assert.ok(listed, 'the exhausted job never appeared in the dead-letter listing');
    const entry = listed!.jobs.find((j: any) => /deliberate failure/.test(j.failedReason));
    assert.equal(entry.originalQueue, echoJob.QUEUE_NAME);
    assert.equal(entry.attemptsMade, 2);
    assert.ok(entry.failedAt);
  } finally {
    await worker.close();
  }
});

describe('an unknown job id is 404, not an empty success', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  const res = await call('GET', '/admin/queue/echo/does-not-exist', token);
  assert.equal(res.status, 404);
  assert.match(res.body.error, /no such job/i);
});

describe('the diagnostics are closed to everyone below ADMIN', async () => {
  const paths: [string, string][] = [
    ['POST', '/admin/queue/echo'],
    ['GET', '/admin/queue/echo/anything'],
    ['GET', '/admin/queue/dead-letter'],
  ];

  for (const role of ['CLIENT', 'ARTIST'] as UserRole[]) {
    const user = await makeUser(role);
    const token = await login(user.email);

    for (const [method, p] of paths) {
      const res = await call(method, p, token, method === 'POST' ? {} : undefined);
      assert.equal(res.status, 403, `${role} reached ${method} ${p}`);
    }
  }

  // And unauthenticated.
  for (const [method, p] of paths) {
    const res = await call(method, p, undefined, method === 'POST' ? {} : undefined);
    assert.equal(res.status, 401, `${method} ${p} answered without a token`);
  }
});

describe('SUPER_ADMIN reaches them too', async () => {
  const su = await makeUser('SUPER_ADMIN');
  const token = await login(su.email);

  const res = await call('GET', '/admin/queue/dead-letter', token);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.total, 'number');
});

describe('a queue or job name in the body cannot redirect the job', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  // The diagnostics are deliberately narrow: the only job they can schedule is
  // the one that logs and exits. An endpoint taking a queue name and a payload
  // would be a remote code path into the worker process, so these fields are
  // asserted to be inert rather than merely absent from the documentation.
  const res = await call('POST', '/admin/queue/echo', token, {
    delayMs: 0,
    queue: 'webhooks',
    queueName: 'notifications',
    name: 'webhook-retry',
    jobName: 'check-in-code',
    data: { providerEventId: 'WHEV_injected' },
    bookingId: 'bkg_injected',
  });

  assert.equal(res.status, 202);
  assert.equal(res.body.job.queue, echoJob.QUEUE_NAME);

  const job = await queueLib.getQueue(echoJob.QUEUE_NAME).getJob(res.body.job.id);
  assert.ok(job, 'the job did not land on the maintenance queue');
  assert.equal(job.name, echoJob.JOB_NAME);

  // And nothing from the body reached the payload beyond the label.
  assert.deepEqual(Object.keys(job.data).sort(), ['message', 'scheduledAt']);
  assert.equal(job.data.providerEventId, undefined);
  assert.equal(job.data.bookingId, undefined);
});

describe('an unspecified delay defaults rather than firing immediately', async () => {
  const admin = await makeUser('ADMIN');
  const token = await login(admin.email);

  // JSON.stringify turns NaN and Infinity into null, so a client whose delay
  // calculation failed sends null; an empty string is a blank form field.
  // Defaulting is right — zero would be a silent "run now" off a broken input.
  for (const delayMs of [null, '']) {
    const res = await call('POST', '/admin/queue/echo', token, { delayMs });
    assert.equal(res.status, 202, `delayMs=${JSON.stringify(delayMs)} was rejected`);
    assert.equal(res.body.job.delayMs, 10_000);
  }

  // A numeric string is still a number.
  const asString = await call('POST', '/admin/queue/echo', token, { delayMs: '500' });
  assert.equal(asString.status, 202);
  assert.equal(asString.body.job.delayMs, 500);
});
