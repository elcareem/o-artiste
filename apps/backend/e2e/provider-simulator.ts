/**
 * A local EscrowPay — issue #40.
 *
 * WHY THIS EXISTS. The EscrowPay public API cannot fund a sandbox escrow on its
 * own. Verified on 1 Oct 2026 against the live test book: a transaction
 * activates to `pending_funding`, and `POST /charges` returns a pending bank
 * transfer whose `next_action` is `display_bank_transfer` — "show the customer
 * this account". Something still has to make that transfer, and in test mode
 * only the provider's HOSTED CHECKOUT PAGE can; there is no documented endpoint
 * for it. So a script that must exit zero unattended, on every change, cannot
 * fund through the real sandbox.
 *
 * WHAT IT IS. A real HTTP server speaking the subset of EscrowPay v1 that
 * `lib/escrowpay.ts` uses, with `ESCROWPAY_BASE_URL` pointed at it. Our client
 * runs UNMODIFIED — request building, idempotency keys, the `{data}` envelope,
 * error mapping, retries — so everything on our side of the wire is the code
 * that ships. Nothing in `src/` is patched.
 *
 * Its behaviour is the behaviour observed in the sandbox, not invented:
 *   - parties and payout accounts are unique per environment (409s)
 *   - transactions are created `draft` and must be activated with `version`
 *   - checkout payment instructions carry amount PLUS the money-in fee
 *   - releases and refunds are sub-collections carrying their own amount
 *   - `GET /wallets` returns `{ items: [...] }`
 *   - domain errors are `{ detail: { code, message } }`
 *
 * And it adds one thing the real provider enforces that a mock usually does not:
 * MONEY CANNOT LEAVE AN ESCROW THAT IS NOT IN IT. A release or refund exceeding
 * what is held is refused with 409. If our code ever tries to move more than the
 * client paid, the e2e run fails at the provider boundary rather than recording a
 * ledger that happens to balance.
 *
 * Webhooks are delivered over real HTTP, HMAC-signed with the configured secret,
 * to our real `/webhooks/escrowpay` route — the same bytes-on-the-wire path the
 * provider uses.
 */

const http = require('node:http');
const crypto = require('node:crypto');

type Txn = {
  id: string;
  version: number;
  status: string;
  amount_minor: number;
  funded_minor: number;
  released_minor: number;
  refunded_minor: number;
  payer: string;
  beneficiary: string;
  external_reference: string | null;
};

/** The provider's own money-in fee, as verified against the test book (#14). */
function moneyInFee(kobo: number): number {
  if (kobo <= 25_000_000) return Math.min(Math.floor((kobo * 150) / 10_000) + 10_000, 200_000);
  return Math.floor((kobo * 80) / 10_000);
}

function createProviderSimulator({
  webhookSecret,
  webhookTarget,
  walletFloatKobo = 100_000_000,
}: {
  webhookSecret: string;
  /** Our app's webhook URL. Set after the app is listening. */
  webhookTarget?: string;
  /**
   * What our wallet holds before the run. Not zero, because the platform
   * genuinely fronts money — an artist cancellation reimburses the client's
   * funding fee from our wallet before the artist repays it (docs/05 §7) — and
   * a real business keeps a float for exactly that.
   */
  walletFloatKobo?: number;
}) {
  const parties = new Map<string, { id: string; identifier: string }>();
  const identifiers = new Set<string>();
  const accounts = new Set<string>();
  const txns = new Map<string, Txn>();
  const idempotent = new Map<string, { status: number; body: unknown }>();
  const deliveries: { eventId: string; type: string; objectId: string; raw: Buffer; status: number }[] = [];
  const log: { method: string; path: string; status: number }[] = [];
  const walletRefunds: { transactionId: string; amount: number }[] = [];
  const payouts: number[] = [];
  /** Releases, refunds and payouts by their own id — the provider can be asked. */
  const objects = new Map<string, { kind: string; transaction_id: string | null; amount_minor: number; status: string }>();

  // OUR WALLET, with a balance. A release credits it and a payout or a
  // wallet-sourced refund debits it — so paying an artist money that was never
  // released into the wallet fails here, the same way moving money out of an
  // escrow that does not hold it does.
  const wallet = { balance: walletFloatKobo, float: walletFloatKobo };
  const failNextPayout = { armed: false };

  let seq = 0;
  const id = (prefix: string) => `${prefix}_sim${Date.now().toString(36)}${(seq++).toString(36)}`;
  const state = { target: webhookTarget ?? null };

  const ok = (data: unknown, status = 200) => ({ status, body: { success: true, message: 'ok', data } });
  const fail = (status: number, code: string, message: string) => ({
    status,
    body: { detail: { code, message } },
  });

  const held = (t: Txn) => t.funded_minor - t.released_minor - t.refunded_minor;

  /** Signs and POSTs one event, exactly as the provider does. */
  async function deliver(type: string, object: string, objectId: string, data: unknown = {}) {
    if (!state.target) throw new Error('simulator has no webhook target');

    const eventId = id('EVT');
    const raw = Buffer.from(
      JSON.stringify({
        id: eventId,
        type,
        api_version: '2026-07-24',
        created_at: new Date().toISOString(),
        object,
        object_id: objectId,
        data,
      }),
      'utf8'
    );
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto
      .createHmac('sha256', webhookSecret)
      .update(Buffer.concat([Buffer.from(`${t}.`), raw]))
      .digest('hex');

    const headers = {
      'content-type': 'application/json',
      'escrowpay-signature': `t=${t},v1=${v1}`,
      'escrowpay-event-id': eventId,
      'escrowpay-delivery-id': id('WHDL'),
      'user-agent': 'EscrowPay-Webhooks/1.0 (simulator)',
    };

    const res = await fetch(state.target, { method: 'POST', headers, body: raw });
    deliveries.push({ eventId, type, objectId, raw, status: res.status });
    return { eventId, raw, headers, status: res.status };
  }

  /** Re-sends a delivery byte for byte, as a provider retry does. */
  async function redeliver(eventId: string) {
    const original = deliveries.find((d) => d.eventId === eventId);
    if (!original) throw new Error(`no delivery ${eventId} to replay`);

    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto
      .createHmac('sha256', webhookSecret)
      .update(Buffer.concat([Buffer.from(`${t}.`), original.raw]))
      .digest('hex');

    const res = await fetch(state.target!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'escrowpay-signature': `t=${t},v1=${v1}`,
        'escrowpay-event-id': eventId,
        'escrowpay-delivery-id': id('WHDL'),
      },
      body: original.raw,
    });
    return res.status;
  }

  function route(method: string, path: string, body: any): { status: number; body: unknown } | Promise<{ status: number; body: unknown }> {
    let m: RegExpMatchArray | null;

    if (method === 'GET' && path === '/api/v1/health') return ok({ status: 'ok' });
    if (method === 'GET' && path === '/api/v1/credential-context') {
      return ok({ environment: 'test', type: 'secret', scopes: ['*'], business_id: 'BUS_sim' });
    }
    if (method === 'GET' && path === '/api/v1/banks') {
      return ok({
        environment: 'test',
        source: 'simulator',
        banks: [
          { bank_code: '999', bank_name: 'EscrowPay Bank' },
          { bank_code: '000013', bank_name: 'GTBANK PLC (Simulator)' },
        ],
      });
    }

    if (method === 'POST' && path === '/api/v1/parties/onboard') {
      if (!body?.type || !body?.identifier || !body?.email) {
        return { status: 422, body: { detail: [{ loc: ['body'], msg: 'Field required' }] } };
      }
      if (identifiers.has(body.identifier)) {
        return fail(409, 'identity_already_exists', 'An identity with this identifier already exists in this environment.');
      }
      // The sandbox's own rule: an odd last digit is a failed verification.
      if (Number(String(body.identifier).slice(-1)) % 2 === 1) {
        return fail(422, 'identity_verification_failed', 'The identity could not be verified.');
      }
      identifiers.add(body.identifier);
      const party = { id: id('PAR'), identifier: body.identifier };
      parties.set(party.id, party);
      return ok(
        { party: { id: party.id, payout_eligible: true }, identity: { id: id('IDN'), status: 'verified' } },
        201
      );
    }

    if (method === 'POST' && path === '/api/v1/payout-accounts') {
      if (!body?.owner_id) return fail(400, 'validation_error', 'owner_id is required for a party owner.');
      const key = `${body.bank_code}:${body.account_number}`;
      if (accounts.has(key)) {
        return fail(409, 'payout_account_exists', 'This bank account is already registered in this environment.');
      }
      accounts.add(key);
      return ok(
        {
          id: id('PAC'),
          status: 'verified',
          masked_account_number: `******${String(body.account_number).slice(-4)}`,
          resolved_account_name: `SIMULATED ACCOUNT ${String(body.account_number).slice(-4)}`,
        },
        201
      );
    }

    if (method === 'POST' && path === '/api/v1/transactions') {
      const txn: Txn = {
        id: id('TXN'),
        version: 1,
        status: 'draft',
        amount_minor: body.amount_minor,
        funded_minor: 0,
        released_minor: 0,
        refunded_minor: 0,
        payer: body.payer?.party_id,
        beneficiary: body.beneficiary?.party_id,
        external_reference: body.external_reference ?? null,
      };
      if (!txn.payer || !txn.beneficiary) {
        return { status: 422, body: { detail: [{ loc: ['body', 'payer', 'party_id'], msg: 'Field required' }] } };
      }
      txns.set(txn.id, txn);
      return ok({ ...txn }, 201);
    }

    if ((m = path.match(/^\/api\/v1\/transactions\/([^/]+)$/)) && method === 'GET') {
      const t = txns.get(m[1]);
      return t ? ok({ ...t, next_actions: t.status === 'pending_funding' ? ['cancel', 'fund'] : [] }) : fail(404, 'resource_not_found', 'Resource not found.');
    }

    if ((m = path.match(/^\/api\/v1\/transactions\/([^/]+)\/activate$/)) && method === 'POST') {
      const t = txns.get(m[1]);
      if (!t) return fail(404, 'resource_not_found', 'Resource not found.');
      if (body?.version === undefined) {
        return { status: 422, body: { detail: [{ loc: ['body', 'version'], msg: 'Field required' }] } };
      }
      if (body.version !== t.version) return fail(409, 'version_conflict', 'The transaction has changed.');
      t.status = 'pending_funding';
      t.version++;
      return ok({ ...t });
    }

    if ((m = path.match(/^\/api\/v1\/transactions\/([^/]+)\/checkout-sessions$/)) && method === 'POST') {
      const t = txns.get(m[1]);
      if (!t) return fail(404, 'resource_not_found', 'Resource not found.');
      const token = crypto.randomBytes(16).toString('hex');
      return ok(
        {
          id: id('CSN'),
          transaction_id: t.id,
          status: 'open',
          hosted_url: `http://simulator.invalid/checkout/${token}`,
          amount_minor: t.amount_minor,
          payment_instructions: {
            account_number: crypto.randomBytes(5).toString('hex'),
            bank_code: '000',
            account_name: 'O-artist',
            // Amount plus the money-in fee: the client bears it, at funding.
            amount_minor: t.amount_minor + moneyInFee(t.amount_minor),
            currency: 'NGN',
            provider: 'simulator',
          },
        },
        201
      );
    }

    if ((m = path.match(/^\/api\/v1\/transactions\/([^/]+)\/(releases|refunds)$/)) && method === 'POST') {
      const t = txns.get(m[1]);
      if (!t) return fail(404, 'resource_not_found', 'Resource not found.');
      const amount = Number(body?.amount_minor);
      if (!Number.isInteger(amount) || amount <= 0) {
        return { status: 422, body: { detail: [{ loc: ['body', 'amount_minor'], msg: 'Must be a positive integer' }] } };
      }
      // Where a refund comes FROM. `escrow_held` (the default) is the client's
      // money in this escrow; `wallet_available` is OUR wallet — how an artist
      // cancellation reimburses the client's funding fee, which was paid to the
      // provider and never entered escrow (docs/05 §7). Only the first is bound
      // by what the escrow holds.
      const fromEscrow = m[2] === 'releases' || (body?.source ?? 'escrow_held') === 'escrow_held';

      // THE INVARIANT. A real escrow cannot disburse money it does not hold.
      if (fromEscrow && amount > held(t)) {
        return fail(
          409,
          'insufficient_held_funds',
          `Cannot move ${amount} minor units: only ${held(t)} is held on ${t.id}.`
        );
      }
      const leg = m[2] === 'releases' ? 'release' : 'refund';
      if (!fromEscrow && amount > wallet.balance) {
        return fail(409, 'insufficient_wallet_balance', `Wallet holds ${wallet.balance}; cannot refund ${amount}.`);
      }
      if (leg === 'release') {
        t.released_minor += amount;
        wallet.balance += amount; // payout_preference: manual — a release lands with us
      } else if (fromEscrow) {
        t.refunded_minor += amount;
      } else {
        wallet.balance -= amount;
        walletRefunds.push({ transactionId: t.id, amount });
      }
      t.version++;

      const objectId = id(leg === 'release' ? 'REL' : 'RFD');
      objects.set(objectId, { kind: leg, transaction_id: t.id, amount_minor: amount, status: 'completed' });
      // Delivered after the response, as the provider does — never inline. And
      // with `data: {}`, as the provider DOCUMENTS it: the event names its own
      // object and nothing else, so the handler has to ask which transaction it
      // belongs to. Sending the convenient `transaction_id` here is what let the
      // handler's lookup bug hide.
      setImmediate(() => {
        deliver(`${leg}.completed`, leg, objectId, {}).catch(() => {});
      });
      return ok({ id: objectId, status: 'completed', amount_minor: amount, transaction_id: t.id }, 201);
    }

    if ((m = path.match(/^\/api\/v1\/transactions\/([^/]+)\/fees$/)) && method === 'GET') {
      const t = txns.get(m[1]);
      if (!t) return fail(404, 'resource_not_found', 'Resource not found.');
      return ok({
        items: [{ fee_type: 'escrow_service', amount_minor: moneyInFee(t.amount_minor), payer: 'payer' }],
      });
    }

    if (method === 'POST' && path === '/api/v1/fees/estimates') {
      return ok({ amount_minor: body.amount_minor, fee_minor: moneyInFee(body.amount_minor) });
    }

    if ((m = path.match(/^\/api\/v1\/(releases|refunds|payouts)\/([^/]+)$/)) && method === 'GET') {
      const o = objects.get(m[2]);
      return o ? ok({ id: m[2], ...o }) : fail(404, 'resource_not_found', 'Resource not found.');
    }

    if (method === 'GET' && path === '/api/v1/wallets') {
      return ok({ items: [{ id: 'WAL_sim', currency: 'NGN', enabled: true }] });
    }

    if ((m = path.match(/^\/api\/v1\/wallets\/([^/]+)\/payouts$/)) && method === 'POST') {
      const amount = Number(body?.amount_minor);
      if (!Number.isInteger(amount) || amount <= 0) {
        return { status: 422, body: { detail: [{ loc: ['body', 'amount_minor'], msg: 'Must be a positive integer' }] } };
      }
      if (amount > wallet.balance) {
        return fail(409, 'insufficient_wallet_balance', `Wallet holds ${wallet.balance}; cannot pay out ${amount}.`);
      }
      wallet.balance -= amount;
      payouts.push(amount);
      const payoutId = id('PYO');
      objects.set(payoutId, { kind: 'payout', transaction_id: body?.transaction_id ?? null, amount_minor: amount, status: 'processing' });
      setImmediate(() => {
        if (failNextPayout.armed) {
          // Failed at the bank, after it was accepted: the money comes back to
          // the wallet and the provider says so.
          failNextPayout.armed = false;
          wallet.balance += amount;
          objects.get(payoutId)!.status = 'failed';
          deliver('payout.failed', 'payout', payoutId, {}).catch(() => {});
          return;
        }
        objects.get(payoutId)!.status = 'completed';
        deliver('payout.completed', 'payout', payoutId, {}).catch(() => {});
      });
      return ok({ id: payoutId, status: 'processing', amount_minor: body.amount_minor }, 201);
    }

    return fail(404, 'resource_not_found', `Simulator does not implement ${method} ${path}.`);
  }

  const server = http.createServer((req: any, res: any) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const path = (req.url ?? '').split('?')[0];
      let body: any = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      } catch {
        body = null;
      }

      // The real provider requires the key on every call. A request without one
      // is a bug in our client, and the simulator should say so rather than
      // quietly succeed.
      if (!req.headers['x-api-key']) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: { code: 'unauthorized', message: 'Missing API key.' } }));
        return;
      }

      // Idempotency, as the provider does it: the same key returns the first
      // response rather than repeating the action.
      const key = req.headers['idempotency-key'];
      const cacheKey = key ? `${req.method} ${path} ${key}` : null;
      let result = cacheKey ? idempotent.get(cacheKey) : undefined;
      if (!result) {
        result = await route(req.method, path, body);
        if (cacheKey && result.status < 500) idempotent.set(cacheKey, result);
      }

      log.push({ method: req.method, path, status: result.status });
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });

  return {
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}/api/v1`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setWebhookTarget(url: string) {
      state.target = url;
    },

    /**
     * The client pays. In the real sandbox this is a person on the hosted
     * checkout page; here it is the simulator crediting the escrow and
     * delivering `transaction.funded`, as the provider would on settlement.
     */
    async pay(transactionId: string, { shortBy = 0 } = {}) {
      const t = txns.get(transactionId);
      if (!t) throw new Error(`no transaction ${transactionId}`);
      t.funded_minor = t.amount_minor - shortBy;
      t.status = shortBy > 0 ? 'partially_funded' : 'funded';
      t.version++;
      return deliver(
        shortBy > 0 ? 'transaction.partially_funded' : 'transaction.funded',
        'transaction',
        t.id,
        { funded_minor: t.funded_minor }
      );
    },

    redeliver,
    /** The next payout is accepted and then fails at the bank. */
    failNextPayout() {
      failNextPayout.armed = true;
    },
    transaction: (txnId: string) => txns.get(txnId),
    deliveries,
    log,
    walletRefunds,
    payouts,
    wallet,
    heldOn: (txnId: string) => {
      const t = txns.get(txnId);
      return t ? held(t) : null;
    },
  };
}

module.exports = { createProviderSimulator, moneyInFee };
