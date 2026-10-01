/**
 * The ledger view's presentation rules — issue #37.
 *
 * These tests exist because the view is the thing someone reads before deciding
 * whether to move money by hand, and a presentation bug there is indistinguish-
 * able from an accounting bug to the person reading it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  entryTypeLabel,
  ledgerLines,
  netPositions,
  partyLabel,
  payoutProblem,
  reconciliationProblem,
  type LedgerEntry,
} from './ledger.ts';

const entry = (over: Partial<LedgerEntry> & { id: string }): LedgerEntry => ({
  entryType: 'FUNDING',
  party: 'CLIENT',
  amountKobo: -100,
  description: null,
  offsetsEntryId: null,
  createdAt: '2026-01-01T10:00:00.000Z',
  ...over,
});

test('every entry type renders as words, never as a database constant', () => {
  assert.equal(entryTypeLabel('COMMISSION'), 'Platform commission');
  assert.equal(entryTypeLabel('FEE_LIABILITY_SETTLEMENT'), 'Outstanding fee recovered');

  // An unmapped type must not reach the screen as SHOUTING_SNAKE_CASE. It reads
  // as a bug in the reader's booking rather than a gap in our labels.
  const unknown = entryTypeLabel('SOME_FUTURE_TYPE');
  assert.equal(unknown, 'Some future type');
  assert.doesNotMatch(unknown, /_/);
  assert.doesNotMatch(unknown, /^[A-Z_]+$/);
});

test('PROVIDER is labelled as what it actually is', () => {
  // "Provider" leaves the reader to work out that this is the bank's fee and not
  // a counterparty we chose to pay.
  assert.equal(partyLabel('PROVIDER'), 'Bank fees');
  assert.equal(partyLabel('CLIENT'), 'Client');
  assert.equal(partyLabel('SOMETHING_ELSE'), 'Other');
});

test('entries read in the order they happened', () => {
  const lines = ledgerLines([
    entry({ id: 'b', createdAt: '2026-01-02T10:00:00.000Z' }),
    entry({ id: 'a', createdAt: '2026-01-01T10:00:00.000Z' }),
  ]);
  assert.deepEqual(lines.map((l) => l.entry.id), ['a', 'b']);
});

test('entries sharing a timestamp keep a stable order', () => {
  // Everything written inside one transaction shares a timestamp to the
  // millisecond. Without a tiebreak the rows shuffle between renders of the
  // same booking, which reads as the figures changing.
  const same = '2026-01-01T10:00:00.000Z';
  const first = ledgerLines([
    entry({ id: 'z', createdAt: same }),
    entry({ id: 'a', createdAt: same }),
    entry({ id: 'm', createdAt: same }),
  ]);
  const second = ledgerLines([
    entry({ id: 'm', createdAt: same }),
    entry({ id: 'z', createdAt: same }),
    entry({ id: 'a', createdAt: same }),
  ]);
  assert.deepEqual(
    first.map((l) => l.entry.id),
    second.map((l) => l.entry.id)
  );
});

test('a correction is paired with the entry it offsets, and both stay visible', () => {
  const original = entry({ id: 'orig', entryType: 'CANCELLATION_FEE', amountKobo: -5000 });
  const correction = entry({
    id: 'corr',
    entryType: 'CORRECTION',
    amountKobo: 5000,
    offsetsEntryId: 'orig',
    createdAt: '2026-01-03T10:00:00.000Z',
  });

  const lines = ledgerLines([original, correction]);

  // BOTH, because the sequence — charged, then reversed — is the record that
  // matters when the decision is questioned (docs/01 §5).
  assert.equal(lines.length, 2);

  const [first, second] = lines;
  assert.equal(first.reversed, true, 'the original is not marked as reversed');
  assert.equal(first.isCorrection, false);

  assert.equal(second.isCorrection, true);
  assert.equal(second.offsets?.id, 'orig', 'the correction does not name its original');
  assert.equal(second.reversed, false);
});

test('a correction whose original is not in view does not crash the page', () => {
  const lines = ledgerLines([
    entry({ id: 'corr', entryType: 'CORRECTION', amountKobo: 5000, offsetsEntryId: 'missing' }),
  ]);
  assert.equal(lines[0].isCorrection, true);
  assert.equal(lines[0].offsets, null);
});

test('direction says in words what the sign means', () => {
  const lines = ledgerLines([
    entry({ id: 'out', amountKobo: -20000000 }),
    entry({ id: 'in', amountKobo: 18800000, createdAt: '2026-01-02T10:00:00.000Z' }),
  ]);
  assert.equal(lines[0].direction, 'out');
  assert.equal(lines[1].direction, 'in');
});

test('net positions read client, artist, then the two fee lines that explain the gap', () => {
  const positions = netPositions({
    PLATFORM: 1000000,
    CLIENT: -20200000,
    PROVIDER: 400000,
    ARTIST: 18800000,
  });

  assert.deepEqual(positions.map((p) => p.party), ['CLIENT', 'ARTIST', 'PLATFORM', 'PROVIDER']);
  assert.equal(positions[0].amountKobo, -20200000);
  assert.equal(positions[1].label, 'Artist');
});

test('a party with no entries is zero rather than missing', () => {
  const positions = netPositions({ CLIENT: -100, ARTIST: 100 });
  assert.equal(positions.find((p) => p.party === 'PROVIDER')?.amountKobo, 0);
  assert.equal(positions.length, 4);
});

test('an in-flight booking that does not balance is not a problem', () => {
  // Money is held and nothing has been paid out. Warning here would put a red
  // banner on every healthy booking until it settled, which is how a real
  // warning stops being read.
  for (const state of ['PENDING_PAYMENT', 'FUNDED_HELD', 'CHECKED_IN', 'AWAITING_CONFIRMATION', 'DISPUTED']) {
    assert.equal(
      reconciliationProblem(state, { balanced: false, sumKobo: -20200000, entryCount: 2 }),
      null,
      state
    );
  }
});

test('a concluded booking that does not balance is stated plainly', () => {
  for (const state of ['RELEASED', 'REFUNDED', 'CANCELLED', 'RESOLVED']) {
    const problem = reconciliationProblem(state, { balanced: false, sumKobo: 100, entryCount: 6 });
    assert.ok(problem, state);
    // It must tell the reader what to DO, because this is the screen they are
    // on when deciding whether to release money by hand.
    assert.match(problem as string, /do not act/i);
  }

  assert.equal(
    reconciliationProblem('RELEASED', { balanced: true, sumKobo: 0, entryCount: 6 }),
    null
  );
});

test('a concluded booking with no entries at all is called out separately', () => {
  const problem = reconciliationProblem('RELEASED', { balanced: true, sumKobo: 0, entryCount: 0 });
  // `balanced` is true for an empty ledger — zero entries sum to zero — so the
  // balance check alone would pass this silently.
  assert.ok(problem);
  assert.match(problem as string, /no ledger entries/i);
});

test('released-but-not-paid-out is surfaced, because no state shows it', () => {
  const problem = payoutProblem('RELEASED', null);
  assert.ok(problem);
  assert.match(problem as string, /our wallet/i);

  assert.equal(payoutProblem('RELEASED', '2026-01-02T10:00:00.000Z'), null);
  assert.equal(payoutProblem('FUNDED_HELD', null), null);
});

test('no rendered label leaks a raw enum or an internal term', () => {
  const labels = [
    ...['FUNDING', 'ESCROW_FEE', 'RELEASE', 'COMMISSION', 'PAYOUT_FEE', 'REFUND', 'CORRECTION'].map(
      entryTypeLabel
    ),
    ...['CLIENT', 'ARTIST', 'PLATFORM', 'PROVIDER'].map(partyLabel),
  ];

  for (const label of labels) {
    assert.doesNotMatch(label, /_/, label);
    assert.doesNotMatch(label, /escrow|webhook|kobo|bps/i, label);
  }
});
