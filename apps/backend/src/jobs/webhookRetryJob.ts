/**
 * Webhook processing retry — issue #20.
 *
 * A webhook is never silently dropped. When processing throws, the event is
 * already recorded with its error, and this job re-runs it from the STORED
 * BYTES — so a retry replays exactly what the provider sent, not a
 * reconstruction of it.
 *
 * The provider is told 200 at the time of the failure rather than a 5xx,
 * because a provider redelivering on top of this job would put two workers on
 * the same event. Once the event id is in our table, retrying is our job.
 *
 * Exhausted attempts land in the dead-letter queue (#5) rather than ageing out
 * of the failed set, because the event that vanished might be the one funding a
 * booking.
 */

const QUEUE_NAME = 'webhooks';
const JOB_NAME = 'webhook-retry';

async function process(job: import('bullmq').Job) {
  const { providerEventId } = job.data;
  if (!providerEventId) throw new Error('webhook-retry job has no providerEventId');

  // Required lazily: the worker process loads this module at startup, and the
  // service pulls in Prisma and the provider client.
  const webhookService = require('../services/webhookService.ts');

  const result = await webhookService.reprocess(providerEventId);

  // Throwing is what tells BullMQ to back off and try again. Returning a
  // "retry_queued" outcome quietly would mark the job complete while the event
  // is still unprocessed.
  if (result.outcome === 'retry_queued') {
    throw new Error(`webhook ${providerEventId} still failing`);
  }

  console.log(`[webhook-retry] ${providerEventId} → ${result.outcome} (attempt ${job.attemptsMade + 1})`);
  return result;
}

module.exports = { QUEUE_NAME, JOB_NAME, process };
