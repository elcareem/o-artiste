/**
 * EscrowPay Merchant API client — docs/provider/ESCROWPAY-API-MAP.md.
 *
 * THIS MODULE TALKS TO THE PROVIDER AND DOES NOTHING ELSE.
 *
 * No business logic, no ledger writes, no state transitions. That separation is
 * what makes #26's rule enforceable: only `escrowService.js` may decide to
 * release or refund. The rule is meaningless if this client also decides when.
 *
 * Retry safety comes from the provider requiring an `Idempotency-Key` on every
 * money-moving call. We pass our own self-generated reference, so a timed-out
 * create can be retried with the same key and the provider returns the original
 * transaction rather than opening a second escrow.
 */

const crypto = require('node:crypto');
const axios = require('axios');

const { AppError } = require('./errors');

const DEFAULT_BASE_URL = 'https://production-business-api.escrowpay.app/api/v1';

/**
 * Below the host's request timeout, which #2 could not pin down — Render
 * publishes no single figure and community reports range from 15s to 100s.
 * 15s sits under the lowest of those, so #17's criterion is satisfied by
 * construction rather than by measurement. A REST call to create or release an
 * escrow has no business taking longer; if it does, our timeout firing first is
 * what we want, because the idempotency key makes the retry safe.
 */
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Network faults and 5xx are worth retrying. A 4xx is our mistake — it is not.
 *
 * Three attempts after the first, with jittered exponential backoff. Observed
 * in practice: the sandbox occasionally drops a connection outright, and two
 * retries fired within a second were not enough to ride it out. Jitter matters
 * because a burst of calls that all fail together would otherwise all retry
 * together, reproducing the same burst.
 *
 * Safe at any count because every money-moving call carries an
 * `Idempotency-Key`: a retry is the same request, not a second one.
 */
const DEFAULT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 400;
const RETRY_JITTER_MS = 250;

/** Webhook signature tolerance, per the provider's guide. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * The provider's transaction range — ₦20,000 to ₦3,000,000, in kobo.
 *
 * A hard constraint, not product policy: a booking outside this range cannot be
 * funded at all. Exported here because it is a provider fact, and enforced at
 * artist rate level (#11) rather than at checkout so the artist finds out when
 * setting their rate rather than the client at the point of payment.
 */
const MIN_TRANSACTION_KOBO = 2000000;
const MAX_TRANSACTION_KOBO = 300000000;

function config() {
  const apiKey = process.env.ESCROWPAY_API_KEY;
  if (!apiKey) {
    throw new Error('ESCROWPAY_API_KEY is not set. The escrow client cannot make calls.');
  }
  return {
    apiKey,
    baseUrl: process.env.ESCROWPAY_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs: Number(process.env.ESCROWPAY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Sandbox and production are the SAME host — the key prefix decides the book
 * (`sk_test_…` vs `sk_live_…`). There is no second hostname to switch to, so
 * environment selection is purely a matter of which key is configured.
 */
function isTestKey(apiKey = process.env.ESCROWPAY_API_KEY || '') {
  return apiKey.startsWith('sk_test_') || apiKey.includes('_test_');
}

function client() {
  const { apiKey, baseUrl, timeoutMs } = config();
  return axios.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    headers: {
      'X-API-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    // We interpret every status ourselves, so axios must not throw on 4xx/5xx.
    validateStatus: () => true,
  });
}

/**
 * Performs a request, retrying only where a retry is safe.
 *
 * @param {string} idempotencyKey Required by the provider on money-moving
 *   calls. Always our self-generated reference, never a random value — a random
 *   key on a retry would defeat the entire purpose.
 */
async function request({ method, path, body, idempotencyKey, retries = DEFAULT_RETRIES }) {
  const http = client();
  const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      response = await http.request({ method, url: path, data: body, headers });
    } catch (err) {
      // Network-level failure: no response at all. Safe to retry precisely
      // because the idempotency key makes a duplicate create impossible.
      lastError = err;
      if (attempt < retries) {
        await sleep(backoffFor(attempt));
        continue;
      }
      throw providerUnreachable(err);
    }

    if (response.status >= 500 && attempt < retries) {
      lastError = response;
      await sleep(backoffFor(attempt));
      continue;
    }

    if (response.status >= 400) throw providerError(response);

    return response.data?.data ?? response.data;
  }

  throw providerUnreachable(lastError);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential, with jitter so simultaneous failures do not retry in lockstep. */
function backoffFor(attempt) {
  return RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * RETRY_JITTER_MS);
}

/**
 * Translates a provider error into ours.
 *
 * The provider uses `{"detail":{"code","message"}}` for domain errors and
 * FastAPI's `{"detail":[{loc,msg}]}` for validation. Neither matches our
 * `{ "error": … }` contract, so this converts rather than passes through
 * (docs/02-API-CONTRACT.md §2).
 *
 * The provider's own wording is preserved in `providerMessage` for logs and
 * admin views, but is never what a client sees by default — their copy is
 * written for an integrator, not for someone booking a saxophonist.
 */
function providerError(response) {
  const detail = response.data?.detail;
  let providerMessage;
  let providerCode;

  if (Array.isArray(detail)) {
    providerCode = 'validation_error';
    providerMessage = detail
      .map((d) => `${(d.loc || []).join('.')}: ${d.msg}`)
      .join('; ');
  } else if (detail && typeof detail === 'object') {
    providerCode = detail.code;
    providerMessage = detail.message;
  } else {
    providerMessage = typeof detail === 'string' ? detail : 'Unknown provider error.';
  }

  const error = new AppError(502, 'The payment provider could not complete that request.');
  error.providerStatus = response.status;
  error.providerCode = providerCode;
  error.providerMessage = providerMessage;
  error.requestId = response.data?.data?.request_id ?? response.headers?.['x-request-id'];

  // Logged, not returned. #17 requires provider errors to carry enough detail
  // to diagnose while keeping credentials out of the logs — the key travels in
  // a header and is never part of this record. The user-facing message stays
  // generic because the provider writes for integrators, not for someone
  // booking a saxophonist.
  console.error(
    `[escrowpay] ${response.config?.method?.toUpperCase()} ${response.config?.url} ` +
      `→ ${response.status} ${providerCode ?? ''} ${providerMessage ?? ''}` +
      (error.requestId ? ` (request_id ${error.requestId})` : '')
  );

  return error;
}

function providerUnreachable(cause) {
  const error = new AppError(502, 'Could not reach the payment provider. Please try again.');
  error.providerCode = 'provider_unreachable';
  // `cause.message` may carry a URL but never a credential — the key travels in
  // a header, and axios does not include headers in error messages.
  error.providerMessage = cause?.message ?? 'no response';
  return error;
}

// ---------------------------------------------------------------------------
// Money-moving operations
// ---------------------------------------------------------------------------

/**
 * Creates an escrow transaction. It is created as `draft` and must be activated
 * separately — which suits #16, where the cancellation terms must be
 * acknowledged before a booking can be funded.
 *
 * @param {string} p.reference   Our self-generated `escrowReference`. Used as
 *   BOTH the idempotency key and `external_reference`.
 * @param {number} p.amountKobo  Integer kobo. The provider's `amount_minor` is
 *   in minor units, so this passes through with NO conversion.
 */
async function createEscrow({
  reference,
  amountKobo,
  payerPartyId,
  beneficiaryPartyId,
  payoutAccountId,
  description,
  metadata,
}) {
  assertInteger(amountKobo, 'amountKobo');

  return request({
    method: 'POST',
    path: '/transactions',
    idempotencyKey: reference,
    body: {
      type: 'standard',
      amount_minor: amountKobo,
      currency: 'NGN',
      // The client must pay the full amount; an underpayment does not fund it.
      funding_mode: 'exact',
      payer: { party_id: payerPartyId },
      beneficiary: { party_id: beneficiaryPartyId },
      // Nothing moves unless we instruct it. The provider's automatic policies
      // cannot know whether a check-in exists or a dispute is open.
      release_policy: 'manual_only',
      refund_policy: 'manual_only',
      // `automatic` is disabled on this business, so payouts are ours to issue.
      // Never left at the default `retain_in_wallet` — see §7 of the API map.
      payout_preference: 'manual',
      ...(payoutAccountId ? { payout_account_id: payoutAccountId } : {}),
      // Deliberately NOT sent: `automatic_release_at` (one source of truth for
      // release timing is our own job) and `marketplace_commission_bps` (our
      // commission comes from the booking snapshot and is ledgered by us).
      external_reference: reference,
      ...(description ? { description } : {}),
      ...(metadata ? { metadata } : {}),
    },
  });
}

/** Moves a draft transaction to active. */
function activateEscrow({ transactionId, version, reference }) {
  return request({
    method: 'POST',
    path: `/transactions/${transactionId}/activate`,
    idempotencyKey: reference,
    body: { version },
  });
}

function getEscrow(transactionId) {
  return request({ method: 'GET', path: `/transactions/${transactionId}` });
}

/**
 * Releases funds to the beneficiary.
 *
 * Partial releases are supported, so `amountKobo` is explicit rather than
 * implied — #32's split resolutions depend on it.
 */
async function release({ transactionId, reference, amountKobo, milestoneId, reason }) {
  assertInteger(amountKobo, 'amountKobo');
  return request({
    method: 'POST',
    path: `/transactions/${transactionId}/releases`,
    idempotencyKey: reference,
    body: {
      amount_minor: amountKobo,
      ...(milestoneId ? { milestone_id: milestoneId } : {}),
      ...(reason ? { reason } : {}),
    },
  });
}

/**
 * Refunds to the payer. `source` defaults to `escrow_held`, which is the only
 * correct source for money still in escrow; the wallet and reserve sources
 * exist for corrections and are not used by the booking flows.
 */
async function refund({ transactionId, reference, amountKobo, source = 'escrow_held', fundingRecordId, reason }) {
  assertInteger(amountKobo, 'amountKobo');
  return request({
    method: 'POST',
    path: `/transactions/${transactionId}/refunds`,
    idempotencyKey: reference,
    body: {
      amount_minor: amountKobo,
      source,
      ...(fundingRecordId ? { funding_record_id: fundingRecordId } : {}),
      ...(reason ? { reason } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Identity, payout accounts, fees — transport for #10, #11 and #14
// ---------------------------------------------------------------------------

/**
 * Identity + KYC + party in one call. `type` is lowercase `nin` or `bvn`.
 *
 * In the test book this runs against EscrowPay's simulator, never Prembly:
 * an identifier ending in an even digit verifies, an odd one fails.
 */
function onboardParty({ type, identifier, email, reference, consent = true }) {
  return request({
    method: 'POST',
    path: '/parties/onboard',
    idempotencyKey: reference,
    body: { type, identifier, email, consent },
  });
}

function getParty(partyId) {
  return request({ method: 'GET', path: `/parties/${partyId}` });
}

/** An artist needs one of these before any release can reach them. */
function createPayoutAccount({ partyId, bankCode, accountNumber, reference, isDefault = true }) {
  return request({
    method: 'POST',
    path: '/payout-accounts',
    idempotencyKey: reference,
    body: {
      owner_type: 'party',
      owner_id: partyId,
      bank_code: bankCode,
      account_number: accountNumber,
      is_default: isDefault,
    },
  });
}

function listBanks() {
  return request({ method: 'GET', path: '/banks' });
}

/** Their fees, read rather than predicted. Feeds #14. */
async function estimateFees({ amountKobo, currency = 'NGN', feeType }) {
  assertInteger(amountKobo, 'amountKobo');
  return request({
    method: 'POST',
    path: '/fees/estimates',
    body: { amount_minor: amountKobo, currency, ...(feeType ? { fee_type: feeType } : {}) },
  });
}

function getTransactionFees(transactionId) {
  return request({ method: 'GET', path: `/transactions/${transactionId}/fees` });
}

/** Confirms which book the configured key is on. */
function credentialContext() {
  return request({ method: 'GET', path: '/credential-context' });
}

function health() {
  return request({ method: 'GET', path: '/health' });
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Verifies an `EscrowPay-Signature` header against the RAW request body.
 *
 *   v1 = hex( HMAC_SHA256( whsec_… , "{t}." || raw_body_bytes ) )
 *
 * The body must be the exact bytes received. Parsing and re-serialising the
 * JSON changes key order and whitespace and the signature will never match —
 * which is why #2 configured the raw-body exception at bootstrap.
 *
 * Accepts the previous secret as well as the current one, because rotation has
 * a 24-hour overlap during which either is valid. Verifying against one secret
 * would turn every rotation into an outage.
 *
 * @param {Buffer} p.rawBody  Exact bytes. A string is encoded as utf8.
 * @returns {{valid: boolean, reason?: string}}
 */
function verifyWebhookSignature({
  rawBody,
  signatureHeader,
  secret = process.env.ESCROWPAY_WEBHOOK_SECRET,
  previousSecret = process.env.ESCROWPAY_WEBHOOK_SECRET_PREVIOUS,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  if (!secret) throw new Error('ESCROWPAY_WEBHOOK_SECRET is not set. Webhooks cannot be verified.');
  if (!signatureHeader) return { valid: false, reason: 'missing_signature' };

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { valid: false, reason: 'malformed_signature' };

  const { t, v1 } = parsed;

  // A replay window, not merely a correctness check: without it a captured
  // delivery stays valid forever.
  if (Math.abs(nowSeconds - t) > toleranceSeconds) {
    return { valid: false, reason: 'timestamp_outside_tolerance' };
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const signedMessage = Buffer.concat([Buffer.from(`${t}.`, 'ascii'), body]);

  for (const candidate of [secret, previousSecret].filter(Boolean)) {
    const expected = crypto.createHmac('sha256', candidate).update(signedMessage).digest('hex');
    if (timingSafeEqualHex(expected, v1)) return { valid: true };
  }

  return { valid: false, reason: 'signature_mismatch' };
}

function parseSignatureHeader(header) {
  const parts = String(header).split(',');
  let t;
  let v1;
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key?.trim() === 't') t = Number(value);
    if (key?.trim() === 'v1') v1 = value?.trim();
  }
  if (!Number.isFinite(t) || !v1) return null;
  return { t, v1 };
}

/** Constant-time comparison, as the provider's guide requires. */
function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so compare lengths first and still run the comparison.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Declared on `async` functions so a bad amount becomes a rejection like every
 * other failure. A synchronous throw from an otherwise-async API is a trap for
 * callers using .catch().
 */
function assertInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw new AppError(500, `${name} must be an integer number of kobo.`);
  }
}

module.exports = {
  createEscrow,
  activateEscrow,
  getEscrow,
  release,
  refund,
  onboardParty,
  getParty,
  createPayoutAccount,
  listBanks,
  estimateFees,
  getTransactionFees,
  credentialContext,
  health,
  verifyWebhookSignature,
  isTestKey,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  SIGNATURE_TOLERANCE_SECONDS,
  MIN_TRANSACTION_KOBO,
  MAX_TRANSACTION_KOBO,
};
