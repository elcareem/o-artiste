/**
 * Webhook receipt and processing — docs/03-ESCROW-FLOW.md §6, issue #20.
 *
 * THE HIGHEST-SEVERITY PATH IN THE SYSTEM. A delivery processed twice is a
 * double release. Providers retry on timeout, on non-2xx, and sometimes on a
 * slow 2xx, so duplicate delivery is expected behaviour rather than an edge
 * case — the provider's own guide states deliveries are at-least-once.
 *
 * The order of operations is fixed and every step's position is load-bearing:
 *
 *   1. Read the RAW body — bytes exactly as received
 *   2. Verify the signature against those bytes   → invalid: 401, write nothing
 *   3. CLAIM the event id in WebhookEvent         → already claimed: 200, stop
 *   4. Only now: process
 *   5. Mark processed
 *
 * Step 2 writes nothing on failure because recording unverified events would
 * let anyone who can reach the endpoint pre-poison the idempotency table with
 * event ids that would then be ignored when they legitimately arrived.
 *
 * Step 3 is an atomic INSERT on a unique column, not a read-then-write. Two
 * concurrent deliveries of the same event — which is exactly what a provider
 * retrying a slow response produces — would both pass a `findUnique` check and
 * both proceed. The unique constraint is the only thing that actually decides.
 */

const prisma = require('../lib/prisma.ts');
const escrowpay = require('../lib/escrowpay.ts');
const bookingService = require('./bookingService.ts');
const ledger = require('./ledgerService.ts');
const checkInService = require('./checkInService.ts');
// Safe to require at module load: it opens no Redis connection until `schedule`
// is called, which is what keeps the webhook endpoint answering when the queue
// is the thing that is down.
const checkInCodeJob = require('../jobs/checkInCodeJob.ts');
const autoReleaseJob = require('../jobs/autoReleaseJob.ts');

const EVENT_ID_HEADER = 'escrowpay-event-id';
const DELIVERY_ID_HEADER = 'escrowpay-delivery-id';
const SIGNATURE_HEADER = 'escrowpay-signature';

/**
 * The provider's closed set of event types
 * (docs/provider/ESCROWPAY-API-MAP.md §2), asserted against that table by test
 * so the two cannot drift.
 *
 * #20's issue text names `escrow.funded`, `escrow.released`, `escrow.refunded`
 * and `escrow.disputed`. NONE OF THOSE EXIST. They were taken from the
 * marketing page; the real names were read off the provider's webhooks guide at
 * #17. A handler written against the issue's names would have acknowledged
 * every real delivery as an unknown type and funded nothing.
 */
const KNOWN_EVENT_TYPES = new Set([
  'transaction.created', 'transaction.funding_started', 'transaction.partially_funded',
  'transaction.funded', 'transaction.expired', 'transaction.cancelled',
  'charge.pending', 'charge.succeeded', 'charge.failed', 'charge.reversed',
  'payment_account.active', 'payment_account.funded', 'payment_account.expired',
  'milestone.funded', 'milestone.release_scheduled', 'milestone.released', 'milestone.refunded',
  'release.created', 'release.scheduled', 'release.completed', 'release.failed',
  'refund.created', 'refund.processing', 'refund.completed', 'refund.failed',
  'refund.requires_action',
  'wallet.credited', 'wallet.debited',
  'payout.created', 'payout.processing', 'payout.completed', 'payout.failed',
  'payout.reversed',
  'business.verification_updated',
  'administrative_hold.applied', 'administrative_hold.released',
  'reconciliation.issue_detected',
]);

/**
 * Receives one delivery. Returns the status to send and why.
 *
 * Never throws for a processing failure: a processing failure is recorded and
 * queued, and the provider is told 200, because a non-2xx makes them redeliver
 * an event we have already durably recorded. Retrying is OUR job once the event
 * is in the table.
 */
async function receive({
  rawBody,
  headers = {},
  queueRetry = enqueueRetry,
}: {
  rawBody: Buffer | string;
  headers?: Record<string, string | string[] | undefined>;
  queueRetry?: (providerEventId: string) => Promise<void>;
}): Promise<WebhookOutcome> {
  const signatureHeader = headers[SIGNATURE_HEADER] as string | undefined;

  // ── Step 2: verify before anything is written ──────────────────────────
  const verdict = escrowpay.verifyWebhookSignature({ rawBody, signatureHeader });
  if (!verdict.valid) {
    // The reason goes to our logs, never to the response. Telling a caller
    // whether their signature was malformed, stale or simply wrong helps them
    // iterate towards a valid forgery.
    console.warn(`[webhook] rejected: ${verdict.reason}`);
    return { status: 401, body: { error: 'Invalid signature.' }, outcome: 'rejected' };
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    // Signed by the provider yet not JSON. Loud, because it means the contract
    // changed under us.
    console.error('[webhook] signed payload is not JSON');
    return { status: 400, body: { error: 'Request body is not valid JSON.' }, outcome: 'malformed' };
  }

  // The header is authoritative — the guide is explicit that a retry keeps the
  // event id and gets a new DELIVERY id. Deduplicating on the delivery id would
  // treat every retry as a fresh event, which is the exact double-processing
  // failure this endpoint exists to prevent.
  const providerEventId = (headers[EVENT_ID_HEADER] as string | undefined) || payload?.id;
  if (!providerEventId) {
    console.error('[webhook] signed delivery carries no event id — cannot deduplicate');
    return { status: 400, body: { error: 'Missing event id.' }, outcome: 'malformed' };
  }

  const eventType = payload?.type ?? 'unknown';

  // ── Step 3: claim the id atomically ────────────────────────────────────
  let event: WebhookEventRow;
  try {
    event = await prisma.webhookEvent.create({
      data: {
        providerEventId,
        eventType,
        rawBody: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody),
        processingStatus: 'RECEIVED',
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Already claimed. Stop here — no state change, no ledger entry, no
      // second look at the payload.
      console.log(`[webhook] duplicate ${eventType} ${providerEventId}, ignored`);
      return { status: 200, body: { received: true, duplicate: true }, outcome: 'duplicate' };
    }
    throw err;
  }

  // ── Steps 4 and 5 ──────────────────────────────────────────────────────
  return runHandler({ event, payload, queueRetry });
}

/**
 * Dispatches one recorded event and records the outcome.
 *
 * Shared by the live path and the retry job, so a retry takes exactly the same
 * code path as the original delivery rather than a parallel one that can drift.
 */
async function runHandler({
  event,
  payload,
  queueRetry = enqueueRetry,
}: {
  event: WebhookEventRow;
  payload: WebhookPayload;
  queueRetry?: (providerEventId: string) => Promise<void>;
}): Promise<WebhookOutcome> {
  const eventType = event.eventType;

  try {
    const handler = HANDLERS[eventType as keyof typeof HANDLERS] as WebhookHandler | undefined;

    if (!handler) {
      // Acknowledged, not rejected. A non-2xx tells the provider to retry, and
      // retrying an event we will never understand produces nothing but noise.
      // The distinction between "not in the provider's documented set" and
      // "documented but nothing for us to do" is kept, because the first means
      // the contract moved and the second is routine.
      const known = KNOWN_EVENT_TYPES.has(eventType);
      console.log(
        known
          ? `[webhook] ${eventType} acknowledged, no action required`
          : `[webhook] UNKNOWN event type ${eventType} — provider contract may have changed`
      );
      await markProcessed(event.id, known ? 'no action required' : 'unknown event type');
      return {
        status: 200,
        body: { received: true },
        outcome: known ? 'acknowledged' : 'unknown_type',
      };
    }

    const result = await handler(payload);
    await markProcessed(event.id, result?.note);
    return { status: 200, body: { received: true }, outcome: 'processed', result };
  } catch (err) {
    // A webhook is NEVER silently dropped. The event row already exists, so the
    // failure is visible and replayable rather than lost.
    console.error(`[webhook] processing ${eventType} failed: ${(err as Error).message}`);

    const updated = await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        processingStatus: 'FAILED',
        attempts: { increment: 1 },
        lastError: String((err as Error).message).slice(0, 500),
      },
    });

    await queueRetry(updated.providerEventId);

    // 200, deliberately. The provider redelivering on top of our own retry
    // would have two workers racing on the same event.
    return { status: 200, body: { received: true }, outcome: 'retry_queued' };
  }
}

/** Re-runs a recorded event from its stored bytes. Used by the retry job. */
async function reprocess(
  providerEventId: string,
  { queueRetry = noopQueue }: { queueRetry?: (id: string) => Promise<void> } = {}
): Promise<WebhookOutcome> {
  const event = await prisma.webhookEvent.findUnique({ where: { providerEventId } });
  if (!event) throw new Error(`No webhook event recorded for ${providerEventId}`);

  if (event.processingStatus === 'PROCESSED') {
    return { status: 200, body: { received: true, duplicate: true }, outcome: 'duplicate' };
  }

  const payload = JSON.parse(event.rawBody);
  return runHandler({ event, payload, queueRetry });
}

function markProcessed(id: string, note?: string | null) {
  return prisma.webhookEvent.update({
    where: { id },
    data: {
      processingStatus: 'PROCESSED',
      processedAt: new Date(),
      lastError: note ?? null,
    },
  });
}

// ── Handlers ─────────────────────────────────────────────────────────────────
//
// EVERY HANDLER IS INDIVIDUALLY IDEMPOTENT, even though the event-id claim
// already blocks duplicate deliveries. The retry job re-runs an event whose
// first attempt may have committed its state change and then failed to mark the
// event processed. The claim does not protect against that; the handler must.

/**
 * `transaction.funded` — the client's money has arrived.
 *
 * THE WEBHOOK IS A SIGNAL TO RECONCILE, NOT THE SOURCE OF TRUTH. The provider's
 * guide directs confirming with `GET /transactions/{id}` after a payment event,
 * and that is what happens here: authoritative state is read back, and only
 * then is anything written. It also means an out-of-order or stale delivery
 * cannot fund a booking the provider no longer considers funded.
 */
async function handleTransactionFunded(payload: WebhookPayload): Promise<WebhookHandlerResult> {
  const booking = await bookingForEscrow(payload);
  if (!booking) return { note: 'no booking for this escrow' };

  if (booking.state === 'FUNDED_HELD') {
    return { note: 'already funded' };
  }

  const transaction = await escrowpay.getEscrow(booking.escrowId);
  const fundedMinor = Number(transaction?.funded_minor ?? 0);

  // `funding_mode: "exact"` is set at creation, so the provider should not
  // report funded on an underpayment — but trusting that and being wrong means
  // an artist performs for money that never arrived. Checked here too.
  if (fundedMinor < booking.amountKobo) {
    throw new Error(
      `Provider reported funded but funded_minor ${fundedMinor} is short of ${booking.amountKobo}`
    );
  }

  // The check-in code is issued INSIDE the funding transaction (#22). It is the
  // artist's only route to payment, so a booking that is funded without one is
  // a booking nobody can complete — that must not be a state the database can
  // hold, not even briefly.
  await prisma.$transaction(async (tx: PrismaTx) => {
    await bookingService.transition({ bookingId: booking.id, to: 'FUNDED_HELD', client: tx });
    await ledger.recordFunding(tx, booking);
    await checkInService.issueForBooking(tx, booking);
  });

  // Queued after the commit, never inside it: a job that fired against a
  // transaction that then rolled back would text a client a code we do not
  // have. `schedule` swallows its own failures for the same reason the code is
  // issued transactionally — the money movement must not depend on Redis.
  await checkInCodeJob.schedule(booking);

  // Auto-release (#25), scheduled now because funding is the moment the event
  // becomes certain. It fires months from now if nobody responds — and only if
  // a check-in was recorded by then, which is re-checked when it wakes.
  await autoReleaseJob.schedule(booking);

  console.log(`[webhook] booking ${booking.id} funded, ${fundedMinor} kobo held`);
  return { note: 'funded', bookingId: booking.id };
}

/**
 * `transaction.partially_funded` — an underpayment.
 *
 * MUST NOT fund the booking. It still has to be handled rather than ignored:
 * the client believes they have paid, and the gap is something a human needs to
 * see. #21 shows the shortfall; the booking stays in `PENDING_PAYMENT`.
 */
async function handlePartiallyFunded(payload: WebhookPayload): Promise<WebhookHandlerResult> {
  const booking = await bookingForEscrow(payload);
  if (!booking) return { note: 'no booking for this escrow' };

  console.warn(
    `[webhook] booking ${booking.id} PARTIALLY funded — expected ${booking.amountKobo} kobo, staying in ${booking.state}`
  );
  return { note: 'partial funding, booking not advanced' };
}

/**
 * `transaction.expired` — the funding deadline passed.
 *
 * The escrow is dead but the booking is not: the client can still be given a
 * fresh instruction. It stays in `PENDING_PAYMENT` rather than being cancelled
 * out from under them on a provider timer.
 */
async function handleTransactionExpired(payload: WebhookPayload): Promise<WebhookHandlerResult> {
  const booking = await bookingForEscrow(payload);
  if (!booking) return { note: 'no booking for this escrow' };

  console.warn(`[webhook] escrow for booking ${booking.id} expired unfunded`);
  return { note: 'escrow expired, booking left in PENDING_PAYMENT' };
}

/** `transaction.cancelled` — the escrow was cancelled before funding. */
async function handleTransactionCancelled(payload: WebhookPayload): Promise<WebhookHandlerResult> {
  const booking = await bookingForEscrow(payload);
  if (!booking) return { note: 'no booking for this escrow' };

  if (booking.state === 'CANCELLED') return { note: 'already cancelled' };
  if (!bookingService.canTransition(booking.state, 'CANCELLED')) {
    // A cancelled escrow under a booking that has moved past funding is a
    // genuine mismatch between their records and ours. Recorded loudly rather
    // than forced through.
    console.error(
      `[webhook] escrow cancelled but booking ${booking.id} is ${booking.state} — reconciliation needed`
    );
    return { note: `escrow cancelled while booking is ${booking.state}` };
  }

  await bookingService.transition({ bookingId: booking.id, to: 'CANCELLED' });
  return { note: 'cancelled', bookingId: booking.id };
}

/**
 * `release.completed` / `refund.completed` — CONFIRMATION of something we
 * instructed, never the instruction itself.
 *
 * Releases and refunds are instructed by `escrowService` at #26–#28 under the
 * `manual_only` policies forced on us. Until a booking has been instructed into
 * `RELEASED` or `REFUNDED` there is nothing for this event to confirm, and
 * arriving at one anyway means their records and ours disagree — which is worth
 * recording rather than acting on.
 */
function confirmationHandler(expectedState: BookingState): WebhookHandler {
  return async (payload: WebhookPayload) => {
    const booking = await bookingForEscrow(payload);
    if (!booking) return { note: 'no booking for this escrow' };

    if (booking.state === expectedState) {
      return { note: `confirmed ${expectedState.toLowerCase()}`, bookingId: booking.id };
    }

    console.error(
      `[webhook] provider reports ${expectedState.toLowerCase()} for booking ${booking.id}, which is ${booking.state} — reconciliation needed`
    );
    return { note: `unconfirmed: booking is ${booking.state}, provider says ${expectedState}` };
  };
}

/**
 * `release.failed` / `refund.failed` / `payout.failed` — MONEY DID NOT MOVE.
 *
 * These are not optional. A handler that listened only for the happy events
 * would leave a booking marked `RELEASED` with nothing delivered, and the
 * artist chasing a payment the system believes it made. There is a `…/retry`
 * operation on each; #26 owns invoking it. This makes the failure loud and
 * recorded.
 */
function failureHandler(what: string): WebhookHandler {
  return async (payload: WebhookPayload) => {
    const booking = await bookingForEscrow(payload);
    const where = booking ? `booking ${booking.id} (${booking.state})` : `escrow ${objectId(payload)}`;
    console.error(`[webhook] ${what} FAILED for ${where} — money did not move`);
    return { note: `${what} failed`, bookingId: booking?.id };
  };
}

/**
 * `payout.completed` — the artist's bank actually has the money.
 *
 * Distinct from `release.completed`, which only means funds left escrow. Under
 * the `manual` payout preference those are genuinely different moments, and the
 * booking is not advanced here: `RELEASED` already describes our side.
 */
async function handlePayoutCompleted(payload: WebhookPayload): Promise<WebhookHandlerResult> {
  const booking = await bookingForEscrow(payload);
  if (!booking) return { note: 'no booking for this escrow' };

  console.log(`[webhook] payout reached the artist for booking ${booking.id}`);
  return { note: 'payout completed', bookingId: booking.id };
}

/** `reconciliation.issue_detected` — the provider thinks our books disagree. */
async function handleReconciliationIssue(payload: WebhookPayload): Promise<WebhookHandlerResult> {
  console.error(
    `[webhook] PROVIDER REPORTS A RECONCILIATION ISSUE on ${objectId(payload)} — needs a human`
  );
  return { note: 'reconciliation issue reported by provider' };
}

const HANDLERS: Record<string, WebhookHandler> = {
  'transaction.funded': handleTransactionFunded,
  'transaction.partially_funded': handlePartiallyFunded,
  'transaction.expired': handleTransactionExpired,
  'transaction.cancelled': handleTransactionCancelled,
  'release.completed': confirmationHandler('RELEASED'),
  'refund.completed': confirmationHandler('REFUNDED'),
  'payout.completed': handlePayoutCompleted,
  'release.failed': failureHandler('release'),
  'refund.failed': failureHandler('refund'),
  'payout.failed': failureHandler('payout'),
  'reconciliation.issue_detected': handleReconciliationIssue,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function objectId(payload: WebhookPayload): string | null {
  return payload?.object_id ?? payload?.data?.transaction_id ?? null;
}

async function bookingForEscrow(payload: WebhookPayload): Promise<BookingRow | null> {
  const escrowId = objectId(payload);
  if (!escrowId) return null;

  const booking = await prisma.booking.findFirst({ where: { escrowId } });
  if (!booking) {
    // Not an error. It is the shape of a delivery for an escrow belonging to a
    // different environment pointed at the same endpoint, which happens.
    console.warn(`[webhook] no booking found for escrow ${escrowId}`);
  }
  return booking;
}

/** Prisma's unique-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/**
 * Queues a retry. Imported lazily so that requiring this service does not open
 * a Redis connection — the route needs the service, and the API process must
 * still answer webhooks when the queue is the thing that is down.
 */
async function enqueueRetry(providerEventId: string): Promise<void> {
  try {
    const { getQueue } = require('../lib/queue.ts');
    const { QUEUE_NAME, JOB_NAME } = require('../jobs/webhookRetryJob.ts');
    await getQueue(QUEUE_NAME).add(JOB_NAME, { providerEventId });
    console.log(`[webhook] retry queued for ${providerEventId}`);
  } catch (err) {
    // The event row is already FAILED with its error recorded, so it remains
    // replayable by hand. Losing the queue must not also lose the record.
    console.error(
      `[webhook] COULD NOT QUEUE RETRY for ${providerEventId}: ${(err as Error).message}`
    );
  }
}

/** Used when already inside the retry job — BullMQ owns the next attempt. */
async function noopQueue() {}

module.exports = {
  receive,
  reprocess,
  runHandler,
  KNOWN_EVENT_TYPES,
  HANDLERS,
  EVENT_ID_HEADER,
  DELIVERY_ID_HEADER,
  SIGNATURE_HEADER,
};
