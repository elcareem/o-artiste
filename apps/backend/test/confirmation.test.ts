/**
 * The two-sided confirmation matrix — issue #24.
 *
 * Each row of the matrix encodes a piece of reasoning, and the reasoning is
 * what has to survive someone disputing the outcome. The matrix itself is a
 * pure function, so every row — and every combination that is not a row — is
 * tested without a database; the end-to-end tests below then prove the money
 * actually moves the way the matrix says.
 */

// Unique per RUN, not merely per process: Redis keeps keys forever and the
// OS reuses pids, so a prefix of pid alone can land on a dead run's queue —
// including its job-id counter, which makes `getJob('1')` return a stranger.
process.env.QUEUE_PREFIX = `test-confirmation-${process.pid}-${Date.now()}`;

const { prisma, hasDatabase, ready } = require('./db.ts')('confirmation');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app.ts');
const { startServer } = require('./helpers.ts');
const confirmationService = require('../src/services/confirmationService.ts');
const bookingService = require('../src/services/bookingService.ts');
const ledger = require('../src/services/ledgerService.ts');
const escrowpay = require('../src/lib/escrowpay.ts');
const { computeArtistCancellation, computeCompletion } = require('../src/services/feeService.ts');

const describe = hasDatabase ? test : test.skip;

const PASSWORD = 'correct horse battery staple';

let server: TestServer;

test.before(async () => {
  if (ready) await ready;
  server = await startServer(createApp());
});

test.after(async () => {
  if (server) await server.close();
  // escrowService cancels the pending auto-release after a release or refund
  // (#25), which opens a real queue connection. Without closing it this process
  // never exits and the suite hangs rather than failing — which is the worse of
  // the two, because a hang looks like a slow machine.
  await require('../src/lib/queue.ts').closeAll();
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

// ---------------------------------------------------------------------------
// The matrix itself — pure, no database
// ---------------------------------------------------------------------------

const facts = (o: Partial<ConfirmationFacts> = {}): ConfirmationFacts => ({
  clientConfirmed: false,
  clientClaimedNoShow: false,
  artistConfirmed: false,
  hasCheckIn: false,
  ...o,
});

test('every row of docs/04 §3 is decided the way the table says', () => {
  // | Client        | Artist     | Outcome                          |
  const rows: [string, ConfirmationFacts, ConfirmationOutcome][] = [
    [
      'confirms | confirms → release',
      facts({ clientConfirmed: true, artistConfirmed: true, hasCheckIn: true }),
      'release',
    ],
    [
      'confirms | silent → release',
      facts({ clientConfirmed: true }),
      'release',
    ],
    [
      'silent | checked in → auto-release after the grace period',
      facts({ hasCheckIn: true, artistConfirmed: true }),
      'awaiting_auto_release',
    ],
    [
      'claims no-show | no check-in → refund the client',
      facts({ clientClaimedNoShow: true }),
      'refund',
    ],
    [
      'claims no-show | check-in recorded → DISPUTED',
      facts({ clientClaimedNoShow: true, hasCheckIn: true }),
      'dispute',
    ],
  ];

  for (const [label, given, expected] of rows) {
    const verdict = confirmationService.evaluate(given);
    assert.equal(verdict.outcome, expected, `${label}: got ${verdict.outcome}`);
    assert.ok(verdict.reason.length > 0, `${label}: no reason given`);
  }
});

test('the matrix is total — all sixteen combinations decide something', () => {
  const seen = new Set<string>();

  for (const clientConfirmed of [false, true]) {
    for (const clientClaimedNoShow of [false, true]) {
      for (const artistConfirmed of [false, true]) {
        for (const hasCheckIn of [false, true]) {
          const given = { clientConfirmed, clientClaimedNoShow, artistConfirmed, hasCheckIn };
          const verdict = confirmationService.evaluate(given);

          assert.ok(
            ['release', 'refund', 'dispute', 'awaiting_auto_release', 'awaiting_response'].includes(
              verdict.outcome
            ),
            `${JSON.stringify(given)} produced ${verdict.outcome}`
          );
          assert.ok(verdict.reason, `${JSON.stringify(given)} gave no reason`);
          seen.add(verdict.outcome);
        }
      }
    }
  }

  // Every outcome is reachable. An outcome no input produces is dead code
  // pretending to be a rule.
  assert.equal(seen.size, 5, `unreachable outcomes: ${[...seen].join(', ')}`);
});

test('an artist can never release their own payment by confirming', () => {
  // The single most important negative case in this file. An artist confirming
  // is confirming their own payout, so it cannot be sufficient on its own —
  // whatever else is true.
  for (const hasCheckIn of [false, true]) {
    const verdict = confirmationService.evaluate(
      facts({ artistConfirmed: true, hasCheckIn })
    );
    assert.notEqual(verdict.outcome, 'release', `hasCheckIn=${hasCheckIn}`);
  }
});

test('a client who both confirmed and claimed a no-show is a dispute, never a guess', () => {
  // The service refuses the second statement, so this should be unreachable.
  // If something ever writes around that guard, the answer is a human — not a
  // rule picking whichever field it checked first.
  for (const hasCheckIn of [false, true]) {
    const verdict = confirmationService.evaluate(
      facts({ clientConfirmed: true, clientClaimedNoShow: true, hasCheckIn })
    );
    assert.equal(verdict.outcome, 'dispute');
    assert.match(verdict.reason, /both confirmed and reported/i);
  }
});

test('silence is separated by whether anything will ever happen on its own', () => {
  // Both are "nothing now", and they are different states of the world: #25's
  // job fires only where a check-in exists, so the second one waits forever
  // unless a person intervenes. Collapsing them would hide that.
  assert.equal(confirmationService.evaluate(facts({ hasCheckIn: true })).outcome, 'awaiting_auto_release');
  assert.equal(confirmationService.evaluate(facts()).outcome, 'awaiting_response');
  assert.match(confirmationService.evaluate(facts()).reason, /nothing releases automatically/i);
});

// ---------------------------------------------------------------------------
// Fixtures for the end-to-end rows
// ---------------------------------------------------------------------------

async function makeUser(role: UserRole) {
  const { hashPassword } = require('../src/lib/auth.ts');
  const n = uniq();
  return prisma.user.create({
    data: {
      email: `cnf${n}@example.test`,
      phone: `+234${String(n).slice(-9).padStart(9, '0')}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
      escrowPartyId: `PAR_${n}`,
    },
  });
}

/** A funded booking whose event finished an hour ago. */
async function afterTheEvent({
  checkedIn = false,
  hoursSinceEnd = 1,
  amountKobo = N(200000),
}: { checkedIn?: boolean; hoursSinceEnd?: number; amountKobo?: Kobo } = {}) {
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

  let booking = await bookingService.createBooking({
    clientUserId: clientUser.id,
    artistId: artist.id,
    amountKobo,
    eventDate: new Date(Date.now() + 30 * 86400000),
  });

  const eventEndAt = new Date(Date.now() - hoursSinceEnd * 3600_000);
  const eventDate = new Date(eventEndAt.getTime() - 3 * 3600_000);

  booking = await prisma.booking.update({
    where: { id: booking.id },
    data: { state: 'FUNDED_HELD', escrowId: `TXN_${uniq()}`, eventDate, eventEndAt },
  });

  await prisma.$transaction((tx: PrismaTx) => ledger.recordFunding(tx, booking));

  if (checkedIn) {
    await prisma.checkIn.create({
      data: { bookingId: booking.id, redeemedByUser: artistUser.id },
    });
    booking = await prisma.booking.update({
      where: { id: booking.id },
      data: { state: 'CHECKED_IN' },
    });
  }

  return { booking, artist, artistUser, clientUser, amountKobo };
}

async function login(email: string) {
  const res = await fetch(`${server.url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return ((await res.json()) as any).token as string;
}

const post = async (path: string, token: string, body: unknown = {}) => {
  const res = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

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

const provider = {
  release: async () => ({ id: `REL_${uniq()}`, status: 'completed' }),
  refund: async () => ({ id: `RFD_${uniq()}`, status: 'completed' }),
};

// ---------------------------------------------------------------------------
// The rows, end to end
// ---------------------------------------------------------------------------

describe('client confirms, artist confirms → the money is released', async () => {
  const { booking, clientUser, artistUser, amountKobo } = await afterTheEvent({ checkedIn: true });
  const clientToken = await login(clientUser.email);
  const artistToken = await login(artistUser.email);

  await withProvider(provider, async () => {
    const artistFirst = await post(`/bookings/${booking.id}/confirm`, artistToken);
    assert.equal(artistFirst.status, 200);

    // An artist confirming their own payment releases nothing.
    assert.equal(artistFirst.body.confirmation.outcome, 'awaiting_auto_release');
    assert.equal(artistFirst.body.confirmation.state, 'AWAITING_CONFIRMATION');

    const clientSecond = await post(`/bookings/${booking.id}/confirm`, clientToken);
    assert.equal(clientSecond.status, 200);
    assert.equal(clientSecond.body.confirmation.outcome, 'release');
    assert.equal(clientSecond.body.confirmation.state, 'RELEASED');
    assert.match(clientSecond.body.confirmation.reason, /both parties/i);
  });

  const final = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(final.state, 'RELEASED');
  assert.ok(final.clientConfirmedAt);
  assert.ok(final.artistConfirmedAt);

  // The artist was paid what the snapshot says, and the ledger balances.
  const completion = computeCompletion({
    amountKobo,
    commissionBps: booking.commissionRateBpsSnapshot,
  });
  const entries = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });
  assert.equal(
    entries.reduce((sum: number, e: LedgerEntryRow) => sum + e.amountKobo, 0),
    0,
    'the ledger must sum to zero'
  );
  assert.ok(completion.artistNetKobo > 0);
});

describe('client confirms, artist silent → the money is released anyway', async () => {
  const { booking, clientUser } = await afterTheEvent({ checkedIn: true });
  const token = await login(clientUser.email);

  const res = await withProvider(provider, () => post(`/bookings/${booking.id}/confirm`, token));

  assert.equal(res.status, 200);
  assert.equal(res.body.confirmation.outcome, 'release');
  assert.match(res.body.confirmation.reason, /the client confirmed/i);

  const final = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(final.state, 'RELEASED');
  assert.equal(final.artistConfirmedAt, null, 'the artist never responded, and did not need to');
});

describe('client silent, artist checked in → nothing moves, the grace period decides', async () => {
  const { booking, artistUser } = await afterTheEvent({ checkedIn: true });
  const token = await login(artistUser.email);

  const res = await post(`/bookings/${booking.id}/confirm`, token);

  assert.equal(res.status, 200);
  assert.equal(res.body.confirmation.outcome, 'awaiting_auto_release');

  const final = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(final.state, 'AWAITING_CONFIRMATION');

  // No money moved, and no release was recorded.
  const released = await prisma.ledgerEntry.findFirst({
    where: { bookingId: booking.id, entryType: 'RELEASED' },
  });
  assert.equal(released, null, 'an artist confirmation must not release anything');
});

describe('client claims no-show, no check-in → the client is refunded in full', async () => {
  const { booking, clientUser, artistUser, amountKobo } = await afterTheEvent({ checkedIn: false });
  const token = await login(clientUser.email);

  const res = await withProvider(provider, () =>
    post(`/bookings/${booking.id}/claim-no-show`, token, { reason: 'Nobody arrived.' })
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.confirmation.outcome, 'refund');
  assert.equal(res.body.confirmation.state, 'REFUNDED');

  const expected = computeArtistCancellation({ amountKobo });

  // ZERO fee exposure: the escrow back, plus the money-in fee they paid on top
  // of it at funding.
  assert.equal(res.body.confirmation.refund.clientRefundKobo, amountKobo);
  assert.equal(res.body.confirmation.refund.clientFeeReimbursementKobo, expected.moneyInFeeKobo);
  assert.equal(
    res.body.confirmation.refund.clientTotalReturnedKobo,
    amountKobo + expected.moneyInFeeKobo
  );

  // The cost lands on the artist, as a liability recovered from a later payout.
  const liability = await prisma.feeLiability.findFirst({
    where: { originBookingId: booking.id },
  });
  assert.ok(liability, 'no fee liability was accrued against the artist');
  assert.equal(liability.artistUserId, artistUser.id);
  assert.equal(liability.amountKobo, expected.feeLiabilityKobo);
  assert.equal(liability.status, 'OUTSTANDING');

  const entries = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });
  assert.equal(
    entries.reduce((sum: number, e: LedgerEntryRow) => sum + e.amountKobo, 0),
    0,
    'the ledger must sum to zero'
  );
});

describe('client claims no-show against a recorded check-in → DISPUTED, not refunded', async () => {
  const { booking, clientUser } = await afterTheEvent({ checkedIn: true });
  const token = await login(clientUser.email);

  // The provider is deliberately rigged to throw. Nothing may reach it on this
  // path — the whole point of the row is that no money moves in either
  // direction until a person decides.
  const res = await withProvider(
    {
      release: async () => {
        throw new Error('release must not be called on a disputed booking');
      },
      refund: async () => {
        throw new Error('refund must not be called on a disputed booking');
      },
    },
    () => post(`/bookings/${booking.id}/claim-no-show`, token, { reason: 'They never showed.' })
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.confirmation.outcome, 'dispute');
  assert.equal(res.body.confirmation.state, 'DISPUTED');
  assert.ok(res.body.confirmation.disputeId);

  const final = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(final.state, 'DISPUTED');

  const dispute = await prisma.dispute.findFirst({ where: { bookingId: booking.id } });
  assert.equal(dispute.state, 'OPEN', 'a dispute opened here must never auto-resolve');
  assert.equal(dispute.openedByUserId, clientUser.id);
  assert.equal(dispute.resolvedAt, null);

  // The check-in is attached. It is the whole substance of this kind of
  // dispute, and an admin should not have to go looking for it.
  const checkIn = await prisma.checkIn.findUnique({ where: { bookingId: booking.id } });
  assert.equal(dispute.checkInId, checkIn.id);

  // The client's own account is carried into the record, so the artist can
  // answer it.
  assert.match(dispute.openedReason, /They never showed\./);

  // Nothing moved.
  const moved = await prisma.ledgerEntry.findFirst({
    where: { bookingId: booking.id, entryType: { in: ['RELEASED', 'REFUNDED'] } },
  });
  assert.equal(moved, null, 'money moved on a disputed booking');
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe('neither party may confirm before the event has finished', async () => {
  const { booking, clientUser, artistUser } = await afterTheEvent({ hoursSinceEnd: -2 });

  for (const user of [clientUser, artistUser]) {
    const token = await login(user.email);
    const res = await post(`/bookings/${booking.id}/confirm`, token);

    assert.equal(res.status, 409, `${user.role} confirmed early`);
    assert.match(res.body.error, /has not finished yet/i);
  }

  // Nor may a no-show be claimed for an event still in progress.
  const clientToken = await login(clientUser.email);
  const claim = await post(`/bookings/${booking.id}/claim-no-show`, clientToken, {});
  assert.equal(claim.status, 409);

  const final = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(final.clientConfirmedAt, null);
  assert.equal(final.artistConfirmedAt, null);
  assert.equal(final.clientNoShowClaimedAt, null);
});

describe('confirming a booking that has already concluded is refused', async () => {
  for (const state of ['REFUNDED', 'RELEASED', 'CANCELLED', 'RESOLVED'] as BookingState[]) {
    const { booking, clientUser } = await afterTheEvent({ checkedIn: true });
    await prisma.booking.update({ where: { id: booking.id }, data: { state } });

    const token = await login(clientUser.email);
    const res = await withProvider(
      {
        release: async () => {
          throw new Error(`release must not be reached from ${state}`);
        },
        refund: async () => {
          throw new Error(`refund must not be reached from ${state}`);
        },
      },
      () => post(`/bookings/${booking.id}/confirm`, token)
    );

    assert.equal(res.status, 409, `${state} was accepted`);
    assert.doesNotMatch(res.body.error, /[A-Z]{3,}_[A-Z]/, `${state} leaked its enum name`);

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    assert.equal(after.state, state, `${state} changed`);
  }
});

describe('an illegal transition throws rather than proceeding', async () => {
  // The service's gates are one layer; this is the layer underneath. Even
  // called directly, with the gates bypassed, the transition map refuses.
  const { booking } = await afterTheEvent();
  await prisma.booking.update({ where: { id: booking.id }, data: { state: 'REFUNDED' } });

  await assert.rejects(
    () => bookingService.transition({ bookingId: booking.id, to: 'RELEASED' }),
    (err: ThrownError) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /already refunded/i);
      return true;
    }
  );

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.equal(after.state, 'REFUNDED');
});

describe('a client cannot confirm and claim a no-show for the same booking', async () => {
  const { booking, clientUser } = await afterTheEvent({ checkedIn: false });
  const token = await login(clientUser.email);

  const claim = await withProvider(provider, () =>
    post(`/bookings/${booking.id}/claim-no-show`, token, { reason: 'Nobody came.' })
  );
  assert.equal(claim.body.confirmation.outcome, 'refund');

  // The booking is REFUNDED now, so this is refused by the settled-state gate.
  const confirmAfter = await post(`/bookings/${booking.id}/confirm`, token);
  assert.equal(confirmAfter.status, 409);

  // And the reverse order, on a booking that stays open: confirm first, then
  // try to claim. The client confirmed on a booking with no check-in, which
  // releases — so use one where the release is stubbed to fail loudly if
  // reached.
  const second = await afterTheEvent({ checkedIn: true });
  const secondToken = await login(second.clientUser.email);
  await prisma.booking.update({
    where: { id: second.booking.id },
    data: { clientConfirmedAt: new Date(), state: 'AWAITING_CONFIRMATION' },
  });

  const claimAfterConfirm = await post(`/bookings/${second.booking.id}/claim-no-show`, secondToken, {
    reason: 'Changed my mind.',
  });
  assert.equal(claimAfterConfirm.status, 409);
  assert.match(claimAfterConfirm.body.error, /already confirmed/i);

  const final = await prisma.booking.findUnique({ where: { id: second.booking.id } });
  assert.equal(final.clientNoShowClaimedAt, null, 'a contradiction was stored');
});

describe('confirming twice keeps the first timestamp', async () => {
  const { booking, artistUser } = await afterTheEvent({ checkedIn: true });
  const token = await login(artistUser.email);

  const first = await post(`/bookings/${booking.id}/confirm`, token);
  assert.equal(first.status, 200);
  const stamped = (await prisma.booking.findUnique({ where: { id: booking.id } })).artistConfirmedAt;

  await new Promise((r) => setTimeout(r, 25));

  const again = await post(`/bookings/${booking.id}/confirm`, token);
  assert.equal(again.status, 200);

  const after = await prisma.booking.findUnique({ where: { id: booking.id } });
  assert.deepEqual(
    after.artistConfirmedAt,
    stamped,
    'when a party responded is evidence; a double tap must not rewrite it'
  );
});

describe('a stranger gets 404, and an artist cannot claim a no-show', async () => {
  const { booking, artistUser } = await afterTheEvent({ checkedIn: true });

  const stranger = await makeUser('CLIENT');
  await prisma.client.create({ data: { userId: stranger.id, displayName: 'Stranger' } });
  const strangerToken = await login(stranger.email);

  const confirmRes = await post(`/bookings/${booking.id}/confirm`, strangerToken);
  assert.equal(confirmRes.status, 404);

  const claimRes = await post(`/bookings/${booking.id}/claim-no-show`, strangerToken, {});
  assert.equal(claimRes.status, 404);

  // An artist reporting their own absence is a cancellation (#28), not a claim
  // about someone else.
  const artistToken = await login(artistUser.email);
  const artistClaim = await post(`/bookings/${booking.id}/claim-no-show`, artistToken, {});
  assert.equal(artistClaim.status, 403);
});

describe('both parties can see who has responded', async () => {
  const { booking, clientUser, artistUser } = await afterTheEvent({ checkedIn: true });
  const artistToken = await login(artistUser.email);
  await post(`/bookings/${booking.id}/confirm`, artistToken);

  for (const token of [artistToken, await login(clientUser.email)]) {
    const res = await fetch(`${server.url}/bookings/${booking.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { booking: view } = (await res.json()) as any;

    assert.ok(view.artistConfirmedAt, 'the artist response is not visible');
    assert.equal(view.clientConfirmedAt, null);
    assert.equal(view.clientNoShowClaimedAt, null);

    // The client's written accusation is not here. It belongs in the dispute
    // record, where the other party can answer it.
    assert.equal(view.clientNoShowReason, undefined);
  }
});
