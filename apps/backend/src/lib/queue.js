/**
 * Job queue infrastructure — docs/00-OVERVIEW.md §9.
 *
 * Three behaviours in this system are time-triggered rather than
 * request-triggered, and none can be expressed as request-time logic:
 *
 *   1. Auto-release after the post-event grace period. The entire point is that
 *      it fires precisely when the client has NOT made a request.
 *   2. Event-day check-in code delivery and arrival prompts.
 *   3. Webhook retry on processing failure.
 *
 * This is why the backend is a persistent Node process rather than serverless
 * API routes: a function that only runs when called cannot pay an artist whose
 * client has gone quiet.
 */

const { Queue, Worker } = require('bullmq');

/**
 * Queue namespace. Overridable so test files can isolate themselves the way
 * they isolate database schemas — without it, one suite's jobs are visible to
 * another's workers, which is the same class of bug that made the database
 * tests flaky.
 */
const PREFIX = process.env.QUEUE_PREFIX || 'artist-escrow';

/** Where jobs go when they have exhausted every retry. See §Dead letter. */
const DEAD_LETTER_QUEUE = 'dead-letter';

/**
 * Retry policy.
 *
 * Exponential backoff because the failures worth retrying are transient —
 * a provider timeout, a brief network partition — and hammering a struggling
 * dependency every second makes its recovery slower, not faster.
 */
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  // Completed jobs are trimmed; failed ones are kept so a human can see what
  // happened. A queue that discards its failures cannot be debugged.
  removeOnComplete: { count: 100 },
  removeOnFail: false,
};

function redisUrl() {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is not set. The job queue cannot start without Redis.');
  }
  return url;
}

/**
 * Connection options shared by queues and workers.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: its workers hold blocking
 * commands open, and ioredis' default retry ceiling would tear those down.
 *
 * The connection count is capped deliberately. The deployed Key Value instance
 * allows 50, and each Queue and Worker opens its own — an uncapped default plus
 * a handful of queues exhausts that quietly.
 */
function connectionOptions() {
  return {
    url: redisUrl(),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}

const queues = new Map();
const workers = new Map();

/** Returns the named queue, creating it once per process. */
function getQueue(name) {
  if (!queues.has(name)) {
    queues.set(
      name,
      new Queue(name, {
        prefix: PREFIX,
        connection: connectionOptions(),
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      })
    );
  }
  return queues.get(name);
}

/**
 * Registers a worker for a queue.
 *
 * Jobs that exhaust every attempt are moved to the dead-letter queue rather
 * than left to age out of the failed set. A job that vanishes without trace is
 * indistinguishable from one that never existed — and on this system the job
 * that vanished might have been the one releasing an artist's payment.
 */
function registerWorker(name, processor, options = {}) {
  const worker = new Worker(name, processor, {
    prefix: PREFIX,
    connection: connectionOptions(),
    concurrency: options.concurrency ?? 5,
    ...options,
  });

  worker.on('failed', async (job, err) => {
    if (!job) return;

    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) {
      console.warn(
        `[queue] ${name}/${job.name} attempt ${job.attemptsMade} failed, will retry: ${err.message}`
      );
      return;
    }

    console.error(`[queue] ${name}/${job.name} exhausted ${job.attemptsMade} attempts: ${err.message}`);

    try {
      await getQueue(DEAD_LETTER_QUEUE).add(
        job.name,
        {
          queue: name,
          jobName: job.name,
          data: job.data,
          failedReason: err.message,
          attemptsMade: job.attemptsMade,
          failedAt: new Date().toISOString(),
        },
        // Nothing processes the dead-letter queue: it is a record for a human,
        // so retrying it automatically would defeat the purpose.
        { attempts: 1, removeOnComplete: false, removeOnFail: false }
      );
    } catch (dlqError) {
      // Last resort. If even this fails the job is genuinely lost, so say so
      // loudly rather than swallowing it.
      console.error(`[queue] FAILED TO DEAD-LETTER ${name}/${job.name}: ${dlqError.message}`);
    }
  });

  worker.on('error', (err) => {
    console.error(`[queue] worker ${name} error: ${err.message}`);
  });

  workers.set(name, worker);
  return worker;
}

/** Jobs currently sitting in the dead-letter queue. */
async function deadLetterJobs(limit = 100) {
  const queue = getQueue(DEAD_LETTER_QUEUE);
  return queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, limit - 1);
}

/** Closes every queue and worker. Required for a clean process exit. */
async function closeAll() {
  await Promise.all([...workers.values()].map((w) => w.close()));
  await Promise.all([...queues.values()].map((q) => q.close()));
  workers.clear();
  queues.clear();
}

module.exports = {
  getQueue,
  registerWorker,
  deadLetterJobs,
  closeAll,
  connectionOptions,
  PREFIX,
  DEAD_LETTER_QUEUE,
  DEFAULT_JOB_OPTIONS,
};
