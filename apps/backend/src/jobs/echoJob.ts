/**
 * The trivial job #5 asks for: log and exit, proving scheduling works end to
 * end before any business logic depends on it.
 *
 * It stays after #25 and #38 land. When auto-release misbehaves on a deployed
 * host, the first question is whether the queue is running at all, and having a
 * job with no dependencies to answer that is worth keeping.
 */

const QUEUE_NAME = 'maintenance';
const JOB_NAME = 'echo';

/**
 * Deliberately able to fail on demand, so the retry and dead-letter paths can
 * be exercised without inventing a broken business job.
 */
async function process(job: import('bullmq').Job) {
  if (job.data?.failTimes && job.attemptsMade < job.data.failTimes) {
    throw new Error(`echo: deliberate failure ${job.attemptsMade + 1} of ${job.data.failTimes}`);
  }

  const message = job.data?.message ?? 'echo';
  console.log(`[echo] ${message} (job ${job.id}, attempt ${job.attemptsMade + 1})`);

  return { message, ranAt: new Date().toISOString(), attempt: job.attemptsMade + 1 };
}

module.exports = { QUEUE_NAME, JOB_NAME, process };
