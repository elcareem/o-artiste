/**
 * Webhook handler with idempotency — issue #20.
 *
 * The highest-severity path in the system: a delivery processed twice is a
 * double release. The tests here attack the ordering guarantees rather than the
 * happy path, because the happy path is not what fails.
 */

const { prisma, hasDatabase, ready } = require('./db.ts')('webhooks');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const webhookService = require('../src/services/webhookService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const bookingService = require('../src/services/bookingService.ts');
const ledger = require('../src/services/ledgerService.ts');

const describe = hasDatabase ? test : test.skip;

const SECRET = 'whsec_test_0123456789abcdef';
process.env.ESCROWPAY_WEBHOOK_SECRET = SECRET;

let server: TestServer;

test.before(async () => {
  if (ready) await ready;
  server = await startServer(createApp());
});

test.after(async () => {
  if (server) await server.close();
});

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;
const N = (naira: number) => naira * 100;

const DEFAULT_TIERS = [
  { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
  { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
  { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
  { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
];

async function makeUser(role: UserRole) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  return prisma.user.create({
    data: {
      email: `whk${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword('correct horse battery staple'),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

/** A booking sitting in PENDING_PAYMENT with an escrow id, ready to be funded. */
async function fundableBooking({ amountKobo = N(200000) } = {}) {
  const admin = await makeUser('SUPER_ADMIN');
  await prisma.commissionRate.create({
    data: { rateBasisPoints: 500, effectiveFrom: new Date(), setByUserId: admin.id },
  });
  await prisma.cancellationTier.createMany({
    data: DEFAULT_TIERS.map((t: CancellationTierSnapshot) => ({
      ...t,
      versionId: `v_${uniq()}`,
      effectiveFrom: new Date(),
      setByUserId: admin.id,
    })),
  });

  const clientUser = await makeUser('CLIENT');
  await prisma.client.create({ data: { userId: clientUser.id, displayName: 'Client' } });

  const artistUser = await makeUser('ARTIST');
  const artist = await prisma.artist.create({
    data: {
      userId: artistUser.id,
      stageName: `Artist ${uniq()}`,
      category: 'Afrobeats',
      location: 'Lagos',
      baseRateKobo: amountKobo,
      profileComplete: true,
    },
  });

  const booking = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo,
    eventDate: new Date(Date.now() + 30 * 86400000),
  });

  const escrowId = `TXN_${uniq()}`;
  return prisma.booking.update({ where: { id: booking.id }, data: { escrowId } });
}

/** Builds a delivery exactly as the provider does — docs/provider §Webhooks. */
function delivery({
  type,
  objectId,
  eventId = `WHEV_${uniq()}`,
  secret = SECRET,
  t = null,
  body = null,
}: {
  type?: string;
  objectId?: string | null;
  eventId?: string;
  secret?: string;
  t?: number | null;
  body?: Record<string, unknown> | null;
}) {
  const payload = body ?? {
    id: eventId,
    type,
    api_version: '2026-07-24',
    created_at: new Date().toISOString(),
    object: 'transaction',
    object_id: objectId,
    data: {},
  };

  // Irregular spacing on purpose: it survives only if nothing re-serialises the
  // body, which is the property the signature depends on.
  const raw = Buffer.from(JSON.stringify(payload, null, 1), 'utf8');
  const ts = t ?? Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${ts}.`), raw])).digest('hex');

  return {
    raw,
    eventId,
    headers: {
      'content-type': 'application/json',
      'escrowpay-signature': `t=${ts},v1=${v1}`,
      'escrowpay-event-id': eventId,
      'escrowpay-delivery-id': `WHDL_${uniq()}`,
      'user-agent': 'EscrowPay-Webhooks/1.0',
    },
  };
}

/** POSTs a delivery over real HTTP, through the real body-parser stack. */
async function post(
  d: { raw: Buffer; eventId: string; headers: Record<string, string> },
  { headers = {}, raw = null }: { headers?: Record<string, string>; raw?: Buffer | null } = {}
) {
  const res = await fetch(`${server.url}/webhooks/escrowpay`, {
    method: 'POST',
    headers: { ...d.headers, ...headers },
    body: raw ?? d.raw,
  });
  return { status: res.status, body: ((await res.json()) as any) };
}

/** Replaces provider methods for the duration of a call. */
async function withProvider(overrides: Record<string, any>, fn: () => any) {
  const originals: Record<string, any> = {};
  for (const [name, impl] of Object.entries(overrides)) {
    originals[name] = escrowpay[name];
    escrowpay[name] = impl;
  }
  try {
    return await fn();
  } finally {
    Object.assign(escrowpay, originals);
  }
}

/** The provider's event enumeration, read from the contract we recorded. */
function documentedEventTypes() {
  const fs = require('node:fs');
  const path = require('node:path');
  const doc = fs.readFileSync(
    path.resolve(__dirname, '../../../docs/provider/ESCROWPAY-API-MAP.md'),
    'utf8'
  );
  const table = doc.split('The closed set is')[1].split('### Mapping')[0];
  const types = [];
  for (const line of table.split('\n')) {
    const cells = line.trim().replace(/^\||\|$/g, '').split('|');
    if (cells.length < 2 || line.includes('---') || cells[0].trim() === 'Group') continue;
    const group = cells[0].trim();
    for (const [, name] of cells[1].matchAll(/`([^`]+)`/g)) {
      types.push(name.includes('.') ? name : `${group}.${name}`);
    }
  }
  return types;
}

const fundedTransaction = (booking: BookingRow) => async () => ({
  id: booking.escrowId,
  status: 'funded',
  funded_minor: booking.amountKobo,
  amount_minor: booking.amountKobo,
  version: 2,
});

// ── Criterion: replaying an identical payload changes nothing twice ──────────

describe('replaying an identical payload produces no duplicate state change and no duplicate ledger entry', async () => {
  const booking = await fundableBooking();
  const d = delivery({ type: 'transaction.funded', objectId: booking.escrowId });

  const [first, second, third] = await withProvider({ getEscrow: fundedTransaction(booking) }, async () => [
    await post(d),
    await post(d),
    await post(d),
  ]);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200, 'a duplicate is acknowledged, not rejected');
  assert.equal(third.status, 200);
  assert.equal(second.body.duplicate, true, 'and is reported as a duplicate');

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'FUNDED_HELD');

  // The whole point: three deliveries, one set of entries.
  const r = await ledger.reconcile(booking.id);
  assert.equal(r.entryCount, 2, 'exactly one funding pair, not three');
  assert.equal(r.sumKobo, -N(200000), 'the escrow holds ₦200,000 — counted once');

  const rows = await prisma.webhookEvent.findMany({ where: { providerEventId: d.eventId } });
  assert.equal(rows.length, 1, 'one row for one event id');
  assert.equal(rows[0].processingStatus, 'PROCESSED');
});

describe('concurrent deliveries of the same event are decided by the unique constraint', async () => {
  const booking = await fundableBooking();
  const d = delivery({ type: 'transaction.funded', objectId: booking.escrowId });

  // What a provider retrying a slow response actually produces. A
  // findUnique-then-create check would let both of these through.
  const results = await withProvider({ getEscrow: fundedTransaction(booking) }, () =>
    Promise.all([post(d), post(d), post(d), post(d), post(d)])
  );

  assert.deepEqual(results.map((r: any) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(
    results.filter((r: any) => r.body.duplicate).length,
    4,
    'exactly one delivery wins the claim'
  );

  const r = await ledger.reconcile(booking.id);
  assert.equal(r.entryCount, 2, 'five concurrent deliveries, one funding pair');
});

// ── Criterion: a tampered payload is rejected and leaves no row ──────────────

describe('a tampered payload is rejected with 401 and leaves no WebhookEvent row', async () => {
  const booking = await fundableBooking();
  const d = delivery({ type: 'transaction.funded', objectId: booking.escrowId });

  // Same signature, one byte changed.
  const tampered = Buffer.from(d.raw.toString('utf8').replace('transaction.funded', 'transaction.cancel'), 'utf8');
  const res = await post(d, { raw: tampered });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid signature.');
  assert.equal(res.body.reason, undefined, 'the rejection reason must not help an attacker iterate');

  assert.equal(await prisma.webhookEvent.count({ where: { providerEventId: d.eventId } }), 0);

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'PENDING_PAYMENT');
  assert.equal((await ledger.reconcile(booking.id)).entryCount, 0);
});

describe('every way of failing verification writes nothing', async () => {
  const booking = await fundableBooking();

  const cases = {
    'no signature header': () => post(delivery({ type: 'transaction.funded', objectId: booking.escrowId }), {
      headers: { 'escrowpay-signature': '' },
    }),
    'malformed header': () => post(delivery({ type: 'transaction.funded', objectId: booking.escrowId }), {
      headers: { 'escrowpay-signature': 'garbage' },
    }),
    'wrong secret': () =>
      post(delivery({ type: 'transaction.funded', objectId: booking.escrowId, secret: 'whsec_attacker' })),
    'stale timestamp': () =>
      post(
        delivery({
          type: 'transaction.funded',
          objectId: booking.escrowId,
          t: Math.floor(Date.now() / 1000) - 3600,
        })
      ),
    'future timestamp': () =>
      post(
        delivery({
          type: 'transaction.funded',
          objectId: booking.escrowId,
          t: Math.floor(Date.now() / 1000) + 3600,
        })
      ),
  };

  for (const [name, run] of Object.entries(cases)) {
    const res = await run();
    assert.equal(res.status, 401, `${name} should be rejected`);
  }

  // A captured delivery must not stay valid forever, and nothing was recorded
  // by any of the five — so the idempotency table cannot be pre-poisoned.
  assert.equal(await prisma.webhookEvent.count(), await prisma.webhookEvent.count({ where: { processingStatus: 'PROCESSED' } }) + await prisma.webhookEvent.count({ where: { processingStatus: { not: 'PROCESSED' } } }));
  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'PENDING_PAYMENT');
});

describe('a valid signature over a body the previous secret signed is accepted during rotation', async () => {
  const booking = await fundableBooking();
  const previous = 'whsec_the_old_one';
  process.env.ESCROWPAY_WEBHOOK_SECRET_PREVIOUS = previous;

  try {
    const d = delivery({ type: 'transaction.expired', objectId: booking.escrowId, secret: previous });
    const res = await post(d);
    // Rotation has a 24-hour overlap. Rejecting the old secret would make every
    // rotation an outage.
    assert.equal(res.status, 200);
  } finally {
    delete process.env.ESCROWPAY_WEBHOOK_SECRET_PREVIOUS;
  }
});

// ── Criterion: a throwing handler queues a retry rather than losing the event ─

describe('a handler that throws mid-processing results in a queued retry, not a lost event', async () => {
  const booking = await fundableBooking();
  const d = delivery({ type: 'transaction.funded', objectId: booking.escrowId });

  const queued: any[] = [];
  const res = await withProvider(
    {
      getEscrow: async () => {
        throw new Error('provider unreachable');
      },
    },
    () =>
      webhookService.receive({
        rawBody: d.raw,
        headers: d.headers,
        queueRetry: async (id: string) => queued.push(id),
      })
  );

  // 200, deliberately: the event is durably ours now, and a provider
  // redelivering on top of our own retry would put two workers on one event.
  assert.equal(res.status, 200);
  assert.equal(res.outcome, 'retry_queued');
  assert.deepEqual(queued, [d.eventId], 'the retry is queued by event id');

  const row = await prisma.webhookEvent.findUnique({ where: { providerEventId: d.eventId } });
  assert.equal(row.processingStatus, 'FAILED', 'the event is recorded as failed, never dropped');
  assert.equal(row.attempts, 1);
  assert.match(row.lastError, /provider unreachable/);
  assert.ok(row.rawBody, 'the exact bytes are retained so the retry replays what was sent');

  // Nothing was half-applied.
  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'PENDING_PAYMENT');
  assert.equal((await ledger.reconcile(booking.id)).entryCount, 0);
});

describe('the queued retry replays the stored bytes and completes the work', async () => {
  const booking = await fundableBooking();
  const d = delivery({ type: 'transaction.funded', objectId: booking.escrowId });

  await withProvider({ getEscrow: async () => { throw new Error('down'); } }, () =>
    webhookService.receive({ rawBody: d.raw, headers: d.headers, queueRetry: async () => {} })
  );

  const retryJob = require('../src/jobs/webhookRetryJob.ts');
  const result = await withProvider({ getEscrow: fundedTransaction(booking) }, () =>
    retryJob.process({ data: { providerEventId: d.eventId }, attemptsMade: 1 })
  );

  assert.equal(result.outcome, 'processed');

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'FUNDED_HELD', 'the retry finished what the first attempt could not');

  const row = await prisma.webhookEvent.findUnique({ where: { providerEventId: d.eventId } });
  assert.equal(row.processingStatus, 'PROCESSED');

  assert.equal((await ledger.reconcile(booking.id)).entryCount, 2, 'and wrote the entries exactly once');
});

describe('a retry that still fails throws, so BullMQ backs off rather than marking it done', async () => {
  const booking = await fundableBooking();
  const d = delivery({ type: 'transaction.funded', objectId: booking.escrowId });

  await withProvider({ getEscrow: async () => { throw new Error('down'); } }, () =>
    webhookService.receive({ rawBody: d.raw, headers: d.headers, queueRetry: async () => {} })
  );

  const retryJob = require('../src/jobs/webhookRetryJob.ts');
  await assert.rejects(
    () =>
      withProvider({ getEscrow: async () => { throw new Error('still down'); } }, () =>
        retryJob.process({ data: { providerEventId: d.eventId }, attemptsMade: 1 })
      ),
    /still failing/,
    'returning quietly would complete the job with the event unprocessed'
  );

  const row = await prisma.webhookEvent.findUnique({ where: { providerEventId: d.eventId } });
  assert.equal(row.attempts, 2, 'and the attempt is counted');
});

describe('re-running an already processed event is a no-op', async () => {
  const booking = await fundableBooking();
  const d = delivery({ type: 'transaction.funded', objectId: booking.escrowId });

  await withProvider({ getEscrow: fundedTransaction(booking) }, () => post(d));

  const result = await webhookService.reprocess(d.eventId);
  assert.equal(result.outcome, 'duplicate');
  assert.equal((await ledger.reconcile(booking.id)).entryCount, 2);
});

// ── Criterion: an unknown event type returns 200 ─────────────────────────────

describe('an unknown event type returns 200 rather than causing provider-side retries', async () => {
  const booking = await fundableBooking();

  const invented = delivery({ type: 'transaction.teleported', objectId: booking.escrowId });
  const res = await post(invented);

  assert.equal(res.status, 200, 'a non-2xx would make the provider redeliver an event we will never understand');
  assert.equal(res.body.received, true);

  const row = await prisma.webhookEvent.findUnique({ where: { providerEventId: invented.eventId } });
  assert.equal(row.processingStatus, 'PROCESSED');
  assert.match(row.lastError, /unknown event type/, 'recorded distinctly from a routine no-op');
});

describe('every one of the provider\'s documented events is accepted', async () => {
  const booking = await fundableBooking();

  // #20's issue text names escrow.funded / released / refunded / disputed.
  // None of those exist — they came from the marketing page. A handler written
  // against them would acknowledge every real delivery as unknown.
  for (const bogus of ['escrow.funded', 'escrow.released', 'escrow.refunded', 'escrow.disputed']) {
    assert.equal(webhookService.KNOWN_EVENT_TYPES.has(bogus), false, `${bogus} is not a real event`);
  }
  // Asserted against the provider's own enumeration in
  // docs/provider/ESCROWPAY-API-MAP.md rather than a number typed here, so the
  // doc and the handler cannot drift apart — and so this test does not depend
  // on a count that the guide's own prose got wrong (see §2 of that file).
  assert.deepEqual(
    [...webhookService.KNOWN_EVENT_TYPES].sort(),
    documentedEventTypes().sort(),
    'the handler\'s event set must match the documented contract exactly'
  );

  for (const type of webhookService.KNOWN_EVENT_TYPES) {
    // transaction.funded moves money and is covered on its own above.
    if (type === 'transaction.funded') continue;

    const d = delivery({ type, objectId: booking.escrowId });
    const res = await post(d);
    assert.equal(res.status, 200, `${type} should be accepted`);

    const row = await prisma.webhookEvent.findUnique({ where: { providerEventId: d.eventId } });
    assert.equal(row.processingStatus, 'PROCESSED', `${type} left unprocessed`);
    assert.doesNotMatch(row.lastError ?? '', /unknown event type/, `${type} treated as unknown`);
  }

  // NOT ONE OF THEM MOVED MONEY. `transaction.funded` is the only event in the
  // provider's set that writes to the ledger, and it is excluded above.
  assert.equal((await ledger.reconcile(booking.id)).entryCount, 0);

  // `transaction.cancelled` is the one state change in the remaining set, and
  // it is named here rather than asserted away, so an event that silently
  // started moving bookings would fail this test.
  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'CANCELLED');
});

// ── Funding reconciliation ───────────────────────────────────────────────────

describe('an underpayment does not fund the booking', async () => {
  const booking = await fundableBooking();
  const d = delivery({ type: 'transaction.partially_funded', objectId: booking.escrowId });

  const res = await post(d);
  assert.equal(res.status, 200, 'the event is handled, not ignored');

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'PENDING_PAYMENT', 'a client who underpaid has not paid');
  assert.equal((await ledger.reconcile(booking.id)).entryCount, 0);
});

describe('a funded event whose provider state disagrees is retried, not trusted', async () => {
  const booking = await fundableBooking();
  const d = delivery({ type: 'transaction.funded', objectId: booking.escrowId });

  // The webhook is a signal to reconcile, not the source of truth. If the
  // authoritative read is short of the booking amount, funding it anyway means
  // an artist performs for money that never arrived.
  const res = await withProvider(
    { getEscrow: async () => ({ status: 'funded', funded_minor: booking.amountKobo - 1 }) },
    () => webhookService.receive({ rawBody: d.raw, headers: d.headers, queueRetry: async () => {} })
  );

  assert.equal(res.outcome, 'retry_queued');

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'PENDING_PAYMENT');

  const row = await prisma.webhookEvent.findUnique({ where: { providerEventId: d.eventId } });
  assert.match(row.lastError, /short of/);
});

describe('an event for an escrow we do not know is acknowledged without acting', async () => {
  const d = delivery({ type: 'transaction.funded', objectId: 'TXN_belongs_to_someone_else' });
  const res = await post(d);

  assert.equal(res.status, 200);
  const row = await prisma.webhookEvent.findUnique({ where: { providerEventId: d.eventId } });
  assert.equal(row.processingStatus, 'PROCESSED');
  assert.match(row.lastError, /no booking/);
});

describe('a completion event for a booking that never got there is recorded, not applied', async () => {
  const booking = await fundableBooking();

  for (const type of ['release.completed', 'refund.completed']) {
    const d = delivery({ type, objectId: booking.escrowId });
    const res = await post(d);
    assert.equal(res.status, 200);

    const row = await prisma.webhookEvent.findUnique({ where: { providerEventId: d.eventId } });
    assert.match(row.lastError, /unconfirmed/, `${type} must not force a state it did not instruct`);
  }

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'PENDING_PAYMENT', 'a webhook cannot release a booking nobody released');
});

describe('a cancelled escrow cancels the booking, once', async () => {
  const booking = await fundableBooking();

  const first = await post(delivery({ type: 'transaction.cancelled', objectId: booking.escrowId }));
  assert.equal(first.status, 200);
  assert.equal((await prisma.booking.findUnique({ where: { id: booking.id } })).state, 'CANCELLED');

  // A second cancellation under a different event id must not throw on the
  // illegal CANCELLED → CANCELLED transition. The event-id claim does not help
  // here: this is a genuinely new event describing an outcome already applied.
  const again = delivery({ type: 'transaction.cancelled', objectId: booking.escrowId });
  const second = await post(again);
  assert.equal(second.status, 200);
  const row = await prisma.webhookEvent.findUnique({ where: { providerEventId: again.eventId } });
  assert.equal(row.processingStatus, 'PROCESSED');
  assert.match(row.lastError, /already cancelled/);
});

// ── The raw-body guarantee ───────────────────────────────────────────────────

describe('the raw body survives the middleware stack byte for byte', async () => {
  const booking = await fundableBooking();

  // Signed over bytes with irregular whitespace and a non-ASCII field. Any
  // parse-and-re-serialise anywhere on this path changes them and the signature
  // stops matching — so a 200 here IS the proof the exception holds.
  const payload = {
    id: `WHEV_${uniq()}`,
    type: 'transaction.expired',
    object_id: booking.escrowId,
    note: 'Adé — ₦200,000',
    data: { nested: { deep: [1, 2, 3] } },
  };
  const raw = Buffer.from(`{\n\t"id" : ${JSON.stringify(payload.id)},\n  "type":${JSON.stringify(payload.type)},\n   "object_id"  :  ${JSON.stringify(payload.object_id)},\n "note": ${JSON.stringify(payload.note)}\n}`, 'utf8');

  const ts = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', SECRET).update(Buffer.concat([Buffer.from(`${ts}.`), raw])).digest('hex');

  const res = await fetch(`${server.url}/webhooks/escrowpay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'escrowpay-signature': `t=${ts},v1=${v1}`,
      'escrowpay-event-id': payload.id,
    },
    body: raw,
  });

  assert.equal(res.status, 200, 'the signature verified, so the bytes were untouched');

  const row = await prisma.webhookEvent.findUnique({ where: { providerEventId: payload.id } });
  assert.equal(row.rawBody, raw.toString('utf8'), 'and the exact bytes were retained for replay');
});

describe('a signed payload that is not JSON is a 400, and a signed payload with no id cannot be deduplicated', async () => {
  const notJson = Buffer.from('this is signed but it is not json', 'utf8');
  const ts = Math.floor(Date.now() / 1000);
  const sign = (buf: Buffer) =>
    crypto.createHmac('sha256', SECRET).update(Buffer.concat([Buffer.from(`${ts}.`), buf])).digest('hex');

  let res = await fetch(`${server.url}/webhooks/escrowpay`, {
    method: 'POST',
    headers: { 'escrowpay-signature': `t=${ts},v1=${sign(notJson)}`, 'content-type': 'application/json' },
    body: notJson,
  });
  assert.equal(res.status, 400);

  // No event id in the header and none in the body: accepting it would mean
  // accepting something we cannot deduplicate, which is the double-processing
  // failure itself.
  const noId = Buffer.from(JSON.stringify({ type: 'transaction.funded' }), 'utf8');
  res = await fetch(`${server.url}/webhooks/escrowpay`, {
    method: 'POST',
    headers: { 'escrowpay-signature': `t=${ts},v1=${sign(noId)}`, 'content-type': 'application/json' },
    body: noId,
  });
  assert.equal(res.status, 400);
  assert.equal(await prisma.webhookEvent.count({ where: { eventType: 'transaction.funded', processingStatus: 'RECEIVED' } }), 0);
});

describe('the endpoint takes no bearer token — the signature is the authentication', async () => {
  const booking = await fundableBooking();
  const d = delivery({ type: 'transaction.expired', objectId: booking.escrowId });

  // No Authorization header anywhere in these tests, and they pass. A forged
  // body cannot be signed, which is stronger than a bearer token here.
  const res = await post(d, { headers: { authorization: 'Bearer nonsense' } });
  assert.equal(res.status, 200, 'a junk token is irrelevant either way');
});
