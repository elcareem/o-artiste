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

Requirements: change history showing actor and timestamp for each prior version; non-super-admins cannot see or submit restricted fields; and a **preview showing how a sample booking would be affected before saving** — because a basis-point change is hard to reason about in the abstract and easy to reason about as "this ₦200,000 booking would pay ₦185,930 instead of ₦187,930".

## 7. Operational visibility (#37)

`app/admin/bookings/` is the screen someone opens when a client emails asking why they received ₦137,860 instead of ₦140,000.

The answer is in the ledger, but **only if it is legible.** A list of raw entries is not an answer; a reconciled view with a visible net position is.

Booking detail must surface: full state history, the check-in record, the terms acknowledgement from #16, and all ledger entries — with a completed booking's entries **summing to zero in the view**, not just in the database.

Manual release and refund exist as a safety valve for cases the automated paths do not cover. Both require a written reason, per §5.
