# 09 — Launch Readiness

Issue #41. The record that each non-negotiable rule was verified, and that every open item was **resolved or accepted as a launch risk by a named person** — before the system holds money belonging to people who are trusting it.

**As of 1 October 2026.** Sign-off fields are blank on purpose: the decisions in §5 are the business's to make, not the engineering team's.

---

## 1. Verdict: not ready for real money

The code rules all pass, but six things stand between this system and a real booking. The first is a scope gap the backlog never covered; the rest are actions only the account owner can take.

| # | Blocker | Owner | Why it blocks |
|---|---|---|---|
| **B1** | **The web app has no screens for signing up, identity verification, an artist's profile and bank account, creating a booking, accepting terms, confirming after the event, raising a dispute, or a "my bookings" list.** | Engineering, once scoped | Every one of these exists as a backend endpoint and none has a screen, because no issue in the backlog asked for them. A real person can browse artists, sign in, and check in at an event — but cannot sign up or book. |
| **B2** | **The database is on Render's free plan, which expires on 11 October 2026 and has no backups.** | Account owner | In ten days the database is deleted. And #41 requires a restore to have been *performed*, which is impossible without backups. Upgrade, enable backups, restore one to a scratch database, and record the date here. |
| **B3** | **The webhook signature scheme has never been checked against a real EscrowPay delivery.** | Account owner | Every webhook test verifies our handler against our reading of EscrowPay's docs. If the reading is wrong, every real delivery is rejected with 401 — and a client's payment is never recorded. Send one test delivery from the EscrowPay dashboard's Events tab and report the status code. |
| **B4** | **Credentials were exposed in a working session and must be rotated:** the production database password and the `sk_test_` API key. | Account owner | Neither is in the repository (verified — §3), but both were pasted into a conversation transcript. Rotate both; issue a fresh `sk_live_` key only at go-live. |
| **B5** | **The database accepts connections from anywhere (`0.0.0.0/0`).** | Account owner | Restrict inbound access to the Render services that need it before any real identity data is stored. |
| **B6** | **EscrowPay's commercial terms and our own regulatory position are not in writing** (open items 11.2, 11.3). | Account owner | See §5. These are the two items this document recommends **not** accepting as risks for a public launch. |

---

## 2. Code verification

Every rule here is enforced **mechanically** — by `npm run check:rules` or by a test that fails if the rule is broken — not by this document's say-so. Each mechanical check was confirmed to fail on a planted violation before being relied on.

| Rule | Evidence | Status |
|---|---|---|
| No `Float` or `Decimal` on any monetary field | `check:rules` — *No Float or Decimal field type in the Prisma schema* | ✅ |
| `escrowService` is the sole caller of provider release and refund | `check:rules` — *escrowService.ts is the sole caller of release/refund* | ✅ |
| No ledger update or delete path | `check:rules` — *No ledger update or delete path*, plus *ledgerService.ts is the sole writer* | ✅ |
| Every webhook path is signature-validated and idempotent | One webhook route exists (`POST /webhooks/escrowpay`). `webhooks.test.ts`: a tampered payload is a 401 and leaves no record; an identical replay changes nothing; the previous secret is honoured during rotation. The e2e run replays a delivery and proves its own replay check fails when idempotency is deliberately broken. **Caveat: B3.** | ✅ *against our reading of the scheme* |
| No card payment path | `check:rules` — *No card payment path* | ✅ |
| Frontend makes no direct provider calls | `check:rules` — *Frontend makes no direct provider calls* | ✅ |
| Snapshots, never live config, for payout and cancellation math | `check:rules` — *Live configuration is read only by the snapshot and the admin screens* (**new in #41**). Live config is read in exactly three places: the booking snapshot at creation, the admin screens, and the config modules themselves. | ✅ |
| Super-admin fields are permission-checked server-side | `permissionSweep.test.ts` (**new in #41**) walks every router the app mounts, finds every route with a role guard, and calls each as every role it excludes — 42 guarded routes, 102 role/route pairs, all 403. A second test pins *which* routes are super-admin-only, so a commission endpoint quietly widened to `ADMIN` fails even though its weaker guard would still pass the sweep. | ✅ |

### What the verification turned up

Hardening found five defects. All are fixed in this branch, each with a test that fails when the fix is reverted.

| Defect | Effect | Fix |
|---|---|---|
| **The check-in form rejected every valid code.** It validated for 6 characters; codes are 8. | No artist could check in through the web app — and the check-in is what releases their money. | Shipped in #39. Now normalises exactly as the backend does, with a test that reads the backend's `CODE_LENGTH` from source. |
| **The bank list was unreachable.** `GET /artists/:id` was registered before `GET /artists/banks` and answered it with "Artist not found." | No artist could load the banks for their payout account. | Route order fixed. The sweep now detects *any* route shadowed by an earlier parameter route, across every router. |
| **Every request appeared to come from Render's proxy.** No `trust proxy` setting. | Every terms acknowledgement (#16) recorded Render's IP as the client's — evidence that identifies nobody. An IP-based limit would have throttled all users as one. | Trusts exactly one proxy on Render, none elsewhere (trusting a proxy that isn't there lets callers forge their address). |
| **Identity checks claimed consent nobody gave.** Neither our client nor the provider required it; both defaulted to `true`. | A national identity number was sent for checking with consent asserted on the person's behalf — an NDPR problem. | `POST /me/verification` requires `consent: true` (strictly), records when and from where in the audit log *before* the identifier leaves the system, and passes it explicitly. The client no longer defaults it. |
| **Rate limits handed out free allowances after every restart.** The Redis client refused commands while connecting, so the limiter failed open and did not count them. | Every deploy and reconnect reset everyone's limit. | Commands queue while connecting; a bounded wait keeps an outage failing open fast. |

---

## 3. Operational

| Requirement | Status | Evidence / action |
|---|---|---|
| Rate limiting on auth, booking creation and check-in | ✅ | Redis-backed, so it holds across instances. Sign-in 10 / 15 min per address and account; registration 5 / hour per address; booking creation 20 / hour per user; check-in 10 / 10 min per artist and booking. **Also identity verification, 5 / day per user — each attempt costs ₦50 at the provider.** Fails open, so a Redis outage never locks anyone out; none of these endpoints relies on the limit alone. An off switch exists for the test suite and **is ignored on Render**. |
| Secrets absent from the repository | ✅ | Full history scanned for `sk_test_`/`sk_live_` keys, `whsec_` secrets and credentialed connection strings: only placeholders and test fixtures. The leaked credentials (B4) exist only in a conversation transcript. |
| `.env.example` complete | ✅ | Every `process.env` read in both apps is documented — checked mechanically, not by reading. |
| Production webhook URL registered with EscrowPay | ⚠️ **Account owner to confirm** | Registered after an earlier finding that none was. Confirm exactly **one** URL is registered and that B3's test delivery reaches it. |
| Database backups configured, and a restore verified | ❌ **Blocker B2** | Not possible on the free plan. |

---

## 4. Not verified, and why

Stated plainly rather than implied by omission.

- **The real EscrowPay sandbox has never been run end to end.** Its public API cannot fund an escrow (open item 11.12), so `npm run e2e` runs against a local simulator built from observed sandbox behaviour. Its sandbox mode works but needs a person to pay each booking on the hosted checkout page.
- **No notification has ever been delivered.** There are no Termii or email credentials (open item 11.11). Until there are, a client will not receive their check-in code by SMS — they can still read it in the app.
- **No real payout has ever reached a real bank account.** Everything up to the provider is tested; past it, nothing has been observed.

---

## 5. Open items — decisions

Each must be **resolved**, or **accepted as a launch risk** by a named person with a date. "Recommendation" is engineering's view; the decision is not engineering's.

| Item | Status | Recommendation | Decision | By / date |
|---|---|---|---|---|
| **11.1** Whether a refund to the client costs the money-out fee | Open. Configured as **charged** — the conservative assumption, so the error case is that we over-reserve. | Resolve with one sandbox run: pay one booking by hand, refund it, read `GET /transactions/{id}/fees`. Twenty minutes. | | |
| **11.2** EscrowPay commercial terms, uptime and support in writing | Open | **Do not accept for a public launch.** Every naira moves through them; an outage with no agreed support path is a dispute nobody can resolve. A closed pilot with friendly users could proceed. | | |
| **11.3** Legal counsel on our own regulatory position | Open | **Do not accept for a public launch.** Holding released funds in our wallet between release and payout (11.9) is exactly the question counsel needs to answer. | | |
| **11.4** Bookings above ₦3,000,000 | **Resolved as policy:** hard rejection naming the ceiling; no workaround exists. | Accept as written. | | |
| **11.5** Auto-release grace period | Configurable; ships at **48 hours** after the event. | Accept the default; revisit after the first 50 completed bookings. | | |
| **11.6** Strike thresholds and weights | Configurable. Artists: suspended at 3 points, removed at 6; a day-of cancellation is 3. Clients: warned at 1, restricted to 14-day lead time at 3, suspended at 5. | Accept the defaults; revisit with data. Every strike is appealable and every override needs a written reason. | | |
| **11.7** Cancellation-rate display threshold | Configurable; shown only after **5** concluded bookings in a 12-month window. | Accept. | | |
| **11.8** Provider amount unit | **Resolved:** `amount_minor`, in kobo, verified against the sandbox. | Close. | | |
| **11.9** Automatic payout disabled; releases land in our wallet | Open. Two-leg payout implemented; money sits with us for seconds. `GET /admin/payouts/awaiting` lists anything that stays. | Accept for launch **only** with 11.3 resolved, and ask EscrowPay to enable automatic payout. | | |
| **11.10** ₦50 identity charge | **Resolved:** once per person. | Close. | | |
| **11.11** Notification request shapes unverified | Open — no credentials. | Obtain a Termii key and a **registered** sender ID (registration takes days), and an email provider with a verified domain. Watch the first real send: a wrong shape is a 4xx, which is logged and not retried. | | |
| **11.12** Sandbox cannot be funded through the API | Open | Ask EscrowPay for a test-mode funding endpoint; meanwhile accept, with sandbox mode run by hand before launch. | | |

---

## 6. The account owner's checklist

In the order they matter.

1. **Upgrade the database off the free plan before 11 October 2026**, enable backups, restore one into a scratch database, and record the date in §3. (B2)
2. **Rotate** the production database password and the `sk_test_` key. (B4)
3. **Send a test webhook delivery** from the EscrowPay dashboard and report the HTTP status. (B3)
4. **Restrict database inbound access** to the Render services. (B5)
5. **Get EscrowPay's terms in writing** and **brief legal counsel** — or decide, in §5, that a closed pilot proceeds without them. (B6)
6. **Decide the scope for B1** — the missing user-facing screens — so it can be built.
7. Get **Termii and email credentials**, and register the SMS sender ID early.
8. Fill in every **Decision** in §5.
