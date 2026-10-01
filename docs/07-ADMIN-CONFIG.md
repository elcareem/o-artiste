# 07 — Admin and Configuration

Permission tiers, versioned configuration records, booking-time snapshots, and audit requirements.

Implemented by **#7**, **#8**, **#9**, **#36**, **#37**.

---

## 1. Two admin tiers

| Role | Scope | Blast radius |
|---|---|---|
| `ADMIN` | Dispute resolution, manual release/refund, strike review | **One booking** |
| `SUPER_ADMIN` | Everything above, plus commission rate and cancellation tiers | **Every booking created afterwards** |

The tiers are separate because the risks differ in kind, not degree. An admin resolving a dispute wrongly affects one transaction and is correctable. A super-admin changing the commission rate affects every booking made from that moment on, and there is no single transaction to point at when it goes wrong.

Admin and super-admin accounts are **seeded or created manually, never self-registered.** There is no public route by which an account can self-assign either role, and `POST /auth/register` rejects an attempt rather than silently downgrading it (`02` §3).

## 2. Permission checks are server-side

**Super-admin-restricted fields are permission-checked at the endpoint.** Hiding a field in the UI is not a permission check — it is a courtesy to the honest user.

`PUT /admin/config/commission` and `PUT /admin/config/cancellation-tiers` both enforce `SUPER_ADMIN` in middleware at the route. #36 asserts the point directly: an invalid or unauthorised request submitted **straight to the API** is rejected even though the UI prevented it.

The frontend mirrors server validation for immediate feedback. **The server remains authoritative.** A tier table with a gap must be unsaveable regardless of which path the request arrives by.

## 3. Versioned, never mutable

Configuration records are **append-only**. A change writes a new record; the previous one is never updated and never deleted.

### Commission rate

`CommissionRate` carries `rateBasisPoints`, `effectiveFrom`, `setByUserId`, `createdAt`.

A resolver returns the rate **effective at a given timestamp**. The canonical test, from #7: set 5%, change to 7%, query yesterday, get 5%.

Two reasons this is not a single mutable value:

**A rate change must never reach backwards.** A booking made at 5% that is still awaiting payout when the rate moves to 7% must still pay out at 5% — that is the deal the artist accepted, and changing it after the fact is taking money from someone who already agreed to different terms.

**An audit trail of who changed the platform's take and when is basic financial-control hygiene** once real money is moving. A single mutable value makes that trail impossible to reconstruct.

Rate is **basis points, integer**. A percentage float means `0.05` can enter a money calculation, and `00` §6 forbids that.

### Cancellation tiers

Rows are **addable and deletable, not merely editable.** The band structure itself will change — a 14-day tier may be introduced, or the day-of band split into "cancelled before start time" and "failed to appear". Fixed rows with editable percentages would force a deploy for what is fundamentally a business decision.

A save writes a **new version**: a new group of rows sharing a `versionId`. Prior sets remain queryable forever. Validation rules are in `05` §5.

## 4. Snapshot at booking time

Versioning achieves nothing on its own. If payout math reads the current live value at payout time, the versioned history is decoration.

**The applicable commission rate and the full cancellation tier set are copied onto the `Booking` at creation.** All later payout and cancellation math reads that snapshot — never live configuration.

| Field on `Booking` | Content |
|---|---|
| `commissionRateBpsSnapshot` | `Int` basis points |
| `cancellationTiersSnapshot` | `Json` — the **full** set, read as a unit |

This is what guarantees that the terms a client acknowledged and an artist accepted are the terms that execute. It is also what makes the `TermsAcknowledgement` in `05` §8 defensible: the acknowledgement records what was shown, and the snapshot ensures that is what runs.

Asserted directly by #15: changing the commission rate or the tier table after a booking exists does not alter that booking's math. Re-verified at #41 as a codebase-wide check that no payout or cancellation path reads live config.

## 5. Audit trail

An `AuditLog` row is written for:

- Every configuration change — naming the actor
- Every dispute resolution — naming the deciding admin
- Every manual release or refund
- Every strike override or expiry
- Every artist-fault reclassification

**Every one of these requires a written reason, rejected with `400` if absent.** A money movement without a recorded justification is indefensible later — and "later" here means a regulator, a lawyer, or a user asking why, months after everyone has forgotten.

Corrections to money follow the ledger rule in `01` §5: **offsetting entries, never edits.** The original stays visible because the sequence — charged, then reversed, and why — is the record that matters if the decision is questioned.

## 6. The configuration surface (#36)

`app/admin/settings/page.tsx` covers every tunable decision in the system:

| Setting | Spec |
|---|---|
| Commission rate | `07` §3 |
| Cancellation tiers (add/delete rows) | `05` §5 |
| Auto-release grace period | `04` §4 — open item `00` §11.5 |
| Strike thresholds and weights | `06` §4 — open item `00` §11.6 |
| Cancellation-rate window and display threshold | `06` §6 — open item `00` §11.7 |

All of these were deliberately built as configuration rather than constants **precisely so this screen can exist**, and so the three open items above can be closed by a decision rather than a deploy.

Requirements: change history showing actor and timestamp for each prior version; non-super-admins cannot see or submit restricted fields; and a **preview showing how a sample booking would be affected before saving** — because a basis-point change is hard to reason about in the abstract and easy to reason about as "this ₦200,000 booking would pay ₦188,000 instead of ₦190,000".

### As built

`GET /admin/settings` returns all six sections in one response. One request rather than six, because the screen shows them together and six round trips is six chances to render a half-loaded page of numbers that govern money.

**Restricted fields are marked, not omitted.** An `ADMIN` receives `commission: { rateBasisPoints, editable: false }` — seeing that a commission rate exists and that it is not theirs to change is more useful than a screen that silently lacks a section. The server refuses the write regardless of what the screen offers, which is the half the UI cannot guarantee.

**The grace period moved out of an environment variable** into the versioned `AutoReleaseConfig` table. It was the only tunable on the list above that could not be changed from this screen — an environment variable needs a redeploy to apply and leaves no record of who changed it or why. The environment variable still wins where it is set, because tests depend on it, and `GET` reports `source` so an operator can tell which of the three values they are looking at; publishing a row while it is set returns a warning rather than saving something silently inert.

**`CommissionRate` and `CancellationTier` gained `setBy` relations.** They were the two oldest config tables and carried a bare `setByUserId` where every later table had a relation, so the history could not name its actor without a second query the reader would not run. Migration `_config_authors`.

**The tier table reads as absent rather than erroring when none has been published.** `resolveTierSet` throws on that and must — a booking cannot be created against a table that does not exist. But this screen is *how the first table gets published*, so on a fresh deployment it would have been a settings page returning 500 for the one thing it exists to fix. The read paths take `tierSetOrNull`; the booking path keeps the throwing one.

Client-side validation in `lib/settings.ts` mirrors `validateTierSet` for immediate feedback. It is a convenience: a set with a gap is unsaveable whichever path the request arrives by, and a test submits four invalid sets directly to the API to prove it.

## 7. Operational visibility (#37)

`app/admin/bookings/` is the screen someone opens when a client emails asking why they received ₦137,860 instead of ₦140,000.

The answer is in the ledger, but **only if it is legible.** A list of raw entries is not an answer; a reconciled view with a visible net position is.

Booking detail must surface: full state history, the check-in record, the terms acknowledgement from #16, and all ledger entries — with a completed booking's entries **summing to zero in the view**, not just in the database.

Manual release and refund exist as a safety valve for cases the automated paths do not cover. Both require a written reason, per §5.

### As built

**The state history did not exist.** `Booking.state` holds where a booking *is*, overwritten on every transition, so "how did it get here" had no answer. The milestone timestamps (`fundedAt`, `releasedAt`, …) cover the happy path and only the happy path — a booking that went to `DISPUTED` and back leaves no trace in them.

`BookingStateTransition` is append-only and written **inside `transition()`'s existing compare-and-swap transaction**, so the state and its history cannot disagree; a history written afterwards has a hole wherever a request died between the two writes. Enforced by `check:rules` like the ledger.

`actorUserId` is nullable on purpose. An auto-release firing on a grace period and a webhook confirming funds have no human behind them, and recording that absence is the honest answer to "who did this" — requiring an actor would make the automated transitions the ones with no record. Bookings predating the table are shown with their timeline derived from the timestamps and each entry marked `reconstructed`, because an admin deciding whether to move money needs to know which entries are recorded facts and which are inferred.

**The reconciliation is computed by the backend, never by the view.** `netByParty` and `sumKobo` come from `ledgerService.reconcile`. A screen that adds up money itself is a second implementation of the arithmetic, and the one that disagrees with the ledger is the one people read.

The detail payload also carries a `projection` from `computeCompletion`. The ledger's artist position is zero until a release happens — which is every booking where the release button is actually offered — so a button reading the ledger would say "release ₦0". The projection comes from the same function the real release uses.

**An unbalanced ledger is only reported on a concluded booking.** A booking in flight legitimately does not sum to zero: money is held and nothing has been paid out. Warning on those would put a red banner on every healthy booking until it settled, which is how a real warning stops being read. A concluded booking with *no* entries is called out separately, because an empty ledger sums to zero and passes the balance check.

**Filters are refused, not ignored.** An unrecognised state or an unreadable date is a 400. A silently dropped filter returns the full list looking like a filtered one, and the reader cannot tell — on a screen whose purpose is answering a specific question about a specific booking, that is worse than an error.
