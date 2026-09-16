# 00 — Overview

Business context, custody decision, provider selection, fee-bearer rules, and the register of open items.

This document is the entry point to the specification. Read it before `01`–`08`.

---

## 1. What this system is

An artist booking platform for the Nigerian market where a client books a performer, pays upfront, and the money is held by a licensed third party until both sides confirm the event took place.

The transaction the platform exists to make possible:

1. A client finds an artist and agrees a fee.
2. The client pays the full amount by bank transfer, into an account controlled by a CBN-licensed bank — not by us.
3. The artist performs, knowing the money is already secured.
4. The artist redeems a code held by the client, proving the two were physically together.
5. Both sides confirm, and the money is released to the artist net of commission and fees.
6. If the artist does not appear, the client is refunded.

## 2. The problem

Somebody has to go first, and neither party wants to.

An artist asked to perform on the promise of payment afterwards is routinely not paid, or paid late, or paid less than agreed. A client asked to pay a deposit upfront has no recourse if the artist does not appear — a problem that is acute in live entertainment, where the service is consumed at a fixed moment that cannot be rescheduled and where the client has usually incurred large non-recoverable costs around the booking.

Every workaround costs something:

| Workaround | Cost |
|---|---|
| Protect the client with pay-on-delivery | Artists stop taking bookings |
| Protect the artist with non-refundable deposits | Clients don't book |
| Hold the money ourselves | A licensing problem we are not equipped to solve |
| Take card payments | A chargeback can land months after the performance |

Conditional settlement resolves this without the platform taking on any of those costs.

## 3. The custody decision — the platform never holds funds

**No code path may route client funds into a platform-controlled account.** This is the single most important architectural constraint in the system, and it is not negotiable for convenience, for speed, or for a "temporary" workaround.

Two reasons:

**Regulatory.** Holding customer money in Nigeria is a licensed activity. Operating a pooled account of client funds without that licence is a problem no product feature justifies.

**Structural.** The platform's entire value proposition is that neither party has to trust us. The moment we hold the money, we become another party who could fail, absorb the funds, or go under — and the client is back to the original problem with an extra intermediary.

Funds sit with **Rubies MFB**, a CBN-licensed microfinance bank, in a designated account. They are not on our balance sheet. Deposits held there are NDIC insured, subject to the NDIC's coverage limits.

## 4. Provider selection — EscrowPay

EscrowPay was selected because its API product matches the shape of this problem precisely:

- **Custody is with a licensed bank**, not with the provider and not with us.
- **The platform decides disputes.** EscrowPay does not arbitrate on the API product. Funds stay held until we instruct release or refund. We know the artists, the categories and the market; an outside arbiter does not.
- **Bank transfer only, no cards.** Chargebacks and conditional settlement are structurally incompatible, and the provider removed the exposure rather than pricing it in. This matches our own conclusion.
- **Verification is built in**, via Prembly, on both sides, once per person rather than once per transaction.
- **The API surface is small** — create, check, release, refund, plus webhooks — which keeps the integration auditable.

### Constraints this imposes

| Constraint | Consequence |
|---|---|
| Transactions ₦20,000 – ₦3,000,000 | Artist rates are validated against this range at profile level (see `02`, `05`). Above-ceiling handling is **open item §11.4** |
| Bank transfer only | No card path may be implemented anywhere in this codebase |
| Both parties must verify | Verification is part of onboarding, not checkout |
| Disputes are ours | We build the dispute queue, the evidence model, and the resolution authority (`04`) |

## 5. User entities

| Entity | Description |
|---|---|
| **Client** | Books and pays. Holds the check-in code. Confirms the event happened, or claims a no-show. Carries a strike history and a cancellation rate. |
| **Artist** | Is booked and paid. Redeems the client's code on arrival. Sees net payout before accepting. Carries a strike history and a published cancellation rate. |
| **Admin** | Resolves disputes, issues manual release/refund, reviews strikes. Affects one booking at a time. |
| **Super-admin** | Everything an admin can do, plus platform configuration — commission rate, cancellation tiers, thresholds. Affects every booking created afterwards. |

The separation between admin and super-admin exists because the two roles carry different kinds of risk. See `07`.

Both sides are verified, and both sides accrue strikes. An asymmetric system where only artists face consequences would leave client misconduct costless — and client misconduct is the more dangerous kind here, because a false no-show claim is an attempt to extract a free performance. See `06`.

## 6. Money: the non-negotiable rules

1. **Kobo integers everywhere.** Every monetary amount in the database, in service code, and in API payloads is an `Int` in kobo. 1 NGN = 100 kobo.
2. **No `Float`, no `Decimal`, ever.** Floating-point drift on money is invisible in testing and irreconcilable in production.
3. **Naira is a display concern only**, produced by `formatNaira(kobo)` in the web app. Nothing in the backend converts.
4. **Percentages are basis-point integers.** `0.05` never enters a money calculation; `500` does.
5. **Remainders are assigned deterministically**, never dropped. See `05` §4.
6. **Every money movement writes a `LedgerEntry`** in the same database transaction as the state change it accompanies. See `01` §5.
7. **Only `escrowService.js` may instruct a release or a refund.** See `03` §5.

## 7. Fee-bearer rules

The full fee schedule and its arithmetic live in `05`. The principle:

> **Corrected at #18.** This section previously said the **artist** bears the
> escrow fees when a booking completes. That was written from the provider's
> public fee schedule before a sandbox key existed, and it is wrong about the
> bearers. `GET /fees/configuration` on the live account reports
> `escrow_service: payer="payer", timing="at_funding"` and
> `payout: payer="business", timing="at_payout"`. `05` §1 carries the full
> correction; `01`, `07` and `08` were updated at the time and this section was
> missed.

| Fee | Who bears it | When | Reasoning |
|---|---|---|---|
| **Money-in** | **Client** | At funding, **on top of** the booking amount | The provider charges the payer directly. It never enters escrow, so it is never ours to deduct |
| **Money-out** | **Platform** | At payout | The provider charges the business. It reduces our take rather than the artist's payment |
| **Commission** | Artist | At release | Deducted from the escrow, at the booking's snapshotted rate |

On a cancellation the at-fault party bears the fees:

| Outcome | Who bears the escrow fees | Reasoning |
|---|---|---|
| Client cancels | Client | They are the at-fault party. The money-in fee they paid at funding is consumed and not refunded — that *is* them bearing it |
| Artist cancels | Artist, via `FeeLiability` | They are the at-fault party — but there is no artist money in escrow to deduct from, so the platform fronts it and recovers from their next payout (#26) |

Three consequences worth stating plainly:

- **A client transfers more than the booking price.** A ₦200,000 booking is a ₦202,000 transfer. This must be disclosed before they reach their banking app, not discovered there (#21).

- **On an artist cancellation the client receives 100%**, not a fee-reduced amount. They did nothing wrong, and passing them any cost for the artist's decision would undermine the guarantee the platform is built on.
- **On a client cancellation the artist's compensation is untouched by fees.** They have already lost a date they cannot refill; deducting a flat processing cost from a reduced compensation payment would penalise them twice for someone else's decision.

## 8. Why a check-in code

Client-only confirmation was rejected: it lets a dishonest client receive a performance and then claim a no-show, which is the single highest-value fraud available against this system.

The code is issued to the **client** and the artist must obtain it in person. That direction is the entire point — a code the artist could retrieve from their own portal would prove nothing about attendance.

Geolocation was considered and rejected as the primary mechanism. GPS drifts 50–150m indoors, large venues make "on the property" indistinguishable from "on stage", and mock-location apps make spoofing trivial on Android. It is captured as supporting metadata where available, and never gates a check-in. See `04`.

## 9. Why background jobs are mandatory

Three behaviours are time-triggered rather than request-triggered and cannot be expressed as request-time logic:

1. **Auto-release** after the post-event grace period. The entire point is that it fires precisely when the client has *not* made a request.
2. **Event-day check-in code delivery** and arrival prompts.
3. **Webhook retry** on processing failure.

This is why the backend is a persistent Node process with Redis and BullMQ, rather than serverless API routes inside the Next.js app. See `PROJECT_GUIDE.md` §1.

## 10. Compliance posture

**FCCPA.** Nigeria's Federal Competition and Consumer Protection Act gives consumers a right to a refund where a service is not rendered per agreed terms. There is public precedent of Nigerian venue cancellation deductions escalating into disputes specifically on the grounds that the terms were not clearly disclosed.

The practical consequence: **a deduction we cannot prove was disclosed is a deduction we may not be able to defend.** This is why the cancellation tier table is rendered in full as a distinct checkout step, actively acknowledged, and persisted with the literal percentages as displayed rather than a pointer to a config version. See `05` §7.

**NDPR.** Identity verification stores the *result*, never the raw NIN or BVN. Retaining the identifier creates data-protection exposure with no operational benefit.

**Our own regulatory position.** EscrowPay's arrangement with its banking partner covers *their* operation, not ours. What this platform needs in its own right is a question for legal counsel — **open item §11.3**.

---

## 11. Open items

Items that are not resolved and are not ours alone to close. Each must be **resolved or explicitly accepted as a launch risk** before real money moves (see `08`, final phase).

| # | Item | Blocked on | Interim behaviour |
|---|---|---|---|
| **11.1** | Whether a refund leg to the client incurs the EscrowPay money-out fee | EscrowPay confirmation | Implemented as a configurable flag, **defaulting to charged**. Assumption noted in `feeService.js`. |
| **11.9** | **Automatic payout is disabled on this EscrowPay business** (`automatic_payout_disabled`), so a release lands in our wallet and we send it on | EscrowPay | Two-leg payout implemented: `release` then `POST /wallets/{id}/payouts`. The window in which the platform holds an artist's money is seconds, not days, and `GET /admin/payouts/awaiting` lists any that stayed open. **Ask EscrowPay to enable automatic payout** — if they do, the wallet leg disappears and §3 stops being strained. |
| **11.2** | EscrowPay commercial terms, uptime and support expectations in writing | EscrowPay | None — commercial, not technical |
| **11.3** | Legal counsel on our own regulatory position | Counsel | None — proceed with the custody rules in §3, which are the conservative posture |
| **11.10** | ~~Whether the ₦50 identity-verification charge is per person or per transaction~~ — **resolved: one-time per person** | — | Confirmed by the maintainer. `#10` already caches the result so a returning user triggers neither a provider call nor a second charge; the remaining question is whether a *failed* attempt bills, which decides whether the retry path has a cost. |
| **11.4** | Handling for bookings above ₦3,000,000 | EscrowPay / product | **Hard rejection** with a message naming the ceiling. No workaround path may be built. |
| **11.5** | Final auto-release grace period value | Product decision, needs real data | Configurable, default 48–72h. Never hardcoded. |
| **11.6** | Final strike thresholds and weights | Product decision, needs real data | Configurable. Never hardcoded. |
| **11.7** | Final minimum-bookings threshold for cancellation-rate display | Product decision, needs real data | Configurable. Below threshold the API returns `null`. |
| **11.8** | Provider amount unit — whether EscrowPay payloads take kobo or whole Naira | EscrowPay sandbox documentation | Single conversion point in `lib/escrowpay.js` gated on `ESCROWPAY_AMOUNT_UNIT`. On `naira` it asserts the kobo amount divides evenly by 100 and throws otherwise, rather than silently rounding. |

Items 11.5, 11.6 and 11.7 share a shape: the right number is not knowable until there is real booking data. All three ship as configuration so the decision can be made later without a deploy — that is the whole reason `07`'s versioned configuration exists.
