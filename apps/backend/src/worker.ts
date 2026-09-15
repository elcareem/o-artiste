/**
 * Worker entry point — separate from the API process.
 *
 * Separate on purpose. Render's free web service sleeps when idle, and a
 * sleeping process runs no jobs: auto-release fires 48–72h after an event,
 * exactly when nobody is making requests. A keepalive covers that for testing,
 * but production should run this as its own always-on service, and that move is
 * a configuration change rather than a rewrite precisely because the entry
 * point already exists.
 *
 *   npm run start:worker
 */

require('dotenv').config();

const { registerWorker, closeAll } = require('./lib/queue.ts');
const echoJob = require('./jobs/echoJob.ts');
const webhookRetryJob = require('./jobs/webhookRetryJob.ts');

function startWorkers() {
  registerWorker(echoJob.QUEUE_NAME, echoJob.process);
  registerWorker(webhookRetryJob.QUEUE_NAME, webhookRetryJob.process);
  console.log('[worker] listening on queues: maintenance, webhooks');
  return { stop: closeAll };
}

if (require.main === module) {
  startWorkers();

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      console.log(`[worker] ${signal} received, finishing in-flight jobs`);
      // close() waits for active jobs rather than killing them. A job cut
      // mid-flight on this system may be one that has already instructed a
      // money movement.
      await closeAll();
      process.exit(0);
    });
  }
}

module.exports = { startWorkers };
