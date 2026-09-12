# 08 — Build Plan

Sequential, independently verifiable implementation order, with the dependency corrections applied.

---

## 1. How this plan is executed

- **One issue at a time.** Every acceptance box is exercised by a real command before the next issue starts.
- **One phase at a time.** A phase gate re-runs the whole phase from scratch before the next begins.
- **Evidence, not assertion.** Each box is recorded in `docs/ACCEPTANCE-LOG.md` with the command run and its output. No box is ticked by inspection alone, and no box that depends on an unavailable third-party account is ticked at all — it is recorded as blocked.
- **`npm run check:rules` passes before any issue closes.** It accumulates the structural guarantees issue by issue, so an earlier phase cannot erode silently while a later one is being built.

## 2. Dependency corrections

The issue numbering is not a valid build order. Four dependencies run backwards, and one is circular.

| Correction | Reason |
|---|---|
| **#9 before #7 and #8** | Both config endpoints are `SUPER_ADMIN`-restricted and cannot close without role middleware. #7 states this explicitly |
| **#17 pulled into Phase 1, before #10** | Prembly verification is reached *through* EscrowPay, so the provider client must exist first. #10's own technical note anticipates this |
| **#26 before #24 and #25** | Both consume release execution |
| **#33 pulled into Phase 3, before #28** | #28 and #29 both list #33 as a dependency while #33 lists #28 — see below |

### The #28 ⇄ #33 cycle

#33 (strike service) lists #28 as a dependency; #28 lists #33. Neither can be built second.

Resolved by distinguishing the **service** from its **triggers**: #33 builds the accrual engine, the weight table and the configuration surface, which depend on nothing in Part 3. #28 and #29 then call it. The two acceptance criteria in #33 that require a dispute ruling are verified when #32 lands at the end of the same phase, so #33 still closes inside Phase 3.

## 3. Phase 1 — Foundation and Identity

**Order: #1 → #2 → #3 → #4 → #9 → #6 → #7 → #8 → #5 → #17 → #10**

| # | Issue | Gate |
|---|---|---|
| 1 | Monorepo scaffold, `docs/`, issue templates | Both workspaces resolve, no `ELSPROBLEMS` |
| 2 | Express bootstrap, raw-body exception, `/health` | Raw body is a `Buffer` on `/webhooks/*` |
| 3 | Next.js bootstrap, `formatNaira` | `formatNaira(20000000) === '₦200,000'`, `formatNaira(0) === '₦0'` |
| 4 | Prisma schema and migration | Migration applies to a fresh DB; zero `Float`/`Decimal` |
| 9 | Auth, roles, permission middleware | No public path self-assigns `ADMIN` |
| 6 | Seed script | Two runs, identical state |
| 7 | Versioned commission rate | Historical resolver returns 5% for yesterday after a change to 7% |
| 8 | Versioned cancellation tiers | Gap, overlap and non-reconciling sets all rejected by name |
| 5 | Redis and BullMQ | A scheduled job survives a process restart |
| 17 | EscrowPay client | Each method answers from the sandbox; tampered payload rejected |
| 10 | Identity verification | A verified user triggers no second provider call |

#6 follows #9 so the seed hashes passwords with the real auth utility rather than a throwaway.

**Deferred out of phase:** #10's *"unverified client receives 403 on `POST /bookings`"* — that endpoint does not exist until #15. The `requireVerified` middleware is written in #10 and the criterion is verified the moment #15 lands. Recorded as deferred, not ticked.

## 4. Phase 2 — Artists, Booking and Escrow Funding

**Order: #11 → #12 → #13 → #14 → #15 → #16 → #18 → #19 → #20 → #21**

(#17 completed in Phase 1.)

| # | Issue | Gate |
|---|---|---|
| 11 | Artist profile and rate card | ₦19,999 and ₦3,000,001 rejected, message names the range |
| 12 | Artist listing and detail | `cancellationRate` present and `null`, not omitted |
| 13 | Discovery grid and profile page | `null` rate renders **no element in the DOM** |
| 14 | **Fee computation service** | Every boundary tested; parts sum to the total exactly |
| 15 | Booking creation with snapshot | A later config change does not alter this booking's math |
| 16 | Cancellation policy acknowledgement | Funding without an acknowledgement returns `409` |
| 18 | Escrow creation and funding instruction | Provider failure leaves `PENDING_PAYMENT`, no orphan |
| 19 | Append-only ledger | Completed booking reconciles to zero; no update/delete path |
| 20 | **Webhook handler with idempotency** | Replay produces no duplicate state and no duplicate ledger entry |
| 21 | Booking status page | Transitions on the webhook with no manual refresh |

#14 and #20 are the two highest-risk issues in this phase. #14 is where every money number originates and is built pure and tested exhaustively **before anything calls it**. #20 is the highest-severity path in the system (`03` §6).

## 5. Phase 3 — Confirmation, Release, Cancellations and Disputes

**Order: #26 → #22 → #23 → #24 → #25 → #27 → #33 → #28 → #29 → #30 → #31 → #32**

| # | Issue | Gate |
|---|---|---|
| 26 | Release execution | ₦200,000 at 5% disburses **₦190,000** (corrected at #18); sole provider caller by grep |
| 22 | Check-in code generation | An artist token never receives the code |
| 23 | Check-in redemption | Server timestamp; a client-supplied time is ignored |
| 24 | Two-sided confirmation matrix | Every row covered by a test |
| 25 | Auto-release job | Runs twice, releases once; no check-in means no release |
| 27 | Client-initiated cancellation | Fees exceeding the refund yield ₦0, never negative |
| 33 | Strike service | A false-no-show ruling weighs heavier than a late cancellation |
| 28 | Artist cancellation and fee liability | Client receives **100%**; accrual and settlement both in the ledger |
| 29 | Artist-fault reclassification | Offsetting entries; originals intact |
| 30 | Cancellation flows (web) | A ₦0 outcome renders as a readable sentence |
| 31 | Dispute opening and evidence | Opening a dispute prevents auto-release from firing |
| 32 | Admin dispute queue and resolution | Check-in record above the fold; reason mandatory |

**Cross-phase stub:** #22 requires SMS delivery from #38 (Phase 4). The code generation and its scheduled job are built in #22 with dispatch behind `lib/notifications.js`; the stub is filled at #38 and the end-to-end SMS criterion is verified there.

## 6. Phase 4 — Reputation, Admin and Launch Readiness

**Order: #34 → #35 → #36 → #37 → #38 → #39 → #40 → #41** *(numeric order is already valid)*

| # | Issue | Gate |
|---|---|---|
| 34 | Strike consequences and enforcement | A suspended artist `404`s on detail and vanishes from listings |
| 35 | Cancellation rate calculation and display | One cancelled booking out of one shows **no stat** |
| 36 | Admin configuration dashboard | An invalid tier set posted directly to the API is still rejected |
| 37 | Admin bookings and ledger views | A completed booking's entries sum to zero **in the view** |
| 38 | Notifications — SMS and email | A provider outage does not block funding or releasing |
| 39 | User-facing error handling | No raw error object, stack trace or status code anywhere |
| 40 | **End-to-end sandbox verification** | Every scenario reconciles to zero; the replay assertion has teeth |
| 41 | **Pre-launch hardening review** | Every rule verified; every open item closed or accepted in writing |

#40's webhook-replay assertion must **fail when idempotency is deliberately broken.** A test that passes either way proves nothing, and this is the one assertion protecting the highest-severity path in the system.

## 7. Phase gates

At the end of each phase, from a clean state:

1. `npm install` from the repository root
2. `npx prisma migrate reset` and re-seed
3. `node --test` across the backend
4. `npm run lint` on the web workspace
5. `npm run check:rules`
6. Re-run every acceptance command for that phase, recorded in `docs/ACCEPTANCE-LOG.md`

A phase is complete when all six pass and every blocked item is explicitly listed with what it is blocked on.

## 8. External dependencies

Work that cannot be verified locally, and the issue it gates:

| Issue | Needed |
|---|---|
| #1 | GitHub repository and branch protection |
| #2 | Render service — record its **request timeout** and **idle behaviour** |
| #3 | Vercel project, root directory `apps/web` |
| #4 | Managed Postgres → `DATABASE_URL` |
| #5 | Managed Redis → `REDIS_URL` |
| #17, #10 | EscrowPay sandbox keys, webhook signature contract, **amount unit** (`00` §11.8) |
| #38 | SMS provider and transactional email credentials |

Steps and environment variables are tracked in `DEPLOYMENT-CHECKLIST.md`.
