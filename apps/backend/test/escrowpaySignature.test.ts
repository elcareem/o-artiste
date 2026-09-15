/**
 * Webhook signature verification — issue #17.
 *
 * Pure crypto, no network, so this runs everywhere. The scheme is the
 * provider's:
 *
 *   v1 = hex( HMAC_SHA256( whsec_… , "{t}." || raw_body_bytes ) )
 */

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { verifyWebhookSignature, SIGNATURE_TOLERANCE_SECONDS } = require('../src/lib/escrowpay.ts');

const SECRET = 'whsec_test_secret_value';
const OTHER_SECRET = 'whsec_a_different_secret';

/** Signs exactly as the provider does. */
function sign(rawBody, secret, t) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const message = Buffer.concat([Buffer.from(`${t}.`, 'ascii'), body]);
  const v1 = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return `t=${t},v1=${v1}`;
}

// Irregular spacing on purpose: JSON.stringify would never produce this, so if
// anything re-serialises the body the signature cannot match.
const RAW = Buffer.from(
  '{"id":"WHEV_abc",  "type":"transaction.funded",   "object_id":"TXN_123","data":{}}',
  'utf8'
);
const NOW = 1789000000;

test('accepts a valid signature over the exact raw bytes', () => {
  const header = sign(RAW, SECRET, NOW);
  const result = verifyWebhookSignature({
    rawBody: RAW,
    signatureHeader: header,
    secret: SECRET,
    nowSeconds: NOW,
  });
  assert.deepEqual(result, { valid: true });
});

test('rejects a tampered payload', () => {
  const header = sign(RAW, SECRET, NOW);

  // A single byte changed — the amount an attacker would most want to alter.
  const tampered = Buffer.from(
    '{"id":"WHEV_abc",  "type":"transaction.funded",   "object_id":"TXN_999","data":{}}',
    'utf8'
  );

  const result = verifyWebhookSignature({
    rawBody: tampered,
    signatureHeader: header,
    secret: SECRET,
    nowSeconds: NOW,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('rejects a signature made with the wrong secret', () => {
  const header = sign(RAW, OTHER_SECRET, NOW);
  const result = verifyWebhookSignature({
    rawBody: RAW,
    signatureHeader: header,
    secret: SECRET,
    nowSeconds: NOW,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('rejects a replayed delivery outside the 300-second window', () => {
  const old = NOW - SIGNATURE_TOLERANCE_SECONDS - 1;
  const header = sign(RAW, SECRET, old);

  // The signature itself is perfectly valid — this is the replay guard, not a
  // correctness check. Without it a captured delivery stays usable forever.
  const result = verifyWebhookSignature({
    rawBody: RAW,
    signatureHeader: header,
    secret: SECRET,
    nowSeconds: NOW,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'timestamp_outside_tolerance');

  // Just inside the window is still accepted.
  const justInside = sign(RAW, SECRET, NOW - SIGNATURE_TOLERANCE_SECONDS + 1);
  assert.equal(
    verifyWebhookSignature({ rawBody: RAW, signatureHeader: justInside, secret: SECRET, nowSeconds: NOW }).valid,
    true
  );
});

test('rejects a future timestamp as well as a stale one', () => {
  const header = sign(RAW, SECRET, NOW + SIGNATURE_TOLERANCE_SECONDS + 1);
  const result = verifyWebhookSignature({
    rawBody: RAW,
    signatureHeader: header,
    secret: SECRET,
    nowSeconds: NOW,
  });
  assert.equal(result.valid, false, 'clock skew forward must not be a bypass');
});

test('accepts the previous secret during a rotation overlap', () => {
  // The provider honours either secret for 24 hours after rotation. Verifying
  // against only the current one would make every rotation an outage.
  const header = sign(RAW, OTHER_SECRET, NOW);

  const result = verifyWebhookSignature({
    rawBody: RAW,
    signatureHeader: header,
    secret: SECRET,
    previousSecret: OTHER_SECRET,
    nowSeconds: NOW,
  });
  assert.equal(result.valid, true);

  // And a third, unrelated secret is still rejected.
  const forged = sign(RAW, 'whsec_forged', NOW);
  assert.equal(
    verifyWebhookSignature({
      rawBody: RAW,
      signatureHeader: forged,
      secret: SECRET,
      previousSecret: OTHER_SECRET,
      nowSeconds: NOW,
    }).valid,
    false
  );
});

test('rejects malformed and missing headers rather than throwing', () => {
  const cases = [
    [undefined, 'missing_signature'],
    ['', 'missing_signature'],
    ['garbage', 'malformed_signature'],
    ['t=notanumber,v1=abc', 'malformed_signature'],
    ['v1=abc', 'malformed_signature'],
    [`t=${NOW}`, 'malformed_signature'],
  ];

  for (const [header, reason] of cases) {
    const result = verifyWebhookSignature({
      rawBody: RAW,
      signatureHeader: header,
      secret: SECRET,
      nowSeconds: NOW,
    });
    assert.equal(result.valid, false, `header ${JSON.stringify(header)} must not verify`);
    assert.equal(result.reason, reason);
  }
});

test('a v1 of the wrong length is rejected without throwing', () => {
  // timingSafeEqual throws on a length mismatch; a naive implementation would
  // 500 here, which turns a forged signature into a denial of service.
  const result = verifyWebhookSignature({
    rawBody: RAW,
    signatureHeader: `t=${NOW},v1=abcdef`,
    secret: SECRET,
    nowSeconds: NOW,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('a string body is treated identically to the same bytes', () => {
  const text = RAW.toString('utf8');
  const header = sign(RAW, SECRET, NOW);
  assert.equal(
    verifyWebhookSignature({ rawBody: text, signatureHeader: header, secret: SECRET, nowSeconds: NOW }).valid,
    true
  );
});

test('re-serialised JSON does NOT verify — the raw body is load-bearing', () => {
  const header = sign(RAW, SECRET, NOW);

  // Exactly what express.json() would hand a handler: same data, different
  // bytes. This is the failure #2's raw-body exception exists to prevent.
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(RAW.toString('utf8'))), 'utf8');
  assert.notEqual(reserialised.toString('utf8'), RAW.toString('utf8'), 'the bytes must differ');

  const result = verifyWebhookSignature({
    rawBody: reserialised,
    signatureHeader: header,
    secret: SECRET,
    nowSeconds: NOW,
  });
  assert.equal(result.valid, false, 'proves parsing and re-serialising breaks verification');
});

test('refuses to verify when no secret is configured', () => {
  // The parameter defaults to the environment variable, so the variable itself
  // has to be cleared to exercise the unconfigured case.
  const saved = process.env.ESCROWPAY_WEBHOOK_SECRET;
  const savedPrevious = process.env.ESCROWPAY_WEBHOOK_SECRET_PREVIOUS;
  delete process.env.ESCROWPAY_WEBHOOK_SECRET;
  delete process.env.ESCROWPAY_WEBHOOK_SECRET_PREVIOUS;
  try {
    // Loud rather than silently accepting everything. A verifier that cannot
    // verify must refuse, not wave requests through.
    assert.throws(
      () => verifyWebhookSignature({ rawBody: RAW, signatureHeader: `t=${NOW},v1=x` }),
      /ESCROWPAY_WEBHOOK_SECRET is not set/
    );
  } finally {
    process.env.ESCROWPAY_WEBHOOK_SECRET = saved;
    if (savedPrevious !== undefined) process.env.ESCROWPAY_WEBHOOK_SECRET_PREVIOUS = savedPrevious;
  }
});
