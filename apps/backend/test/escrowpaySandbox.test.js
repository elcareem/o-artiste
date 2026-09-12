/**
 * EscrowPay client against the live sandbox — issue #17.
 *
 * Skipped unless ESCROWPAY_API_KEY is set, so the suite still runs without
 * credentials. Refuses to run against a live key: every call here creates real
 * records, and on a live book those would be real money.
 */

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const test = require('node:test');
const assert = require('node:assert/strict');

const ep = require('../src/lib/escrowpay');

const hasKey = Boolean(process.env.ESCROWPAY_API_KEY);
const onTestBook = hasKey && ep.isTestKey(process.env.ESCROWPAY_API_KEY);
const describe = onTestBook ? test : test.skip;

if (hasKey && !onTestBook) {
  throw new Error('Refusing to run sandbox tests against a non-test EscrowPay key.');
}

let seq = 0;
const ref = (p) => `test_${p}_${Date.now()}_${seq++}`;

/**
 * Any identifier ending in an even digit verifies in the simulator, and an
 * identity may only be onboarded ONCE per environment — a fixed fixture
 * collides with `identity_already_exists` on the second run. Generated fresh
 * each time, always ending even.
 */
/**
 * Bank accounts are unique per environment — `payout_account_exists` on a
 * repeat. Random 10-digit numbers still collide surprisingly often, because the
 * simulator appears to key on the last four digits (`SIMULATED ACCOUNT 6789`),
 * making the effective space ~10,000 rather than nine billion.
 *
 * Retrying on a collision rather than widening the number: the uniqueness rule
 * is documented provider behaviour, and this test exists to verify our client,
 * not to win a namespace lottery. Fighting it with more entropy would only make
 * the flake rarer, not absent — and a financial suite that fails one run in
 * three is one people stop believing.
 */
/**
 * The simulator rejects payout accounts whose number ends in `0`, with
 * `rejection_reason: "destination_invalid"`. Every other final digit verifies —
 * measured, after two wrong guesses at the rule:
 *
 *   last digit 0 → rejected (destination_invalid)
 *   last digits 1-9 → verified
 *
 * Note this is NOT the even/odd rule that governs identity fixtures. Assuming
 * the two followed the same convention is what produced a suite failing one run
 * in three, and the symptom read as flakiness rather than as a fixture rule.
 */
function accountNumber() {
  const head = String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
  const last = Math.floor(Math.random() * 9) + 1; // 1-9, never 0
  return `${head}${last}`;
}

async function registerPayoutAccount(partyId, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await ep.createPayoutAccount({
        partyId,
        bankCode: '000013',
        accountNumber: accountNumber(),
        reference: ref('payout_acct'),
      });
    } catch (err) {
      if (err.providerCode !== 'payout_account_exists') throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/** Same story for identities, which are also unique per environment. */
async function onboardVerifiedParty(label, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await ep.onboardParty({
        type: 'nin',
        identifier: verifiedNin(),
        email: `oartiste.${label}.${Date.now()}.${i}@gmail.com`,
        reference: ref(label),
      });
    } catch (err) {
      if (err.providerCode !== 'identity_already_exists') throw err;
      lastError = err;
    }
  }
  throw lastError;
}

function verifiedNin() {
  const head = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
  return `${head}${[0, 2, 4, 6, 8][Math.floor(Math.random() * 5)]}`;
}

const state = {};

describe('credential context confirms the key is on the test book', async () => {
  const ctx = await ep.credentialContext();
  assert.equal(ctx.environment, 'test', 'must never be pointed at the live book by accident');
  assert.equal(ctx.type, 'secret');
});

describe('health responds', async () => {
  const h = await ep.health();
  assert.ok(h.project);
});

describe('onboardParty verifies an identity and returns a party', async () => {
  const payer = await onboardVerifiedParty('payer');

  assert.match(payer.party.id, /^PAR_/);
  assert.equal(payer.party.status, 'active');
  assert.equal(payer.party.payout_eligible, true);
  // The provider masks the identifier; we never hold the raw NIN or BVN.
  assert.match(payer.identity.masked_identifier, /^\*+\d+$/);
  assert.equal(payer.identity.verification_status, 'verified');

  state.payerPartyId = payer.party.id;
});

describe('an odd-digit identifier fails verification with a reason, not a crash', async () => {
  // #10 must distinguish a retryable provider failure from a genuine rejection.
  await assert.rejects(
    () =>
      ep.onboardParty({
        type: 'nin',
        identifier: `${verifiedNin().slice(0, 10)}1`,
        email: `oartiste.fail.${Date.now()}@gmail.com`,
        reference: ref('fail'),
      }),
    (err) => {
      assert.equal(err.providerCode, 'identity_verification_failed');
      assert.match(err.providerMessage, /data_mismatch/);
      return true;
    }
  );
});

describe('createPayoutAccount registers a verified account for the artist', async () => {
  const artist = await onboardVerifiedParty('artist');
  state.artistPartyId = artist.party.id;

  const banks = await ep.listBanks();
  assert.ok(Array.isArray(banks) ? banks.length : banks.length !== 0);

  const account = await registerPayoutAccount(state.artistPartyId);

  assert.match(account.id, /^PAC_/);
  assert.equal(account.status, 'verified');
  assert.equal(account.payout_eligible, true);
  assert.match(account.masked_account_number, /^\*+\d+$/);
  assert.equal(account.rejection_reason, null);

  state.payoutAccountId = account.id;
});

describe('createEscrow creates a draft with our reference and the right policies', async () => {
  const reference = ref('escrow');
  state.reference = reference;

  const tx = await ep.createEscrow({
    reference,
    amountKobo: 20000000, // ₦200,000
    payerPartyId: state.payerPartyId,
    beneficiaryPartyId: state.artistPartyId,
    payoutAccountId: state.payoutAccountId,
    description: 'Artist booking — integration test',
  });

  assert.match(tx.id, /^TXN_/);
  assert.equal(tx.status, 'draft', 'created as draft; activation is a separate step');

  // Kobo passes straight through — amount_minor is already minor units.
  assert.equal(tx.amount_minor, 20000000);
  assert.equal(tx.currency, 'NGN');
  assert.equal(tx.external_reference, reference);

  // Nothing moves unless we instruct it.
  assert.equal(tx.release_policy, 'manual_only');
  assert.equal(tx.refund_policy, 'manual_only');

  // Never left at the default retain_in_wallet.
  assert.equal(tx.payout_preference, 'manual');
  assert.equal(tx.payout_account_id, state.payoutAccountId);

  // Deliberately not delegated to the provider.
  assert.equal(tx.automatic_release_at, null, 'release timing is ours alone');
  assert.equal(tx.marketplace_commission_bps, null, 'commission is computed and ledgered by us');

  state.transactionId = tx.id;
  state.version = tx.version;
});

describe('a repeated create with the same reference does not create a second escrow', async () => {
  // The acceptance criterion. Safe retry is the whole reason the reference is
  // self-generated rather than taken from the provider.
  const again = await ep.createEscrow({
    reference: state.reference,
    amountKobo: 20000000,
    payerPartyId: state.payerPartyId,
    beneficiaryPartyId: state.artistPartyId,
    payoutAccountId: state.payoutAccountId,
    description: 'Artist booking — integration test',
  });

  assert.equal(again.id, state.transactionId, 'the same transaction is returned, not a new one');
});

describe('getEscrow reads the transaction back', async () => {
  const tx = await ep.getEscrow(state.transactionId);
  assert.equal(tx.id, state.transactionId);
  assert.equal(tx.amount_minor, 20000000);
  assert.equal(tx.external_reference, state.reference);
});

describe('estimateFees returns the provider’s own numbers', async () => {
  // #14 currently hardcodes the published schedule; these are the real figures.
  const estimate = await ep.estimateFees({ amountKobo: 20000000 });
  assert.ok(estimate, 'a fee estimate is returned');
  console.log('   fee estimate for ₦200,000:', JSON.stringify(estimate).slice(0, 300));
});

describe('release and refund reject an unfunded transaction rather than half-acting', async () => {
  // Nothing has been funded, so neither may succeed. What matters is that the
  // failure is a clean provider error our layer translates, not a crash.
  for (const [name, fn] of [
    ['release', () => ep.release({ transactionId: state.transactionId, reference: ref('rel'), amountKobo: 1000000 })],
    ['refund', () => ep.refund({ transactionId: state.transactionId, reference: ref('ref'), amountKobo: 1000000 })],
  ]) {
    await assert.rejects(fn, (err) => {
      assert.equal(err.status, 502, `${name} surfaces as a provider error`);
      assert.ok(err.providerCode || err.providerMessage, `${name} carries diagnostics`);
      assert.ok(!JSON.stringify(err).includes(process.env.ESCROWPAY_API_KEY), 'never leaks the key');
      return true;
    });
  }
});

describe('amounts must be integers — no floats reach the provider', async () => {
  // Rejects rather than throwing synchronously, so callers using .catch() are
  // not caught out.
  await assert.rejects(
    () =>
      ep.createEscrow({
        reference: ref('float'),
        amountKobo: 20000000.5,
        payerPartyId: state.payerPartyId,
        beneficiaryPartyId: state.artistPartyId,
      }),
    /integer number of kobo/
  );
});
