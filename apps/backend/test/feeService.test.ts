/**
 * Fee computation — issue #14.
 *
 * Pure functions, so no database and no network. This is the most exhaustively
 * tested module in the system on purpose: every money number originates here,
 * and a rounding error is invisible in testing and irreconcilable in production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fee = require('../src/services/feeService.ts');

const N = (naira: number) => naira * 100; // naira → kobo, for readable test data

// ---------------------------------------------------------------------------
// The canonical example
// ---------------------------------------------------------------------------

test('the canonical ₦200,000 booking, under the provider’s fee bearers', () => {
  // #14 originally asserted ₦187,930, computed from docs/05's assumption that
  // the artist bears both escrow fees. The provider's live configuration says
  // otherwise — money-in is charged to the payer at funding, money-out to the
  // business at payout — and the figure changes accordingly. Found at #18 and
  // changed by decision rather than adjusted quietly.
  const r = fee.computeCompletion({ amountKobo: N(200000), commissionBps: 500 });

  assert.equal(r.moneyInFeeKobo, N(3000), 'money-in is capped at ₦3,000');
  assert.equal(r.clientPaysKobo, N(203000), 'the client transfers amount PLUS the fee');
  assert.equal(r.commissionKobo, N(10000), '5% of ₦200,000');
  assert.equal(r.moneyOutFeeKobo, N(70), 'payout above ₦50,000');

  assert.equal(r.artistNetKobo, N(190000), '₦190,000 — escrow less commission');
  assert.equal(r.platformNetKobo, 993000, '₦9,930 — commission less the payout fee we absorb');

  assert.equal(r.moneyInBearer, 'CLIENT');
  assert.equal(r.moneyOutBearer, 'PLATFORM');
});

// ---------------------------------------------------------------------------
// Boundaries — #14's stated list, plus the one it misses
// ---------------------------------------------------------------------------

test('money-in at the ₦250,000 boundary, both sides', () => {
  // #14 names these. ₦250,000 itself is in the LOWER tier (the provider's
  // `up_to_minor` is inclusive), so it is capped at ₦3,000.
  assert.equal(fee.moneyInFee(N(249999)), N(3000), 'capped');
  assert.equal(fee.moneyInFee(N(250000)), N(3000), 'capped, lower tier inclusive');

  // Above it: 1.25% PLUS ₦150 under the provider's fee configuration v4
  // (16 October 2026). 1.25% of ₦250,001 = 312,501.25 kobo, floored to
  // 312,501, plus 15,000. (v1 was continuous here; v2 stepped up by ₦100; v4
  // steps up by ₦275.01.)
  assert.equal(fee.moneyInFee(N(250001)), 327501);
  assert.equal(fee.moneyInFee(N(260000)), N(3400));

  // Still never cheaper above the boundary than at it.
  assert.ok(fee.moneyInFee(N(250001)) > fee.moneyInFee(N(250000)), 'a step up, not a dip');
});

test('money-in at the top of the range, under fee configuration v4', () => {
  // ₦3,000,000: 1.25% is ₦37,500, plus the ₦150 fixed part.
  assert.equal(fee.moneyInFee(N(3000000)), N(37650));
});

test('money-in where the cap ACTUALLY starts binding, at ₦190,000', () => {
  // The boundary #14's list misses entirely. Below this the percentage governs
  // and rounding is live; above it the fee is a flat ₦3,000. Testing only the
  // ₦250,000 edge would never exercise the percentage region.
  //
  // 1.5% + ₦150 reaches ₦3,000 at exactly ₦190,000 (it was ₦126,667 under v2).
  assert.equal(fee.moneyInFee(N(189999)), 299998, 'just under: 284,998.5 → floored 284,998, + 15,000');
  assert.equal(fee.moneyInFee(N(190000)), N(3000), 'exactly at: the percentage meets the cap');
  assert.equal(fee.moneyInFee(N(190001)), N(3000), 'just over: capped');

  // Well below the cap, the percentage plus the flat fee governs.
  assert.equal(fee.moneyInFee(N(20000)), N(450), '1.5% of ₦20,000 = ₦300, + ₦150');
  assert.equal(fee.moneyInFee(N(50000)), N(900), '1.5% of ₦50,000 = ₦750, + ₦150');
});

test('money-out at the ₦50,000 boundary, both sides', () => {
  assert.equal(fee.moneyOutFee(N(49999)), N(40));
  assert.equal(fee.moneyOutFee(N(50000)), N(40), 'inclusive at the boundary');
  assert.equal(fee.moneyOutFee(N(50001)), N(70));
});

// ---------------------------------------------------------------------------
// The rounding rules
// ---------------------------------------------------------------------------

test('R1 — percentages floor, never round', () => {
  // 333 kobo at 5% = 16.65 kobo. Floors to 16, not 17.
  assert.equal(fee.applyBps(333, 500), 16);
  // 1 kobo at 50% = 0.5. Floors to 0.
  assert.equal(fee.applyBps(1, 5000), 0);
  assert.equal(fee.applyBps(0, 500), 0);
  // Exact division is unaffected.
  assert.equal(fee.applyBps(20000000, 500), 1000000);
});

test('R2 — the parts sum to the whole for every amount, with no kobo unaccounted for', () => {
  // The assertion that catches the widest class of bug. An amount producing a
  // fractional commission is where a naive implementation loses a kobo.
  const amounts = [
    N(20000), N(20001), 2000033, 2000077, N(126667), N(199999),
    N(200000), N(250000), N(250001), N(333333), N(999999), N(3000000),
    2000001, 2000009, 12345678, 99999999,
  ];

  for (const amountKobo of amounts) {
    for (const bps of [0, 1, 250, 500, 733, 1000, 9999, 10000]) {
      const r = fee.computeCompletion({ amountKobo, commissionBps: bps });

      // Reconciles against what the CLIENT PAYS, not the booking amount: the
      // money-in fee is part of their outflow but never enters escrow.
      const sum = r.artistNetKobo + r.platformNetKobo + r.moneyInFeeKobo + r.moneyOutFeeKobo;
      assert.equal(
        sum,
        r.clientPaysKobo,
        `${amountKobo} @ ${bps}bps: parts must sum to what the client paid`
      );

      assert.equal(
        r.parts.reduce((t: Kobo, p: FeePart) => t + p.kobo, 0),
        r.clientPaysKobo,
        `${amountKobo} @ ${bps}bps: parts list must also reconcile`
      );

      // The escrow itself still splits exactly between artist and commission.
      assert.equal(
        r.artistNetKobo + r.commissionKobo,
        amountKobo,
        `${amountKobo} @ ${bps}bps: escrow must split exactly`
      );

      for (const value of [
        r.commissionKobo,
        r.moneyInFeeKobo,
        r.moneyOutFeeKobo,
        r.artistNetKobo,
        r.platformNetKobo,
        r.clientPaysKobo,
      ]) {
        assert.ok(Number.isInteger(value), 'every figure is an integer number of kobo');
      }
    }
  }
});

test('a fractional commission assigns the remainder to the artist, per the documented rule', () => {
  // 2,000,033 kobo at 5% = 100,001.65 → floors to 100,001, leaving 0.65 kobo
  // that the artist absorbs by subtraction.
  const amountKobo = 2000033;
  const r = fee.computeCompletion({ amountKobo, commissionBps: 500 });

  assert.equal(r.commissionKobo, 100001, 'floored, not rounded to 100002');

  // The artist's net is the residual of the escrow, so nothing is dropped.
  assert.equal(r.artistNetKobo, amountKobo - r.commissionKobo);
  assert.equal(r.artistNetKobo + r.commissionKobo, amountKobo);
});

// ---------------------------------------------------------------------------
// Fee-bearer resolution
// ---------------------------------------------------------------------------

test('client cancellation: the client bears the fees, the artist’s share does not', () => {
  // 3–6 day band: 70% client, 30% artist.
  const r = fee.computeClientCancellation({
    amountKobo: N(200000),
    commissionBps: 500,
    clientRefundBps: 7000,
    artistCompensationBps: 3000,
  });

  assert.equal(r.moneyInBearer, 'CLIENT');
  assert.equal(r.clientShareKobo, N(140000));
  assert.equal(r.artistShareKobo, N(60000));

  // The refund is the client's share of the escrow, undiminished. The cost they
  // bear for cancelling is the money-in fee they already paid at funding, which
  // is sunk rather than deducted here.
  assert.equal(r.clientRefundKobo, N(140000));
  assert.equal(r.clientSunkFeeKobo, N(3000), 'paid at funding, not returned');

  // The artist's compensation is reduced by commission alone — never by fees.
  assert.equal(r.commissionKobo, N(3000), '5% of the artist’s ₦60,000');
  assert.equal(r.artistCompensationKobo, N(60000) - N(3000));

  // The two shares reconstitute the booking exactly.
  assert.equal(r.clientShareKobo + r.artistShareKobo, N(200000));
});

test('the ₦0 floor is UNREACHABLE with the default tiers — measured, not assumed', () => {
  // Worth stating, because it changes what #30 has to render and when.
  //
  // The floor triggers only when the client's share is smaller than the escrow
  // fees. On the smallest booking the provider will accept (₦20,000), fees are
  // ₦490 — and even the harshest default band returns the client ₦3,000. The
  // gap is an order of magnitude.
  for (const [band, bps] of [
    ['day-of', 1500],
    ['1-2 days', 4000],
    ['3-6 days', 7000],
    ['7+ days', 10000],
  ]) {
    const r = fee.computeClientCancellation({
      amountKobo: N(20000), // the provider's minimum
      commissionBps: 500,
      clientRefundBps: bps,
      artistCompensationBps: 10000 - Number(bps),
    });
    assert.ok(
      r.clientRefundKobo > 0,
      `${band} on a minimum booking should still refund something, got ${r.clientRefundKobo}`
    );
    assert.equal(r.unrecoveredShortfallKobo, 0, `${band}: no shortfall with the default set`);
  }
});

test('a 0 bps refund band produces a ₦0 refund, stated rather than implied', () => {
  // Under the provider's bearers the refund is no longer reduced by fees, so a
  // ₦0 outcome now arises only from a tier that awards the client nothing —
  // which #8 permits a super-admin to create. #30 must state that in plain
  // language rather than showing a blank field.
  const r = fee.computeClientCancellation({
    amountKobo: N(20000),
    commissionBps: 500,
    clientRefundBps: 0,
    artistCompensationBps: 10000,
  });

  assert.equal(r.clientShareKobo, 0);
  assert.equal(r.clientRefundKobo, 0, 'zero, never negative');
  // They still lose the money-in fee they paid at funding.
  assert.equal(r.clientSunkFeeKobo, N(450));

  // The artist takes the whole escrow less commission.
  assert.ok(r.artistCompensationKobo > 0);
  assert.equal(r.artistShareKobo, N(20000));
});

test('artist cancellation: the client is made whole with zero fee exposure', () => {
  const r = fee.computeArtistCancellation({ amountKobo: N(200000) });

  assert.equal(r.feeBearer, 'ARTIST');
  // 100%. Not "the amount minus fees".
  assert.equal(r.clientRefundKobo, N(200000));
  assert.equal(r.artistCompensationKobo, 0);

  // The platform fronts the fees and records a liability against the artist.
  assert.equal(r.feeLiabilityKobo, r.moneyInFeeKobo + r.moneyOutFeeKobo);
  assert.ok(r.feeLiabilityKobo > 0);
});

test('every tier of the default set produces a split that reconciles', () => {
  const tiers = [
    { clientRefundBps: 10000, artistCompensationBps: 0 },
    { clientRefundBps: 7000, artistCompensationBps: 3000 },
    { clientRefundBps: 4000, artistCompensationBps: 6000 },
    { clientRefundBps: 1500, artistCompensationBps: 8500 },
  ];

  for (const amountKobo of [N(20000), N(200000), N(3000000), 2000033]) {
    for (const tier of tiers) {
      const r = fee.computeClientCancellation({ amountKobo, commissionBps: 500, ...tier });
      assert.equal(
        r.clientShareKobo + r.artistShareKobo,
        amountKobo,
        `${amountKobo} @ ${tier.clientRefundBps}bps must reconstitute`
      );
      assert.ok(r.clientRefundKobo >= 0, 'never negative');
      assert.ok(r.artistCompensationKobo >= 0, 'never negative');
    }
  }
});

test('a split whose percentages do not sum to 10000 is refused', () => {
  assert.throws(
    () =>
      fee.computeClientCancellation({
        amountKobo: N(200000),
        commissionBps: 500,
        clientRefundBps: 4000,
        artistCompensationBps: 5500,
      }),
    /must sum to 10000/
  );
});

// ---------------------------------------------------------------------------
// Fee liabilities
// ---------------------------------------------------------------------------

test('a fee liability is netted off the next payout, and never makes it negative', () => {
  const settled = fee.applyFeeLiabilities({ payoutKobo: N(100000), liabilitiesKobo: N(2070) });
  assert.equal(settled.payoutKobo, N(97930));
  assert.equal(settled.settledKobo, N(2070));
  assert.equal(settled.remainingLiabilityKobo, 0);

  // A liability larger than the payout leaves a remainder rather than a
  // negative disbursement.
  const partial = fee.applyFeeLiabilities({ payoutKobo: N(1000), liabilitiesKobo: N(2070) });
  assert.equal(partial.payoutKobo, 0);
  assert.equal(partial.settledKobo, N(1000));
  assert.equal(partial.remainingLiabilityKobo, N(1070));
});

// ---------------------------------------------------------------------------
// Purity and input discipline
// ---------------------------------------------------------------------------

test('no float, string or non-integer input is accepted anywhere', () => {
  const bad = [1.5, '20000000', null, undefined, NaN, Infinity, {}];

  for (const value of bad) {
    assert.throws(() => fee.moneyInFee(value), TypeError, `moneyInFee(${String(value)})`);
    assert.throws(() => fee.moneyOutFee(value), TypeError, `moneyOutFee(${String(value)})`);
    assert.throws(
      () => fee.computeCompletion({ amountKobo: value, commissionBps: 500 }),
      TypeError
    );
    assert.throws(
      () => fee.computeCompletion({ amountKobo: N(200000), commissionBps: value }),
      TypeError
    );
  }
});

test('the module is pure — the same input always gives the same output', () => {
  const input = { amountKobo: 12345678, commissionBps: 733 };
  const a = fee.computeCompletion(input);
  const b = fee.computeCompletion(input);
  assert.deepEqual(a, b);

  // And it touches nothing: no prisma, no axios, no clock.
  const source = require('node:fs').readFileSync(
    require.resolve('../src/services/feeService.ts'),
    'utf8'
  );
  for (const forbidden of ['require(', 'prisma', 'axios', 'Date.now', 'new Date']) {
    assert.ok(
      !source.includes(forbidden),
      `feeService must not reference ${forbidden} — it is a pure module`
    );
  }
});

test('the refund money-out fee is a documented, flippable assumption', () => {
  // OPEN ITEM (docs/00 §11): EscrowPay has not confirmed whether a refund leg
  // incurs the money-out fee. Defaults to CHARGED, the conservative reading —
  // assuming it is free when it is not means every refund is short by ₦40–₦70
  // and the platform silently absorbs it.
  assert.equal(fee.REFUND_INCURS_MONEY_OUT_DEFAULT, true);

  const charged = fee.computeArtistCancellation({ amountKobo: N(200000) });
  const free = fee.computeArtistCancellation({
    amountKobo: N(200000),
    refundIncursMoneyOut: false,
  });

  assert.ok(charged.feeLiabilityKobo > free.feeLiabilityKobo);
  assert.equal(free.moneyOutFeeKobo, 0);
  // The client is made whole either way — the flag only moves who bears a cost.
  assert.equal(charged.clientRefundKobo, free.clientRefundKobo);
});
