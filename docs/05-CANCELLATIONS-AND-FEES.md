# 05 — Cancellations and Fees

The fee schedule, the rounding rule, the cancellation tier table, fee-bearer resolution, `FeeLiability` recovery, and disclosure requirements.

Implemented by **#14** (`feeService.js`, pure), **#27**, **#28**, **#29**. Every number in the system originates here.

---

## 1. Fee schedule

| Fee | Rule |
|---|---|
| **Platform commission** | Configurable bps, default **500** (5%), applied to the artist's gross share |
| **EscrowPay money-in** | 1.5% + ₦100, **capped at ₦2,000**, for amounts up to ₦250,000; **0.8% uncapped** above ₦250,000 |
| **EscrowPay money-out** | **₦40** for payouts up to ₦50,000; **₦70** above |
| **Verification** | ₦50 per successful check, **once per person for life** |

Verification is an onboarding cost and a platform cost. **It never enters per-booking economics** — it is not deducted from a payout, not added to a fee total, and not charged again for a returning user.

### The ₦250,000 boundary

At exactly ₦250,000 the cap and the upper rate coincide: ₦2,000 is precisely 0.8% of ₦250,000. The schedule is therefore **continuous** at that point, and a booking just above it pays fractionally more, not less.

> **Correction to #14's technical note**, which describes the curve as non-monotonic around ₦250,000: it is not. ₦250,000 costs ₦2,000 and ₦260,000 costs ₦2,080, which is an increase. What *is* non-monotonic is the **effective rate across the whole range** — the flat ₦100 makes small bookings expensive in percentage terms, the rate then falls through the capped band from 1.6% down to 0.8%, and sits flat at 0.8% above. Both sides of the boundary are still tested per #14's acceptance criteria; the tests are worth having, the stated reason was just wrong.

## 2. Where the cap binds

For amounts up to ₦250,000, the ₦2,000 cap starts binding once `1.5% + ₦100 > ₦2,000`, i.e. above roughly **₦126,667**. Below that the percentage governs and rounding is live; above it the fee is a constant ₦2,000. Tests must cover both regions, not only the ₦250,000 edge.

## 3. Worked example — the canonical ₦200,000 booking

Booking ₦200,000 = **20,000,000 kobo**, commission 500 bps, completing normally.

| Step | Arithmetic | Kobo |
|---|---|---|
| Booking amount | | 20,000,000 |
| Money-in | 1.5% = 300,000, + ₦100 = 310,000, **capped** | −200,000 |
| Commission | 5% of 20,000,000 | −1,000,000 |
| Money-out | payout above ₦50,000 → ₦70 | −7,000 |
| **Artist net** | | **18,793,000** |

**₦187,930** — the figure asserted in #14 and #26.

## 4. The rounding rule

Money is integer kobo, and percentages produce fractions. Dropping them means the parts no longer sum to the whole, and over thousands of bookings a silently discarded kobo is a ledger that does not reconcile.

Two rules, applied everywhere, no exceptions:

> **R1 — Percentage computations floor.**
> `share = Math.floor((base * bps) / 10000)`, in integer arithmetic. No `Math.round`, no float division, no `toFixed`.

> **R2 — The residual party absorbs the remainder.**
> In any split, the **last** share is computed as `total − sum(all previously computed shares)`, never from its own percentage. The parts then sum to the total **by construction**, not by luck.

### Named residual parties

| Split | Floored | Residual (absorbs the remainder) |
|---|---|---|
| Commission on a payout | Platform commission | **Artist** |
| Cancellation refund/compensation | Client refund | **Artist** |
| Escrow fees | Each fee | — deducted from a named bearer, never split |

The artist is the residual party in both cases. The remainder is always under one kobo, so this is not a fairness question — it is a determinism question. A rule that is *named, consistent, and tested* is the requirement; which party it favours is not.

Consequence worth stating: **never compute both sides of a split from their own basis points.** With `clientRefundBps = 7000` and `artistCompensationBps = 3000`, flooring both independently can lose a kobo. R2 makes that impossible.

## 5. Cancellation tiers

### Default set

| `minDaysBefore` | `maxDaysBefore` | `clientRefundBps` | `artistCompensationBps` |
|---|---|---|---|
| 7 | `null` | 10000 | 0 |
| 3 | 6 | 7000 | 3000 |
| 1 | 2 | 4000 | 6000 |
| 0 | 0 | 1500 | 8500 |

Bands are inclusive on both ends. `null` in `maxDaysBefore` means open-ended. `daysBeforeEvent` is **whole days**, floored, computed in **Africa/Lagos** from the cancellation timestamp to the event start. Day 0 means cancelling on the event day.

### Validation (#8)

A tier set is rejected unless **all** hold:

- No two bands overlap — the error **names the overlapping bands**.
- No gap between bands — the error **names the uncovered window**.
- Day 0 is covered.
- Every row satisfies `clientRefundBps + artistCompensationBps == 10000`.

The validation matters more than it first appears. A gap means a booking cancelled in that window has **no applicable rule**, and there is no safe default: refunding everything harms the artist, refunding nothing is FCCPA exposure. The validation makes an unresolvable state unsaveable — which is the only way to guarantee it never has to be resolved under pressure with money already held.

### Commission is not part of the split

The tier percentages divide **the booking total**, summing to 10000 bps. Platform commission is applied to the artist's share **afterwards**, not carved out of the split. These are two separate operations in validation and in computation, and conflating them silently changes what the client was shown.

## 6. Fee-bearer resolution

| Outcome | Bearer | Mechanism |
|---|---|---|
| Booking completes | **Artist** | Deducted from the payout |
| Client cancels | **Client** | Deducted from the refund |
| Artist cancels | **Artist** | Platform fronts it; recovered via `FeeLiability` |

### Client cancels

```
clientRefundGross    = floor(amount × clientRefundBps / 10000)      [R1]
artistCompGross      = amount − clientRefundGross                   [R2]

artistCommission     = floor(artistCompGross × commissionBps / 10000)
artistCompNet        = artistCompGross − artistCommission

escrowFees           = moneyIn + moneyOut(refund leg) + moneyOut(compensation leg)
clientRefundNet      = max(0, clientRefundGross − escrowFees)
```

**The client bears all escrow fees** — they are the at-fault party.

**The artist's compensation is untouched by escrow fees**; only the snapshotted commission applies. They have already lost a date they cannot refill, and deducting a flat processing cost from an already-reduced compensation payment would penalise them twice for someone else's decision.

Whether the refund leg itself incurs a money-out fee is **open item `00` §11.1**. Implemented as a configurable flag **defaulting to charged**, with the assumption noted in `feeService.js`.

### The ₦0 floor

Fees can exceed a small refund — a ₦20,000 booking cancelled day-of refunds ₦3,000 gross against roughly ₦2,400 of fees, and a ₦25,000 booking cancelled day-of refunds ₦3,750 against fees that may exceed it outright.

**The refund floors at ₦0. It is never negative, and the shortfall is not recovered from anyone.** Building collection logic for a sub-₦2,000 gap costs more than the gap.

But it must be **shown before the client commits** (§7), never discovered afterwards.

> **Ledger consequence.** When the floor bites, the fees actually recovered are less than the fees charged. The difference is written as a **platform-borne ledger entry** so the booking still reconciles to zero. Without that entry the sum is non-zero and every reconciliation check in the system fails on a legitimate outcome.

### Artist cancels

```
clientRefund  = amount            — 100%, zero fee exposure
feeLiability  = moneyIn + moneyOut(refund leg)     accrued against the artist
```

**The client receives 100%, not a fee-reduced amount.** They did nothing wrong, and passing them any cost for the artist's decision would undermine the guarantee the whole platform is built on.

This case has a structural problem the client case does not: the artist bears the fees but **has no money in escrow to deduct from.** The client's payment is the only money in the transaction and all of it is going back. Hence `FeeLiability`.

## 7. `FeeLiability` recovery

1. **Accrual** — at artist cancellation. Ledger: the platform bears the cost now (`FEE_LIABILITY_ACCRUED`).
2. **Settlement** — netted off the artist's **next** release, inside `escrowService.js`, before disbursing. That payout is the only moment the artist has money in the system to settle against. Ledger: `FEE_LIABILITY_SETTLED`.
3. **Write-off** — if the account closes or goes permanently inactive. Pursuing a ₦2,000 debt through collections costs more than the debt.

Both the accrual and the settlement are visible in the ledger — #28 asserts exactly that, because a liability that appears only as a smaller payout is indistinguishable from a miscalculation.

## 8. Disclosure requirements

This section is a compliance obligation, not a UX preference. See `00` §10.

- The **snapshotted** tier table is rendered in full at checkout as a **distinct step, not a link**, and not buried in general T&Cs.
- The client **actively acknowledges**. No pre-ticked box, no passive acceptance.
- A `TermsAcknowledgement` row persists the **literal percentages as displayed**, the client id, the booking id, and the timestamp — **not** a foreign key to a config version. A pointer requires reconstructing what the client saw; a copy *is* what they saw.
- **A booking cannot proceed to funding without a recorded acknowledgement** — `409`, and the checkout step cannot be bypassed by calling the funding endpoint directly.
- The acknowledgement is retrievable later, from the admin booking detail, for dispute defence.
- Before confirming a cancellation the client sees the **exact** refund, the **exact** artist compensation, and the **exact** fees — including a **₦0 outcome stated in plain language**, never implied by a blank or zero field.
- Before accepting a booking the artist sees their **net payout** after commission and escrow fees.
- Before confirming a cancellation the artist sees the **fee liability amount and the account-standing consequence** — both are things they should be able to weigh beforehand, not discover on their next payout.

**A deduction we cannot prove was disclosed is a deduction we may not be able to defend.**

## 9. Purity

`feeService.js` is **pure**: no database, no network, no clock. Inputs and outputs are kobo integers and basis points.

That is what makes it exhaustively testable — every boundary, every rounding case, and the summation invariant are verifiable in unit tests rather than only observable through integration. It is built and tested standalone **before anything calls it**, because every money number in the system originates here and a bug at this layer is invisible everywhere else until it reaches a ledger that will not balance.

**The invariant asserted for every tested input: the computed parts sum to the booking total exactly. No kobo unaccounted for.**
