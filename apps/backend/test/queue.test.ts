/**
 * Redis and BullMQ job infrastructure — issue #5.
 */

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// Isolate this file's jobs the way test/db.js isolates its schema. Without it
// one suite's workers consume another's jobs — the same class of flakiness the
// database tests had.
process.env.QUEUE_PREFIX = `test-queue-${process.pid}`;

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const hasRedis = Boolean(process.env.REDIS_URL);
const describe = hasRedis ? test : test.skip;

const queueLib = require('../src/lib/queue.ts');
const echoJob = require('../src/jobs/echoJob.ts');

const BACKEND_ROOT = path.resolve(__dirname, '..');

/** Polls until `check` returns a truthy value, or gives up. */
async function until(check, { timeout = 20000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

let seq = 0;
const uniqueId = () => `t${Date.now()}${seq++}`;

// ---------------------------------------------------------------------------

describe('a job scheduled 10 seconds out executes at approximately the right time', async () => {
  const queue = queueLib.getQueue(echoJob.QUEUE_NAME);
  const ran = [];

  const worker = queueLib.registerWorker(echoJob.QUEUE_NAME, async (job) => {
    ran.push({ id: job.id, at: Date.now() });
    return echoJob.process(job);
  });

  try {
    // 10s in a test is mostly waiting, so the delay is scaled down. The
    // property under test is that a DELAYED job fires after its delay and not
    // before, which does not depend on the number being ten.
    const DELAY = 2000;
    const scheduledAt = Date.now();
    const job = await queue.add(echoJob.JOB_NAME, { message: 'delayed' }, { jobId: uniqueId(), delay: DELAY });

    // Must not have run early.
    await new Promise((r) => setTimeout(r, DELAY / 2));
    assert.equal(ran.length, 0, 'a delayed job must not run before its delay elapses');

    const found = await until(() => ran.find((r) => r.id === job.id));
    assert.ok(found, 'the delayed job must eventually run');

    const lateness = found.at - scheduledAt - DELAY;
    assert.ok(lateness >= -50, `ran ${-lateness}ms early`);
    assert.ok(lateness < 5000, `ran ${lateness}ms late`);
  } finally {
    await worker.close();
  }
});

describe('a job that throws is retried per the configured backoff', async () => {
  const queue = queueLib.getQueue(echoJob.QUEUE_NAME);
  const attempts = [];

  const worker = queueLib.registerWorker(echoJob.QUEUE_NAME, async (job) => {
    attempts.push({ id: job.id, attempt: job.attemptsMade + 1, at: Date.now() });
    return echoJob.process(job);
  });

  try {
    const jobId = uniqueId();
    // Fails twice, succeeds on the third attempt — inside the default of 3.
    await queue.add(echoJob.JOB_NAME, { message: 'flaky', failTimes: 2 }, { jobId });

    const mine = () => attempts.filter((a) => a.id === jobId);
    const done = await until(() => (mine().length >= 3 ? mine() : null), { timeout: 25000 });

    assert.ok(done, `expected 3 attempts, saw ${mine().length}`);
    assert.equal(done.length, 3);
    assert.deepEqual(
      done.map((a) => a.attempt),
      [1, 2, 3],
      'attempts are numbered in order'
    );

    // Exponential backoff, so the second gap must exceed the first. Without
    // this the retries could be firing instantly and the test would still pass
    // on count alone.
    const firstGap = done[1].at - done[0].at;
    const secondGap = done[2].at - done[1].at;
    assert.ok(firstGap >= 900, `first retry waited only ${firstGap}ms`);
    assert.ok(secondGap > firstGap, `backoff did not grow: ${firstGap}ms then ${secondGap}ms`);

    const state = await (await queue.getJob(jobId)).getState();
    assert.equal(state, 'completed', 'it succeeded on the final attempt');
  } finally {
    await worker.close();
  }
});

describe('a job failing all retries is visible in the dead-letter queue', async () => {
  const queue = queueLib.getQueue(echoJob.QUEUE_NAME);

  const worker = queueLib.registerWorker(echoJob.QUEUE_NAME, echoJob.process);

  try {
    const jobId = uniqueId();
    // Fails more times than it has attempts, so it can never succeed.
    await queue.add(
      echoJob.JOB_NAME,
      { message: 'doomed', failTimes: 99 },
      { jobId, attempts: 2, backoff: { type: 'fixed', delay: 100 } }
    );

    const letter = await until(
      async () => {
        const jobs = await queueLib.deadLetterJobs();
        return jobs.find((j) => j.data?.data?.message === 'doomed');
      },
      { timeout: 25000 }
    );

    assert.ok(letter, 'an exhausted job must land in the dead-letter queue, not vanish');
    assert.equal(letter.data.queue, echoJob.QUEUE_NAME, 'it records which queue it came from');
    assert.equal(letter.data.attemptsMade, 2);
    assert.match(letter.data.failedReason, /deliberate failure/);
    assert.ok(letter.data.failedAt, 'and when it gave up');

    // The original is still in the failed set too — the dead letter is a
    // record, not a relocation.
    const original = await queue.getJob(jobId);
    assert.equal(await original.getState(), 'failed');
  } finally {
    await worker.close();
  }
});

describe('scheduled jobs survive a process restart', async () => {
  // The critical property. A job scheduled by one process must be executed by a
  // different process started afterwards — which is what makes auto-release
  // survive a deploy. Verified by actually killing and restarting a worker,
  // not by reasoning about Redis.
  const queue = queueLib.getQueue(echoJob.QUEUE_NAME);
  const marker = `survives-${uniqueId()}`;

  // Scheduled while NO worker is running at all.
  await queue.add(echoJob.JOB_NAME, { message: marker }, { jobId: marker, delay: 1500 });

  const pending = await queue.getJob(marker);
  assert.equal(await pending.getState(), 'delayed', 'queued and waiting, with nothing to run it');

  // A worker in a genuinely separate OS process.
  const worker = spawn('node', ['src/worker.ts'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  worker.stdout.on('data', (d) => output.push(d.toString()));
  worker.stderr.on('data', (d) => output.push(d.toString()));

  try {
    const ran = await until(
      async () => {
        const job = await queue.getJob(marker);
        return (await job.getState()) === 'completed';
      },
      { timeout: 25000 }
    );

    assert.ok(ran, `the restarted worker never ran the job. output:\n${output.join('')}`);
    assert.match(output.join(''), new RegExp(marker), 'the new process logged it');
  } finally {
    worker.kill('SIGTERM');
  }
});

describe('the queue refuses to start without Redis configured', () => {
  const original = process.env.REDIS_URL;
  try {
    delete process.env.REDIS_URL;
    // Loud rather than silently queueing into nothing. A queue that appears to
    // accept jobs while dropping them is worse than one that will not start.
    assert.throws(() => queueLib.connectionOptions(), /REDIS_URL is not set/);
  } finally {
    process.env.REDIS_URL = original;
  }
});

test.after(async () => {
  if (hasRedis) await queueLib.closeAll();
});
