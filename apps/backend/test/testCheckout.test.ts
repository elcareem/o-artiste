/**
 * The test-mode checkout link — issue #49.
 *
 * In the sandbox, EscrowPay's hosted checkout is the only way to pay; the bank
 * account it gives is simulated. With a live key the link must never appear:
 * there, the real bank transfer is how a client pays.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { fundingInstructionFor } = require('../src/services/escrowService.ts');

const booking = { id: 'b1', escrowReference: 'ref', escrowId: 'TXN_1', state: 'PENDING_PAYMENT', amountKobo: 20000000 };
const session = {
  hosted_url: 'https://business.escrowpay.app/checkout/tok',
  allowed_channels: ['bank_transfer'],
  payment_instructions: { account_number: '9aa33bf5ad', account_name: 'O-artist', amount_minor: 20200000 },
};

function withKey(key: string | undefined, fn: () => void) {
  const saved = process.env.ESCROWPAY_API_KEY;
  if (key === undefined) delete process.env.ESCROWPAY_API_KEY;
  else process.env.ESCROWPAY_API_KEY = key;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.ESCROWPAY_API_KEY;
    else process.env.ESCROWPAY_API_KEY = saved;
  }
}

test('with a test key, the hosted checkout link is passed to the page', () => {
  withKey('sk_test_abc.def', () => {
    assert.equal(fundingInstructionFor(booking, session).testCheckoutUrl, session.hosted_url);
  });
});

test('with a LIVE key, it never is — the real bank transfer is the way to pay', () => {
  withKey('sk_live_abc.def', () => {
    const f = fundingInstructionFor(booking, session);
    assert.equal(f.testCheckoutUrl, null);
    // The bank transfer is unaffected.
    assert.equal(f.bankTransfer.accountNumber, '9aa33bf5ad');
  });
});

test('no key at all is treated as not-test', () => {
  withKey(undefined, () => {
    assert.equal(fundingInstructionFor(booking, session).testCheckoutUrl, null);
  });
});

test('no session means no link, in either mode', () => {
  withKey('sk_test_abc.def', () => {
    assert.equal(fundingInstructionFor(booking, undefined).testCheckoutUrl, null);
  });
});

test('on a later visit, the stored link is used — EscrowPay omits it after creation', () => {
  // Observed against the sandbox: the first checkout-session call carries
  // hosted_url; every repeat with the same reference returns the same session
  // WITHOUT it. The first live check of #49 showed the button missing for
  // exactly this reason.
  const repeat = { ...session, hosted_url: undefined };
  const stored = { ...booking, testCheckoutUrl: 'https://business.escrowpay.app/checkout/stored' };
  withKey('sk_test_abc.def', () => {
    assert.equal(fundingInstructionFor(stored, repeat).testCheckoutUrl, stored.testCheckoutUrl);
  });
});

test('a stored link is never shown with a live key either', () => {
  const stored = { ...booking, testCheckoutUrl: 'https://business.escrowpay.app/checkout/stored' };
  withKey('sk_live_abc.def', () => {
    assert.equal(fundingInstructionFor(stored, { ...session, hosted_url: undefined }).testCheckoutUrl, null);
  });
});
