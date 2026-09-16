import test from 'node:test';
import assert from 'node:assert/strict';

import {
  artistConsequenceSentence,
  artistFigures,
  canConfirm,
  clientFigures,
  describeTiming,
  figuresFor,
  isSevereForArtist,
  refundSentence,
  sunkFeeSentence,
  unavailableReason,
  type CancellationPreview,
} from './cancellation.ts';

/**
 * #30's criteria are all about what a person is told before they commit, so
 * they are tested here rather than through a rendered component: the sentences
 * are the deliverable, and they do not need a browser to check.
 */

const N = (naira: number) => naira * 100;

function preview(over: Partial<CancellationPreview> = {}): CancellationPreview {
  return {
    bookingId: 'bkg_1',
    state: 'FUNDED_HELD',
    cancellable: true,
    daysBeforeEvent: 2,
    amountKobo: N(200000),
    appliedTier: {
      minDaysBefore: 1,
      maxDaysBefore: 2,
      clientRefundBps: 4000,
      artistCompensationBps: 6000,
    },
    clientRefundKobo: N(80000),
    artistCompensationKobo: N(114000),
    commissionKobo: N(6000),
    clientSunkFeeKobo: N(2000),
    moneyOutFeeKobo: N(70),
    unrecoveredShortfallKobo: 0,
    ifArtistCancels: {
      clientRefundKobo: N(200000),
      clientFeeReimbursementKobo: N(2000),
      clientTotalReturnedKobo: N(202000),
      artistCompensationKobo: 0,
      feeLiabilityKobo: N(2070),
      consequence: {
        trigger: 'ARTIST_CANCEL_1_2_DAYS',
        weight: 2,
        summary:
          'A strike, and your cancellation rate becomes visible to clients on your profile.',
        suspends: false,
        publishesRate: true,
      },
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Criterion: a ₦0 outcome is a readable sentence, not an empty or zero field
// ---------------------------------------------------------------------------

test('a zero refund is stated in words, not implied by a blank', () => {
  const sentence = refundSentence(preview({ clientRefundKobo: 0, daysBeforeEvent: 0 }));

  // An empty field or a bare "₦0" reads as a rendering fault, and a reader who
  // thinks the page is broken has not been told anything.
  assert.ok(sentence.length > 40, `too terse to be an explanation: "${sentence}"`);
  assert.match(sentence, /will not receive a refund/i);

  // It says WHY, not just what.
  assert.match(sentence, /no longer fill the date/i);

  // And it does not lean on a bare zero to carry the meaning.
  assert.doesNotMatch(sentence, /^₦0/);
});

test('a zero refund still appears in the figures, so the table is not missing a row', () => {
  const figures = clientFigures(preview({ clientRefundKobo: 0 }));
  const back = figures.find((f) => f.label === 'You get back');

  // Present and explicit. Omitting the row would leave the reader to infer it.
  assert.ok(back);
  assert.equal(back!.value, '₦0');
  assert.equal(back!.emphasis, true);
});

test('a non-zero refund names both the amount back and the amount paid', () => {
  const sentence = refundSentence(preview());

  assert.match(sentence, /₦80,000/);
  assert.match(sentence, /₦200,000/);
});

// ---------------------------------------------------------------------------
// Criterion: the artist sees both the liability and the strike consequence
// ---------------------------------------------------------------------------

test('the artist is shown what they owe and what happens to their account', () => {
  const p = preview();
  const figures = artistFigures(p);

  const owed = figures.find((f) => f.label === 'You will owe');
  assert.ok(owed, 'the liability is not shown');
  assert.equal(owed!.value, '₦2,070');
  assert.equal(owed!.emphasis, true);

  // Where it comes from, so it is not a surprise on the next payout.
  assert.match(owed!.note ?? '', /next payout/i);

  // And the standing consequence, in the same view.
  const consequence = artistConsequenceSentence(p);
  assert.match(consequence, /strike/i);
  assert.match(consequence, /cancellation rate/i);
});

test('a day-of cancellation warns about suspension, and is marked severe', () => {
  const p = preview({
    daysBeforeEvent: 0,
    ifArtistCancels: {
      ...preview().ifArtistCancels,
      consequence: {
        trigger: 'ARTIST_CANCEL_DAY_OF',
        weight: 3,
        summary:
          'A strike, and your account is suspended pending review — you will not appear in search or be bookable until someone has looked at it.',
        suspends: true,
        publishesRate: true,
      },
    },
  });

  assert.match(artistConsequenceSentence(p), /suspended pending review/i);

  // Severity drives the extra friction in the UI. "Strike + suspension" is a
  // materially different decision from "a strike".
  assert.equal(isSevereForArtist(p), true);
  assert.equal(isSevereForArtist(preview()), false);
});

test('seven days out still shows the liability, and says there is no strike', () => {
  const p = preview({
    daysBeforeEvent: 10,
    ifArtistCancels: {
      ...preview().ifArtistCancels,
      consequence: {
        trigger: null,
        weight: 0,
        summary: 'No strike. You will still owe the escrow fees for this booking.',
        suspends: false,
        publishesRate: false,
      },
    },
  });

  // BOTH halves. "No strike" alone would let an artist think it is free.
  const consequence = artistConsequenceSentence(p);
  assert.match(consequence, /no strike/i);
  assert.match(consequence, /still owe/i);

  assert.ok(artistFigures(p).some((f) => f.label === 'You will owe'));
});

test('the artist never sees the client-cancellation split as if it were theirs', () => {
  // The preview carries both outcomes. Showing an artist the 40/60 tier split
  // would answer a question they did not ask.
  const p = preview();
  const artist = artistFigures(p).map((f) => f.value);

  assert.ok(!artist.includes('₦80,000'), 'the client tier refund leaked into the artist view');
  assert.ok(!artist.includes('₦114,000'), 'the client-cancellation compensation leaked in');

  // What they do see: the client made whole, and nothing for them.
  assert.ok(artist.includes('₦202,000'));
  assert.ok(artist.includes('₦0'));
});

// ---------------------------------------------------------------------------
// Criterion: no cancellation completes without the figures having been shown
// ---------------------------------------------------------------------------

test('confirming is impossible without a preview in hand', () => {
  // Structural rather than remembered: the confirm step cannot be reached
  // without the object that carries the figures.
  assert.equal(canConfirm(null), false);
  assert.equal(canConfirm(preview({ cancellable: false })), false);
  assert.equal(canConfirm(preview()), true);
});

test('an uncancellable booking explains itself instead of dead-ending', () => {
  const cases: [string, RegExp][] = [
    ['CHECKED_IN', /already checked in/i],
    ['AWAITING_CONFIRMATION', /confirm it, or report a no-show/i],
    ['RELEASED', /already been paid out/i],
    ['REFUNDED', /already been refunded/i],
    ['CANCELLED', /already cancelled/i],
    ['DISPUTED', /under dispute/i],
    ['RESOLVED', /settled by support/i],
  ];

  for (const [state, expected] of cases) {
    const reason = unavailableReason(preview({ state, cancellable: false }));
    assert.ok(reason, `${state} gives no explanation`);
    assert.match(reason!, expected, `${state}: "${reason}"`);

    // A raw state name is not an explanation.
    assert.doesNotMatch(reason!, /[A-Z]{3,}_[A-Z]/, `${state} leaked its enum name`);
  }

  // A past event is its own case, whatever the state says.
  const past = unavailableReason(preview({ daysBeforeEvent: -1, cancellable: false }));
  assert.match(past!, /already taken place/i);

  // And a cancellable booking has nothing to explain.
  assert.equal(unavailableReason(preview()), null);
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

test('every amount is rendered through formatNaira, never a raw kobo integer', () => {
  for (const party of ['CLIENT', 'ARTIST'] as const) {
    for (const figure of figuresFor(preview(), party)) {
      assert.match(figure.value, /^₦[\d,]+(\.\d{2})?$/, `${figure.label}: "${figure.value}"`);
      // A kobo integer would show as ₦20,000,000 for a ₦200,000 booking.
      assert.doesNotMatch(figure.value, /₦20,000,000/);
    }
  }
});

test('timing is said the way a person says it', () => {
  assert.equal(describeTiming(0), 'on the day of the event');
  assert.equal(describeTiming(1), 'the day before the event');
  assert.equal(describeTiming(5), '5 days before the event');

  // A past event should never reach this, but it must not produce "-1 days".
  assert.equal(describeTiming(-1), 'on the day of the event');
});

test('the sunk fee is disclosed as already-paid, not as a new deduction', () => {
  const sentence = sunkFeeSentence(preview());

  assert.ok(sentence);
  assert.match(sentence!, /₦2,000/);
  assert.match(sentence!, /not refundable/i);

  // It was the bank's charge at funding, not a cancellation penalty — telling
  // someone otherwise invites the dispute this disclosure exists to prevent.
  assert.match(sentence!, /charged by the bank/i);

  // Nothing to say when there was no fee.
  assert.equal(sunkFeeSentence(preview({ clientSunkFeeKobo: 0 })), null);
});

test('no copy leaks system vocabulary at a person', () => {
  const jargon = /escrow|webhook|kobo|bps|basis point|null|undefined|API|HTTP|\b\d{3} error/i;

  const p = preview();
  const strings = [
    refundSentence(p),
    refundSentence(preview({ clientRefundKobo: 0 })),
    sunkFeeSentence(p) ?? '',
    artistConsequenceSentence(p),
    ...clientFigures(p).flatMap((f) => [f.label, f.note ?? '']),
    ...artistFigures(p).flatMap((f) => [f.label, f.note ?? '']),
  ];

  for (const text of strings) {
    assert.doesNotMatch(text, jargon, `leaks system vocabulary: "${text}"`);
  }
});
