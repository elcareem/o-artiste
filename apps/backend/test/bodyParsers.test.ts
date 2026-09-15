/**
 * The raw-body exception — docs/03-ESCROW-FLOW.md §6.
 *
 * Signature verification in #20 runs against the exact bytes received, so this
 * is the property that makes webhook verification possible at all. Tested here
 * on the real middleware rather than through a debug endpoint, so there is no
 * probe route shipped to production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bodyParsers, isWebhookPath } = require('../src/lib/bodyParsers.ts');
const { startServer } = require('./helpers.ts');

/** An app that reports back what the parser handed its route. */
function probeApp() {
  const app = express();
  app.use(bodyParsers());

  const report = (req: Req, res: Res) =>
    res.json({
      isBuffer: Buffer.isBuffer(req.body),
      // Round-tripped so the test can prove the bytes survived untouched.
      asText: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null,
      parsed: Buffer.isBuffer(req.body) ? null : req.body,
    });

  app.post('/webhooks/escrowpay', report);
  app.post('/webhooksomething', report);
  app.post('/bookings', report);
  return app;
}

// Deliberately irregular: key order and whitespace that JSON.stringify would
// not reproduce. If anything re-serialises the body, this string changes and
// a real signature check would fail.
const RAW = '{"event":"escrow.funded",  "escrow_id":"esc_9f2b",   "amount":14500000}';

test('a /webhooks/* path receives the raw body as a Buffer', async () => {
  const server = await startServer(probeApp());
  try {
    const res = await fetch(`${server.url}/webhooks/escrowpay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: RAW,
    });
    const body = ((await res.json()) as any);

    console.log('  raw body isBuffer:', body.isBuffer);
    console.log('  raw body bytes   :', Buffer.byteLength(RAW));
    console.log('  raw body verbatim:', JSON.stringify(body.asText));

    assert.equal(body.isBuffer, true, 'webhook handler must receive a Buffer');
    assert.equal(body.asText, RAW, 'bytes must survive byte-for-byte');
  } finally {
    await server.close();
  }
});

test('a non-webhook path still receives parsed JSON', async () => {
  const server = await startServer(probeApp());
  try {
    const res = await fetch(`${server.url}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artistId: 'art_1', amountKobo: 20000000 }),
    });
    const body = ((await res.json()) as any);

    assert.equal(body.isBuffer, false);
    assert.deepEqual(body.parsed, { artistId: 'art_1', amountKobo: 20000000 });
  } finally {
    await server.close();
  }
});

test('a path merely beginning with the prefix is not treated as a webhook', async () => {
  const server = await startServer(probeApp());
  try {
    const res = await fetch(`${server.url}/webhooksomething`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    const body = ((await res.json()) as any);

    assert.equal(body.isBuffer, false, '/webhooksomething is not /webhooks/*');
  } finally {
    await server.close();
  }
});

test('isWebhookPath boundaries', () => {
  assert.equal(isWebhookPath('/webhooks'), true);
  assert.equal(isWebhookPath('/webhooks/escrowpay'), true);
  assert.equal(isWebhookPath('/webhooks/a/b'), true);
  assert.equal(isWebhookPath('/webhooksomething'), false);
  assert.equal(isWebhookPath('/bookings'), false);
  assert.equal(isWebhookPath('/'), false);
});
