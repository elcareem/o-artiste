/**
 * End-to-end lifecycle verification — issue #40.
 *
 * Drives the REAL backend over HTTP as its real users would — a client, an
 * artist and an admin, each holding their own token — through every outcome
 * path, and asserts after each one that the money balances.
 *
 * Two provider modes:
 *
 *   simulator (default) — a local HTTP server speaking EscrowPay's API, with the
 *     semantics observed in the live sandbox. Unattended, exits zero, runs on
 *     every change. See provider-simulator.ts for why the real sandbox cannot do
 *     this on its own.
 *
 *   sandbox (E2E_PROVIDER=sandbox) — the real EscrowPay test book for every
 *     provider call. The one step the public API cannot perform — the client's
 *     transfer — is done by a person on the hosted checkout page this script
 *     prints. Our webhook handler re-reads the transaction from the provider and
 *     checks `funded_minor` before it funds anything, so a booking only advances
 *     if the real provider agrees the money arrived.
 *
 * Time is the other thing a script cannot wait for. An event has to END before
 * it can be confirmed, and auto-release fires days later. Where a scenario needs
 * the clock moved, it rewrites the booking's event times in the database through
 * `timeTravel`, and every use is printed — a test that bends time silently is a
 * test whose passing means less than it appears to.
 */

process.loadEnvFile?.(require('node:path').resolve(__dirname, '../.env'));

const crypto = require('node:crypto');
const path = require('node:path');

const MODE = (process.env.E2E_PROVIDER ?? 'simulator').toLowerCase();
if (!['simulator', 'sandbox'].includes(MODE)) {
  console.error(`E2E_PROVIDER must be "simulator" or "sandbox", not "${MODE}".`);
  process.exit(2);
}

// --- Isolation, set BEFORE anything requires Prisma or the queue. ----------
process.env.QUEUE_PREFIX = `e2e-${process.pid}-${Date.now()}`;
// No SMS or email in an e2e run: notifications go to the logged stub, which is
// the degraded-not-broken path #38 guarantees cannot affect money.
delete process.env.SMS_API_KEY;
delete process.env.EMAIL_API_KEY;

const { createProviderSimulator, moneyInFee } = require('./provider-simulator.ts');

const N = (naira: number) => naira * 100;
const PASSWORD = 'correct horse battery staple e2e';
const DOMAIN = 'sandbox.o-artiste.app'; // the provider rejects reserved domains such as .test
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A NIN the sandbox will verify: identifiers are unique per environment, and an even last digit verifies. */
const freshNin = () =>
  String(crypto.randomInt(0, 1e10)).padStart(10, '0') + String([0, 2, 4, 6, 8][crypto.randomInt(0, 5)]);
const freshAccount = () => String(crypto.randomInt(0, 1e10)).padStart(10, '0');
const freshPhone = () => `+23480${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type Outcome = { name: string; ok: boolean; detail: string; ms: number };
const outcomes: Outcome[] = [];

class Failure extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failure(message);
}

async function scenario(name: string, fn: () => Promise<string | void>) {
  const started = Date.now();
  process.stdout.write(`  ${name} … `);
  try {
    const detail = (await fn()) ?? '';
    outcomes.push({ name, ok: true, detail, ms: Date.now() - started });
    console.log(`\x1b[32mok\x1b[0m ${detail ? `— ${detail}` : ''}`);
  } catch (err) {
    const detail = err instanceof Failure ? err.message : `${(err as Error).message}\n${(err as Error).stack}`;
    outcomes.push({ name, ok: false, detail, ms: Date.now() - started });
    console.log(`\x1b[31mFAILED\x1b[0m\n      ${detail.split('\n').join('\n      ')}`);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

(async () => {
  console.log(`\ne2e lifecycle verification — provider: ${MODE}\n`);

  let sim: ReturnType<typeof createProviderSimulator> | null = null;
  if (MODE === 'simulator') {
    // A secret of our own: the simulator signs with it and the app verifies with
    // it, so the real signature check runs on every delivery.
    process.env.ESCROWPAY_WEBHOOK_SECRET = `whsec_e2e_${crypto.randomBytes(16).toString('hex')}`;
    process.env.ESCROWPAY_API_KEY = 'sk_test_e2e_simulator';
    sim = createProviderSimulator({ webhookSecret: process.env.ESCROWPAY_WEBHOOK_SECRET });
    process.env.ESCROWPAY_BASE_URL = await sim.listen();
  } else {
    for (const v of ['ESCROWPAY_API_KEY', 'ESCROWPAY_WEBHOOK_SECRET']) {
      if (!process.env[v]) {
        console.error(`Sandbox mode needs ${v}.`);
        process.exit(2);
      }
    }
    if (!String(process.env.ESCROWPAY_API_KEY).startsWith('sk_test_')) {
      // Never against the live book. A script that creates escrows and moves
      // money must not be one environment variable away from doing it for real.
      console.error('Refusing to run: ESCROWPAY_API_KEY is not a sk_test_ key.');
      process.exit(2);
    }
  }

  // Now — and only now — the app and its database.
  const { prisma, hasDatabase, ready } = require('../test/db.ts')('e2e');
  if (!hasDatabase) {
    console.error('No DATABASE_URL — the e2e run needs a real PostgreSQL.');
    process.exit(2);
  }
  await ready;

  const { createApp } = require('../src/app.ts');
  const { startServer } = require('../test/helpers.ts');
  const { registerRouter, registerWorker, closeAll } = require('../src/lib/queue.ts');
  const checkInCodeJob = require('../src/jobs/checkInCodeJob.ts');
  const notificationJob = require('../src/jobs/notificationJob.ts');
  const autoReleaseJob = require('../src/jobs/autoReleaseJob.ts');
  const webhookRetryJob = require('../src/jobs/webhookRetryJob.ts');
  const escrowpay = require('../src/lib/escrowpay.ts');

  const server = await startServer(createApp());
  const WEBHOOK_URL = `${server.url}/webhooks/escrowpay`;
  sim?.setWebhookTarget(WEBHOOK_URL);

  // The real workers, so queued work actually runs.
  const workers = [
    registerRouter(checkInCodeJob.QUEUE_NAME, {
      [checkInCodeJob.JOB_NAME]: checkInCodeJob.process,
      [notificationJob.JOB_NAME]: notificationJob.process,
    }),
    registerWorker(webhookRetryJob.QUEUE_NAME, webhookRetryJob.process),
  ];

  // --- HTTP as a user ------------------------------------------------------

  async function call(method: string, url: string, token?: string | null, body?: unknown) {
    const res = await fetch(`${server.url}${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, body: json };
  }

  async function expectOk(method: string, url: string, token: string | null, body?: unknown, want = [200, 201]) {
    const r = await call(method, url, token, body);
    check(want.includes(r.status), `${method} ${url} → ${r.status}: ${r.body?.error ?? JSON.stringify(r.body)}`);
    return r.body;
  }

  // --- Actors --------------------------------------------------------------

  type Actor = { token: string; userId: string; email: string };

  async function register(role: 'CLIENT' | 'ARTIST', name: string): Promise<Actor> {
    const email = `${role.toLowerCase()}-${uniq()}@${DOMAIN}`;
    const body = await expectOk('POST', '/auth/register', null, {
      email,
      phone: freshPhone(),
      password: PASSWORD,
      role,
      ...(role === 'CLIENT' ? { displayName: name } : { stageName: name }),
    });
    const actor = { token: body.token, userId: body.user.id, email };

    // Identity verification through the provider, as onboarding does it.
    await expectOk('POST', '/me/verification', actor.token, { method: 'NIN', identifier: freshNin() });
    return actor;
  }

  /** A listable artist with a payout account — the minimum to be bookable and payable. */
  async function makeArtist(name: string) {
    const actor = await register('ARTIST', name);
    const { artist } = await expectOk('GET', '/me/artist-profile', actor.token);
    await expectOk('PUT', `/artists/${artist.id}`, actor.token, {
      category: 'Afrobeats',
      location: 'Lagos',
      bio: 'An artist created by the e2e run.',
      baseRateKobo: N(200000),
    });
    await expectOk('PUT', '/artists/me/payout-account', actor.token, {
      bankCode: '000013',
      accountNumber: freshAccount(),
      accountName: name,
    });
    return { ...actor, artistId: artist.id as string };
  }

  /**
   * Admins cannot be created through the public API — by design (#9). This is
   * what `scripts/create-admin.ts` does, minus the interactive prompt.
   */
  async function makeAdmin(role: 'ADMIN' | 'SUPER_ADMIN'): Promise<Actor> {
    const { hashPassword } = require('../src/lib/auth.ts');
    const email = `${role.toLowerCase().replace('_', '-')}-${uniq()}@${DOMAIN}`;
    const user = await prisma.user.create({
      data: {
        email,
        phone: freshPhone(),
        passwordHash: await hashPassword(PASSWORD),
        role,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    });
    const { token } = await expectOk('POST', '/auth/login', null, { email, password: PASSWORD });
    return { token, userId: user.id, email };
  }

  // --- Time ----------------------------------------------------------------

  /**
   * Moves a booking's event relative to now. Printed every time — see the
   * module note.
   */
  async function timeTravel(bookingId: string, { startsInHours, lastsHours = 3 }: { startsInHours: number; lastsHours?: number }) {
    const eventDate = new Date(Date.now() + startsInHours * 3600_000);
    const eventEndAt = new Date(eventDate.getTime() + lastsHours * 3600_000);

    // The check-in window is stored on the booking when the code is issued at
    // funding, so moving the event without moving the window would test a
    // booking that cannot exist. Recomputed with the real rule, not a copy of it.
    const current = await prisma.booking.findUnique({ where: { id: bookingId }, select: { checkInCode: true } });
    const window = current?.checkInCode
      ? require('../src/services/checkInService.ts').windowFor({ eventDate, eventEndAt })
      : null;

    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        eventDate,
        eventEndAt,
        ...(window ? { checkInCodeValidFrom: window.validFrom, checkInCodeValidTo: window.validTo } : {}),
      },
    });
    console.log(
      `\n      ⏱  time travel: booking ${bookingId.slice(-6)} event now ${startsInHours >= 0 ? 'starts in' : 'started'} ` +
        `${Math.abs(startsInHours)}h ${startsInHours + lastsHours < 0 ? '(and has ended)' : ''}`
    );
  }

  // --- Booking lifecycle steps --------------------------------------------

  type Parties = { client: Actor; artist: Awaited<ReturnType<typeof makeArtist>> };

  async function book(p: Parties, { amountKobo = N(200000), daysOut = 10 } = {}) {
    const eventDate = new Date(Date.now() + daysOut * 86400_000);
    const { booking } = await expectOk('POST', '/bookings', p.client.token, {
      artistId: p.artist.artistId,
      amountKobo,
      eventDate: eventDate.toISOString(),
      eventEndAt: new Date(eventDate.getTime() + 3 * 3600_000).toISOString(),
      eventLocation: 'Eko Hotel, Lagos',
    });

    // The client acknowledges the terms AS DISPLAYED — the precondition for
    // funding (#16).
    const { terms } = await expectOk('GET', `/bookings/${booking.id}/terms`, p.client.token);
    await expectOk('POST', `/bookings/${booking.id}/terms/acknowledge`, p.client.token, {
      acknowledged: true,
      tiersAsDisplayed: terms.tiers ?? terms.cancellationTiers ?? terms,
    });
    return booking as { id: string; amountKobo: number; escrowReference: string };
  }

  /** The provider transaction behind a booking. The driver plays the provider, so it may know this. */
  async function escrowIdOf(bookingId: string): Promise<string> {
    const row = await prisma.booking.findUnique({ where: { id: bookingId }, select: { escrowId: true } });
    check(row?.escrowId, `booking ${bookingId} has no escrow id after funding was requested`);
    return row.escrowId;
  }

  async function waitForState(bookingId: string, token: string, want: string[], timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      const r = await call('GET', `/bookings/${bookingId}`, token);
      last = r.body?.booking?.state;
      if (want.includes(last)) return last;
      await new Promise((r2) => setTimeout(r2, 300));
    }
    throw new Failure(`booking ${bookingId} stayed ${last}, expected ${want.join(' or ')}`);
  }

  const fundedEvents = new Map<string, string>(); // bookingId → funded event id

  /** The client pays. See the module note on how each mode does this. */
  async function fund(p: Parties, bookingId: string) {
    const { funding } = await expectOk('POST', `/bookings/${bookingId}/funding`, p.client.token);
    const escrowId = await escrowIdOf(bookingId);

    if (sim) {
      const delivery = await sim.pay(escrowId);
      check(delivery.status === 200, `funded webhook → ${delivery.status}`);
      fundedEvents.set(bookingId, delivery.eventId);
    } else {
      const url = funding?.hostedUrl ?? funding?.checkoutUrl ?? funding?.hosted_url;
      console.log(`\n      💳 pay this in the sandbox simulator, then wait:\n         ${url}`);
      const deadline = Date.now() + 10 * 60_000;
      let txn: any;
      do {
        await new Promise((r) => setTimeout(r, 5000));
        txn = await escrowpay.getEscrow(escrowId);
      } while (Number(txn.funded_minor ?? 0) < Number(txn.amount_minor) && Date.now() < deadline);
      check(Number(txn.funded_minor) >= Number(txn.amount_minor), 'not funded within 10 minutes');

      // The provider's own delivery went to the registered URL, not this
      // process. Re-delivered locally, signed with the real secret — and the
      // handler re-reads the REAL transaction before it funds anything.
      const eventId = `EVT_e2e_${uniq()}`;
      const raw = Buffer.from(JSON.stringify({ id: eventId, type: 'transaction.funded', object: 'transaction', object_id: escrowId, data: {} }));
      const t = Math.floor(Date.now() / 1000);
      const v1 = crypto.createHmac('sha256', process.env.ESCROWPAY_WEBHOOK_SECRET!).update(Buffer.concat([Buffer.from(`${t}.`), raw])).digest('hex');
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'escrowpay-signature': `t=${t},v1=${v1}`, 'escrowpay-event-id': eventId },
        body: raw,
      });
      check(res.status === 200, `funded webhook → ${res.status}`);
      fundedEvents.set(bookingId, eventId);
    }

    await waitForState(bookingId, p.client.token, ['FUNDED_HELD']);
    return escrowId;
  }

  /** The artist arrives and redeems the code the client reads them. */
  async function checkIn(p: Parties, bookingId: string) {
    await timeTravel(bookingId, { startsInHours: 0.5 });
    const { checkIn: ci } = await expectOk('GET', `/bookings/${bookingId}/check-in-code`, p.client.token);
    check(ci?.code, 'the client could not read their check-in code');
    await expectOk('POST', `/bookings/${bookingId}/check-in`, p.artist.token, { code: ci.code });
    await waitForState(bookingId, p.client.token, ['CHECKED_IN']);
  }

  async function eventEnds(bookingId: string) {
    await timeTravel(bookingId, { startsInHours: -4, lastsHours: 3 });
  }

  /**
   * Both parties confirm, artist first.
   *
   * The order matters, and it is the confirmation matrix (#24), not the harness:
   * with a check-in on record, the CLIENT's confirmation is sufficient on its
   * own and releases the money. An artist confirming after that is told the
   * booking "has already been paid out". So the artist goes first — their
   * confirmation waits for the client's — and the client's releases.
   */
  async function bothConfirm(p: Parties, bookingId: string) {
    await expectOk('POST', `/bookings/${bookingId}/confirm`, p.artist.token);
    const mid = await call('GET', `/bookings/${bookingId}`, p.client.token);
    check(
      mid.body?.booking?.state === 'AWAITING_CONFIRMATION',
      `the artist's confirmation alone moved the booking to ${mid.body?.booking?.state} — it should wait for the client`
    );
    await expectOk('POST', `/bookings/${bookingId}/confirm`, p.client.token);
  }

  // --- The assertion every scenario ends with ------------------------------

  /**
   * THE WIDEST-CATCHING CHECK IN THE SYSTEM (#40). If the entries sum to zero
   * the money went where the rules say it should.
   *
   * Two sides of it: OUR ledger reconciles — read through the admin view, which
   * is the number an operator would actually see — and the PROVIDER's escrow is
   * empty, so the ledger is not balancing over money that is still sitting
   * somewhere.
   */
  async function assertReconciles(admin: Actor, bookingId: string, expectedState: string[]) {
    const detail = await expectOk('GET', `/admin/bookings/${bookingId}`, admin.token);
    check(
      expectedState.includes(detail.booking.state),
      `ended ${detail.booking.state}, expected ${expectedState.join(' or ')}`
    );
    check(detail.ledger.entryCount > 0, 'concluded with no ledger entries at all');
    check(
      detail.ledger.sumKobo === 0 && detail.ledger.balanced === true,
      `ledger does not reconcile: sums to ${detail.ledger.sumKobo} kobo — ${JSON.stringify(detail.ledger.netByParty)}`
    );

    const escrowId = await escrowIdOf(bookingId);
    const txn = await escrowpay.getEscrow(escrowId);
    const held = Number(txn.funded_minor ?? 0) - Number(txn.released_minor ?? 0) - Number(txn.refunded_minor ?? 0);
    check(held === 0, `the provider still holds ${held} kobo on ${escrowId} after the booking concluded`);

    return detail;
  }

  // --- Replay ----------------------------------------------------------------

  /** Everything a duplicate processing would change. */
  async function snapshot(bookingId: string) {
    const [booking, entries, events, transitions] = await Promise.all([
      prisma.booking.findUnique({ where: { id: bookingId }, select: { state: true } }),
      prisma.ledgerEntry.findMany({ where: { bookingId }, select: { entryType: true, party: true, amountKobo: true } }),
      prisma.webhookEvent.count(),
      prisma.bookingStateTransition.count({ where: { bookingId } }),
    ]);
    return { state: booking.state, entries, events, transitions };
  }

  /**
   * The replay assertion. Returns a list of problems rather than throwing, so
   * the teeth proof below can show it REPORTING a failure.
   */
  function duplicationProblems(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>): string[] {
    const problems: string[] = [];
    if (after.state !== before.state) problems.push(`state moved ${before.state} → ${after.state}`);
    if (after.entries.length !== before.entries.length) {
      problems.push(`ledger entries ${before.entries.length} → ${after.entries.length}`);
    }
    const sum = (e: { amountKobo: number }[]) => e.reduce((t, x) => t + x.amountKobo, 0);
    if (sum(after.entries) !== sum(before.entries)) problems.push(`ledger sum ${sum(before.entries)} → ${sum(after.entries)}`);
    if (after.transitions !== before.transitions) {
      problems.push(`state transitions ${before.transitions} → ${after.transitions}`);
    }
    return problems;
  }

  async function replayFunded(bookingId: string) {
    const eventId = fundedEvents.get(bookingId);
    check(eventId, `no funded event recorded for ${bookingId}`);
    if (sim) return sim.redeliver(eventId);
    throw new Failure('replay in sandbox mode is not implemented — run it in simulator mode');
  }

  // =========================================================================
  // Setup
  // =========================================================================

  console.log('setup');
  const superAdmin = await makeAdmin('SUPER_ADMIN');
  const admin = await makeAdmin('ADMIN');

  await expectOk('PUT', '/admin/config/commission', superAdmin.token, {
    rateBasisPoints: 500,
    reason: 'e2e run: the launch commission rate.',
  });
  const TIERS = [
    { minDaysBefore: 7, maxDaysBefore: null, clientRefundBps: 10000, artistCompensationBps: 0 },
    { minDaysBefore: 3, maxDaysBefore: 6, clientRefundBps: 7000, artistCompensationBps: 3000 },
    { minDaysBefore: 1, maxDaysBefore: 2, clientRefundBps: 4000, artistCompensationBps: 6000 },
    { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8500 },
  ];
  await expectOk('PUT', '/admin/config/cancellation-tiers', superAdmin.token, {
    tiers: TIERS,
    reason: 'e2e run: the launch cancellation table.',
  });
  console.log(`  config published, admins created, provider at ${process.env.ESCROWPAY_BASE_URL}\n`);

  const newParties = async (label: string): Promise<Parties> => ({
    client: await register('CLIENT', `Client ${label}`),
    artist: await makeArtist(`Artist ${label}`),
  });

  // =========================================================================
  // Scenarios
  // =========================================================================

  console.log('scenarios');

  await scenario('happy path: book → fund → check in → both confirm → release', async () => {
    const p = await newParties('happy');
    const b = await book(p);
    await fund(p, b.id);
    await checkIn(p, b.id);
    await eventEnds(b.id);
    await bothConfirm(p, b.id);
    await waitForState(b.id, p.client.token, ['RELEASED']);
    const d = await assertReconciles(admin, b.id, ['RELEASED']);

    const expectedArtist = b.amountKobo - Math.floor((b.amountKobo * 500) / 10000);
    check(d.ledger.netByParty.ARTIST === expectedArtist, `artist net ${d.ledger.netByParty.ARTIST}, expected ${expectedArtist}`);
    check(
      d.ledger.netByParty.CLIENT === -(b.amountKobo + moneyInFee(b.amountKobo)),
      `client net ${d.ledger.netByParty.CLIENT}, expected amount plus the money-in fee`
    );
    return `artist ₦${expectedArtist / 100}, client paid ₦${(b.amountKobo + moneyInFee(b.amountKobo)) / 100}`;
  });

  await scenario('webhook replay changes nothing', async () => {
    const p = await newParties('replay');
    const b = await book(p);
    await fund(p, b.id);

    const before = await snapshot(b.id);
    const status = await replayFunded(b.id);
    check(status === 200, `the replay was not acknowledged (${status}) — the provider would keep retrying`);
    await new Promise((r) => setTimeout(r, 500));

    const problems = duplicationProblems(before, await snapshot(b.id));
    check(problems.length === 0, `a replayed webhook changed state: ${problems.join('; ')}`);
    return 'same event id delivered twice, processed once';
  });

  await scenario('…and the replay assertion has teeth: it fails when idempotency is broken', async () => {
    const p = await newParties('teeth');
    const b = await book(p);
    await fund(p, b.id);
    const before = await snapshot(b.id);

    // DELIBERATELY BREAK IDEMPOTENCY, at both layers it has: forget that the
    // event was ever seen, and rewind the booking to before it was funded —
    // exactly the state a handler without dedupe would find on a redelivery.
    const eventId = fundedEvents.get(b.id)!;
    await prisma.webhookEvent.deleteMany({ where: { providerEventId: eventId } });
    await prisma.booking.update({
      where: { id: b.id },
      data: { state: 'PENDING_PAYMENT', checkInCode: null, fundedAt: null },
    });

    await replayFunded(b.id);
    await new Promise((r) => setTimeout(r, 500));

    const problems = duplicationProblems(before, await snapshot(b.id));
    check(
      problems.length > 0,
      'NO TEETH: idempotency was deliberately broken and the replay assertion still passed'
    );
    return `broken idempotency detected — ${problems.join('; ')}`;
  });

  await scenario('a payout that fails at the bank puts the artist back on the owed list', async () => {
    check(sim, 'needs the simulator: the sandbox cannot be told to fail a payout');
    const p = await newParties('payoutfail');
    const b = await book(p);
    await fund(p, b.id);
    await checkIn(p, b.id);
    await eventEnds(b.id);

    // Accepted by the provider, then bounced by the bank — the case where
    // `paidOutAt` has already been set when the bad news arrives.
    sim!.failNextPayout();
    await bothConfirm(p, b.id);
    await waitForState(b.id, p.client.token, ['RELEASED']);

    // The provider's `payout.failed` arrives asynchronously.
    const deadline = Date.now() + 10_000;
    let row: any;
    do {
      await new Promise((r) => setTimeout(r, 200));
      row = await prisma.booking.findUnique({ where: { id: b.id }, select: { paidOutAt: true, payoutFailureReason: true, payoutId: true } });
    } while (row.paidOutAt !== null && Date.now() < deadline);

    // THE BOOKING STOPS CLAIMING THE ARTIST WAS PAID. Before #40 the failure
    // event never matched a booking, so this stayed set for good.
    check(row.paidOutAt === null, 'the booking still says the artist was paid after the payout failed');
    check(row.payoutFailureReason, 'no reason was recorded for the failure');
    check(row.payoutId, 'the payout id was discarded — the provider retry needs it');

    // And the operator can see it.
    const owed = await expectOk('GET', '/admin/payouts/awaiting', admin.token);
    const list = owed.bookings ?? owed.awaiting ?? owed.payouts ?? owed;
    check(
      Array.isArray(list) && list.some((x: any) => (x.id ?? x.bookingId) === b.id),
      'the failed payout is not on the awaiting-payout list'
    );

    // The money is still correct on both sides: released into our wallet, and
    // the bounced payout returned to it.
    await assertReconciles(admin, b.id, ['RELEASED']);
    return 'paidOutAt cleared, reason recorded, listed as owed';
  });

  await scenario('auto-release on client silence', async () => {
    const p = await newParties('silent');
    const b = await book(p);
    await fund(p, b.id);
    await checkIn(p, b.id);
    await eventEnds(b.id);

    // The grace period has passed with no word from the client.
    await prisma.booking.update({ where: { id: b.id }, data: { autoReleaseAt: new Date(Date.now() - 60_000) } });
    console.log(`\n      ⏱  time travel: auto-release deadline for ${b.id.slice(-6)} moved into the past`);
    await autoReleaseJob.process({ data: { bookingId: b.id } });

    await waitForState(b.id, p.client.token, ['RELEASED']);
    await assertReconciles(admin, b.id, ['RELEASED']);
    return 'released with no confirmation from the client';
  });

  for (const [daysOut, tier] of [
    [10, TIERS[0]],
    [4, TIERS[1]],
    [2, TIERS[2]],
    [0, TIERS[3]],
  ] as const) {
    await scenario(
      `client cancellation, ${daysOut} days out (${tier.clientRefundBps / 100}% back to the client)`,
      async () => {
        const p = await newParties(`cxl${daysOut}`);
        const b = await book(p);
        await fund(p, b.id);

        // Into the band under test. Day 0 is later the same day: the event is
        // still ahead, and the band is decided by whole days remaining.
        await timeTravel(b.id, { startsInHours: daysOut === 0 ? 6 : daysOut * 24 + 6 });

        const preview = await expectOk('GET', `/bookings/${b.id}/cancellation-preview`, p.client.token);
        await expectOk('POST', `/bookings/${b.id}/cancel`, p.client.token, { reason: 'Plans changed.' });
        await waitForState(b.id, p.client.token, ['CANCELLED']);
        const d = await assertReconciles(admin, b.id, ['CANCELLED']);

        const cancellation = d.cancellation;
        check(cancellation, 'the cancellation is not reachable from the admin detail');

        // THE BAND THAT APPLIED, asserted by its money: the client's share is the
        // tier's percentage of the booking, floored (R1), and the artist's is the
        // remainder less commission. A wrong band shows up here as a wrong amount.
        const clientShare = Math.floor((b.amountKobo * tier.clientRefundBps) / 10000);
        const artistShare = b.amountKobo - clientShare;
        const artistNet = artistShare - Math.floor((artistShare * 500) / 10000);
        check(
          cancellation.clientRefundKobo === clientShare,
          `${daysOut} days out: refunded ₦${cancellation.clientRefundKobo / 100}, the band says ₦${clientShare / 100}`
        );
        check(
          cancellation.artistCompensationKobo === artistNet,
          `${daysOut} days out: artist got ₦${cancellation.artistCompensationKobo / 100}, the band says ₦${artistNet / 100}`
        );
        // What the client was shown before confirming is what moved.
        const shown = preview?.preview?.clientRefundKobo ?? preview?.clientRefundKobo;
        if (shown !== undefined) {
          check(
            cancellation.clientRefundKobo === shown,
            `previewed a ₦${shown / 100} refund, executed ₦${cancellation.clientRefundKobo / 100}`
          );
        }
        return `refund ₦${cancellation.clientRefundKobo / 100}, artist ₦${cancellation.artistCompensationKobo / 100}`;
      }
    );
  }

  await scenario('artist cancellation accrues a fee liability, settled from their next payout', async () => {
    const p = await newParties('artistcxl');

    // Booking A: the artist cancels. The client gets everything back, plus the
    // funding fee, and the artist owes the fees.
    const a = await book(p);
    await fund(p, a.id);
    await expectOk('POST', `/bookings/${a.id}/cancel`, p.artist.token, { reason: 'Double-booked, my mistake.' });
    // REFUNDED, not CANCELLED: an artist cancelling a FUNDED booking returns all
    // of the client's money, and the state says where the money went (#28).
    await waitForState(a.id, p.client.token, ['REFUNDED']);
    await assertReconciles(admin, a.id, ['REFUNDED']);

    const owed = await prisma.feeLiability.findMany({ where: { artistUserId: p.artist.userId } });
    check(owed.length > 0, 'no fee liability accrued for the artist');
    const owedKobo = owed.reduce((t: number, l: any) => t + l.amountKobo, 0);

    // Booking B, same artist, completes — and the liability comes out of it.
    const b = await book(p);
    await fund(p, b.id);
    await checkIn(p, b.id);
    await eventEnds(b.id);
    await bothConfirm(p, b.id);
    await waitForState(b.id, p.client.token, ['RELEASED']);
    const d = await assertReconciles(admin, b.id, ['RELEASED']);

    const after = await prisma.feeLiability.findMany({ where: { artistUserId: p.artist.userId } });
    const unsettled = after.filter((l: any) => !l.settledAt && !l.settledByBookingId && l.status !== 'SETTLED');
    check(unsettled.length === 0, `${unsettled.length} liability still open after the next payout`);

    const fullShare = b.amountKobo - Math.floor((b.amountKobo * 500) / 10000);
    check(
      d.ledger.netByParty.ARTIST === fullShare - owedKobo,
      `artist received ${d.ledger.netByParty.ARTIST}, expected ${fullShare} less the ${owedKobo} owed`
    );
    return `₦${owedKobo / 100} owed, recovered from the next payout`;
  });

  await scenario('no-show: no check-in, the client claims it, the money comes back', async () => {
    const p = await newParties('noshow');
    const b = await book(p);
    await fund(p, b.id);
    await eventEnds(b.id); // and nobody checked in

    await expectOk('POST', `/bookings/${b.id}/claim-no-show`, p.client.token, {
      reason: 'The artist never arrived at the venue.',
    });
    // The artist does not contest it.
    const state = await waitForState(b.id, p.client.token, ['REFUNDED', 'AWAITING_CONFIRMATION', 'DISPUTED'], 5000).catch(() => null);
    if (state !== 'REFUNDED') {
      await expectOk('POST', `/bookings/${b.id}/confirm`, p.artist.token).catch(() => null);
    }
    await waitForState(b.id, p.client.token, ['REFUNDED']);
    await assertReconciles(admin, b.id, ['REFUNDED']);
    return 'refunded, with no check-in on record';
  });

  for (const outcome of ['RELEASE', 'REFUND', 'SPLIT'] as const) {
    await scenario(`dispute resolved as ${outcome.toLowerCase()}`, async () => {
      const p = await newParties(`dsp${outcome}`);
      const b = await book(p);
      await fund(p, b.id);
      await checkIn(p, b.id);
      await eventEnds(b.id);

      const { dispute } = await expectOk('POST', `/bookings/${b.id}/disputes`, p.client.token, {
        reason: 'The set was cut short by an hour.',
      });
      await expectOk('POST', `/disputes/${dispute.id}/evidence`, p.artist.token, {
        statement: 'The venue cut the power at 11pm, not me.',
      });

      const split = outcome === 'SPLIT' ? Math.floor(b.amountKobo / 2) : undefined;
      await expectOk('POST', `/admin/disputes/${dispute.id}/resolve`, admin.token, {
        outcome,
        reason: `e2e: resolving as ${outcome} after reviewing both statements and the check-in.`,
        ...(split !== undefined ? { splitClientKobo: split } : {}),
      });

      await waitForState(b.id, p.client.token, ['RESOLVED']);
      const d = await assertReconciles(admin, b.id, ['RESOLVED']);
      const artistNet = d.ledger.netByParty.ARTIST;
      return (
        `client ₦${(d.ledger.netByParty.CLIENT + b.amountKobo + moneyInFee(b.amountKobo)) / 100} back, ` +
        (artistNet < 0 ? `artist owes ₦${-artistNet / 100} in fees` : `artist ₦${artistNet / 100}`)
      );
    });
  }

  await scenario('artist-fault reclassification shows the original and the offsets', async () => {
    const p = await newParties('reclass');
    const b = await book(p);
    await fund(p, b.id);
    await timeTravel(b.id, { startsInHours: 2 * 24 + 6 });
    await expectOk('POST', `/bookings/${b.id}/cancel`, p.client.token, { reason: 'The artist raised their fee.' });
    await waitForState(b.id, p.client.token, ['CANCELLED']);

    const before = await expectOk('GET', `/admin/bookings/${b.id}`, admin.token);
    const cancellationId = before.cancellation?.id;
    check(cancellationId, 'the cancellation is not reachable from the admin detail');

    await expectOk('POST', `/admin/cancellations/${cancellationId}/reclassify`, admin.token, {
      reason: 'The artist changed the terms after the booking was accepted.',
    });

    const d = await assertReconciles(admin, b.id, ['CANCELLED']);
    const corrections = d.ledger.entries.filter((e: any) => e.entryType === 'CORRECTION');
    check(corrections.length > 0, 'no offsetting entries');
    check(d.ledger.entries.length > before.ledger.entries.length, 'the originals were replaced, not offset');
    check(d.ledger.netByParty.CLIENT === 0, `the client is not made whole: net ${d.ledger.netByParty.CLIENT}`);
    return `${corrections.length} offsetting entries, client made whole`;
  });

  // =========================================================================
  // Report
  // =========================================================================

  const failed = outcomes.filter((o) => !o.ok);
  console.log(
    `\n${outcomes.length - failed.length}/${outcomes.length} scenarios passed` +
      (sim ? ` — ${sim.log.length} provider calls, ${sim.deliveries.length} webhooks delivered` : '')
  );

  if (sim) {
    const refused = sim.log.filter((l: any) => l.status === 409 && /releases|refunds/.test(l.path));
    if (refused.length > 0) {
      console.log(`\x1b[31m${refused.length} attempt(s) to move more money than an escrow held\x1b[0m`);
    }
  }

  for (const w of workers) await w.close();
  await closeAll();
  await server.close();
  await sim?.close();
  await prisma.$disconnect();

  process.exit(failed.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ne2e run crashed before it could report:\n', err);
  process.exit(1);
});
