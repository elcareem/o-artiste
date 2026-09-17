import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkInVerdict,
  contradictsNoShowClaim,
  outcomeDescription,
  previewSplit,
  splitProblem,
  strikesSomeone,
  triage,
  type DisputeDetail,
  type DisputeOutcome,
  type QueueEntry,
} from './disputes.ts';

const N = (naira: number) => naira * 100;

function detail(over: Partial<DisputeDetail> = {}): DisputeDetail {
  return {
    id: 'dsp_1',
    state: 'UNDER_REVIEW',
    openedAt: '2026-09-10T12:00:00Z',
    openedReason: 'The artist left after twenty minutes.',
    openedBy: 'CLIENT',
    checkIn: {
      redeemedAt: '2026-09-09T20:14:00Z',
      hasLocation: false,
      latitude: null,
      longitude: null,
      accuracyMeters: null,
    },
    booking: {
      id: 'bkg_1',
      amountKobo: N(200000),
      commissionRateBpsSnapshot: 500,
      eventDate: '2026-09-09T18:00:00Z',
      eventEndAt: '2026-09-09T21:00:00Z',
      state: 'DISPUTED',
      artist: 'Burna Test',
      client: 'A Client',
      clientConfirmedAt: null,
      artistConfirmedAt: null,
      clientNoShowClaimedAt: null,
      clientNoShowReason: null,
    },
    evidence: [],
    resolvedAt: null,
    resolutionReason: null,
    splitClientKobo: null,
    splitArtistKobo: null,
    externalMediatorOpinion: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The check-in is the fact that decides most of these
// ---------------------------------------------------------------------------

test('the check-in is stated as a claim, not handed over as a record to interpret', () => {
  const verdict = checkInVerdict(detail());

  // An admin reading a queue at speed needs a sentence, not a timestamp.
  assert.match(verdict, /redeemed the client's code/i);
  assert.match(verdict, /in person/i);

  // The absence is equally a finding, and says what it means.
  const none = checkInVerdict(detail({ checkIn: null }));
  assert.match(none, /no check-in was recorded/i);
  assert.match(none, /nobody has evidence/i);
});

test('geolocation is described as supporting detail, never as proof', () => {
  const withLocation = checkInVerdict(
    detail({
      checkIn: {
        redeemedAt: '2026-09-09T20:14:00Z',
        hasLocation: true,
        latitude: '6.5244',
        longitude: '3.3792',
        accuracyMeters: '42',
      },
    })
  );

  // docs/04 §1: GPS drifts indoors and is trivially spoofed. It never gates a
  // check-in, and it must not read as though it settles anything.
  assert.match(withLocation, /supporting detail only/i);
});

test('a check-in against a no-show claim is called out, because one account is untrue', () => {
  // The case the code exists to catch. Leaving an admin to notice it themselves
  // is how a five-minute decision becomes an afternoon.
  assert.equal(
    contradictsNoShowClaim(
      detail({ booking: { ...detail().booking, clientNoShowClaimedAt: '2026-09-10T09:00:00Z' } })
    ),
    true
  );

  // No claim, no contradiction — a quality dispute is not a credibility one.
  assert.equal(contradictsNoShowClaim(detail()), false);

  // And no check-in means nothing to contradict.
  assert.equal(
    contradictsNoShowClaim(
      detail({
        checkIn: null,
        booking: { ...detail().booking, clientNoShowClaimedAt: '2026-09-10T09:00:00Z' },
      })
    ),
    false
  );
});

// ---------------------------------------------------------------------------
// The split preview must be what executes
// ---------------------------------------------------------------------------

test('the artist share is the residual, so the halves always sum exactly', () => {
  const amount = N(200000);

  for (const clientKobo of [0, 1, 7, 8333300, N(99999), amount - 1, amount]) {
    const plan = previewSplit(amount, clientKobo, 500);

    // R2, docs/05 §4. Computing both sides from their own percentage is exactly
    // what loses a kobo, and a ledger that fails to reconcile because of it
    // would be reporting a fault that is not there.
    assert.equal(plan.clientKobo + plan.artistKobo, amount, `client ${clientKobo}`);
    assert.equal(plan.artistNetKobo + plan.commissionKobo, plan.artistKobo);
    assert.ok(Number.isInteger(plan.commissionKobo));
  }
});

test('commission floors, matching the backend rather than approximating it', () => {
  // 5% of ₦83,333.33 is not a whole kobo. The preview must round the way
  // applyBps does, or an admin is shown one figure and another executes.
  const plan = previewSplit(N(200000), 8333300, 500);
  assert.equal(plan.artistKobo, N(200000) - 8333300);
  assert.equal(plan.commissionKobo, Math.floor((plan.artistKobo * 500) / 10000));
});

test('a split that cannot divide the booking is refused before it is sent', () => {
  const amount = N(200000);

  assert.match(splitProblem(amount, '')!, /enter how much/i);
  assert.match(splitProblem(amount, null)!, /enter how much/i);
  assert.match(splitProblem(amount, 1.5)!, /whole number/i);
  assert.match(splitProblem(amount, -1)!, /cannot be negative/i);
  assert.match(splitProblem(amount, amount + 1)!, /cannot exceed/i);

  // The message names the ceiling in naira, because kobo is not how a person
  // holds the figure in their head.
  assert.match(splitProblem(amount, amount + 1)!, /₦200,000/);

  // The edges are decisions, not errors.
  assert.equal(splitProblem(amount, 0), null);
  assert.equal(splitProblem(amount, amount), null);
});

// ---------------------------------------------------------------------------
// What each verdict does, said before it is issued
// ---------------------------------------------------------------------------

test('every outcome explains what it does in money terms', () => {
  const d = detail();

  for (const outcome of ['RELEASE', 'REFUND', 'SPLIT'] as DisputeOutcome[]) {
    const text = outcomeDescription(outcome, d);
    assert.ok(text.length > 40, `${outcome}: too terse — "${text}"`);
    assert.doesNotMatch(text, /escrow|webhook|kobo|bps|null|undefined/i, `${outcome} leaks jargon`);
  }

  // The refund case names the fee reimbursement, which is the part an admin is
  // most likely to forget is included.
  assert.match(outcomeDescription('REFUND', d), /fee they paid/i);

  // The release case is explicit that the client gets nothing back — the
  // decision reads as harsher than "pay the artist" suggests.
  assert.match(outcomeDescription('RELEASE', d), /receives nothing back/i);
});

test('a split strikes nobody, and the other two do', () => {
  // A split is not a finding against either party. Recording a strike for one
  // would be a verdict the decision did not reach.
  assert.equal(strikesSomeone('SPLIT'), false);
  assert.equal(strikesSomeone('RELEASE'), true);
  assert.equal(strikesSomeone('REFUND'), true);
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

test('the queue is ordered by how long money has been held, then by how much', () => {
  const entry = (over: Partial<QueueEntry>): QueueEntry => ({
    id: 'a',
    bookingId: 'b',
    state: 'OPEN',
    openedAt: '2026-09-10T00:00:00Z',
    ageDays: 1,
    amountKobo: N(100000),
    artist: 'A',
    client: 'C',
    hasCheckIn: false,
    evidenceCount: 0,
    openedReason: 'x',
    ...over,
  });

  const ordered = triage([
    entry({ id: 'new-big', ageDays: 1, amountKobo: N(3000000) }),
    entry({ id: 'old-small', ageDays: 9, amountKobo: N(20000) }),
    entry({ id: 'same-age-bigger', ageDays: 9, amountKobo: N(500000) }),
  ]);

  // Oldest first: every row is money held from two people who both believe it
  // is theirs, and how long that has been true is the thing to act on.
  assert.deepEqual(ordered.map((e) => e.id), ['same-age-bigger', 'old-small', 'new-big']);

  // And it does not mutate what it was given.
  const input = [entry({ id: 'x', ageDays: 1 }), entry({ id: 'y', ageDays: 5 })];
  triage(input);
  assert.equal(input[0].id, 'x');
});
