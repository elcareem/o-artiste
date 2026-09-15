/**
 * Server entry point.
 *
 * Loads environment configuration, then binds. Application assembly lives in
 * app.js so it can be exercised by tests without a listening socket.
 */

require('dotenv').config();

const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 4000;

const app = createApp();

/**
 * Optionally run the job workers inside this process — issue #5.
 *
 * THE SEPARATE WORKER PROCESS IS STILL THE RIGHT ANSWER, and `npm run
 * start:worker` remains the production shape. This flag exists because Render's
 * free plan allows 750 instance-hours a month and one always-awake service uses
 * about 730, so a second free service cannot be added alongside it (see
 * DEPLOYMENT-CHECKLIST.md, #2).
 *
 * Without it, the queues on the deployed host have no consumer at all: webhook
 * retries (#20) sit `FAILED` with nothing to pick them up, and auto-release
 * (#25) never fires. An in-process worker is a real consumer, not a stand-in.
 *
 * Running both this and a dedicated worker service is safe — BullMQ claims jobs
 * atomically, so two consumers share the queue rather than double-processing —
 * but the flag should be turned off once a dedicated worker exists, so job load
 * stops competing with request handling.
 */
const workers = process.env.RUN_WORKERS_IN_WEB === 'true' ? startInProcessWorkers() : null;

const server = app.listen(PORT, () => {
  console.log(`[backend] listening on :${PORT}`);
  console.log(`[backend] cors origin ${process.env.WEB_ORIGIN || 'http://localhost:3000'}`);
  console.log(`[backend] in-process workers ${workers ? 'ON' : 'off'}`);
});

function startInProcessWorkers() {
  try {
    const { startWorkers } = require('./worker');
    return startWorkers();
  } catch (err) {
    // A queue that will not start must not take the API down with it: the API
    // still accepts webhooks and records them, which keeps them replayable.
    // Loud, because nothing is draining the queues until this is fixed.
    console.error(`[backend] IN-PROCESS WORKERS FAILED TO START: ${err.message}`);
    return null;
  }
}

// Render and most process hosts send SIGTERM on deploy and on shutdown. Closing
// the server lets in-flight requests finish instead of being cut mid-response —
// which matters here, because a request cut mid-flight can be one that has
// already instructed a money movement.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[backend] ${signal} received, closing`);
    server.close(async () => {
      // Same reasoning for jobs: closeAll() waits for active jobs rather than
      // killing them, and an active job may have already instructed a payment.
      if (workers) await workers.stop().catch(() => {});
      process.exit(0);
    });
  });
}

module.exports = { server };
