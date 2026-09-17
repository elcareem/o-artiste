# 06 — Reputation and Strikes

Strike triggers and weights for both parties, enforcement ladders, and the cancellation-rate statistic.

Implemented by **#33**, **#34**, **#35**.

---

## 1. Both sides accrue

An asymmetric system where only artists face consequences would leave client misconduct costless — and client misconduct is the more dangerous kind here.

A client who cancels late has inconvenienced an artist. **A client who receives a performance and then claims it never happened has attempted theft.** A system that treats those identically is mispricing the behaviour it most needs to deter, which is why the weights differ.

## 2. Artist triggers

| Timing of cancellation | Consequence |
|---|---|
| **7+ days out** | Fee liability only — **no strike** |
| **3–6 days out** | Strike |
| **1–2 days out** | Strike + cancellation rate published |
| **Day-of / no-show** | Strike + **suspension pending review** |

A cancellation seven days out is a normal business event. The artist still bears the fee liability, because the fees were still incurred, but there is nothing to deter — a week is enough time for the client to rebook.

## 3. Client triggers

| Trigger | Weight |
|---|---|
| Cancellation in the 1–2 day band | Standard |
| Cancellation in the day-of band | Standard |
| Dispute ruled against them | Standard |
| **Dispute ruled against them on a false no-show claim** | **Heavier** |

The heavier weight is the whole point of §1. A false no-show claim, ruled against, is an attempt to obtain a performance for free — established by the check-in record contradicting the claim (`04` §3).

## 4. Configuration, not constants

**Every threshold and every weight is read from configuration.** None is hardcoded.

The right numbers are not knowable until there is real data on how often each trigger actually fires — `00` §11.6. Changing a threshold must change accrual behaviour **without a deploy**, and #33 asserts exactly that.

Every strike records its **triggering booking, reason, weight, and timestamp**, and strikes are queryable per user for admin review. A strike whose cause cannot be reconstructed is not reviewable, and every one of these is appealable.

### How it is stored (#33)

A versioned, append-only `StrikeRule` table, exactly like `CommissionRate` and `CancellationTier` — **not** environment variables. The requirement is that changing a threshold changes accrual *without a deploy*, and an environment variable cannot satisfy that on a host that redeploys to apply one.

Rows sharing a `versionId` are one published set; the set in force is the most recent whose `effectiveFrom` has passed. A strike issued last month can therefore still be explained by the rules that were in force when it was issued.

**Absence is meaningful.** A cancellation seven or more days out matches no row, and no row means no strike — §2's first line, expressed as data rather than as a special case in code.

**A partial set is refused, naming what is missing.** An admin editing the artist bands and submitting only those would silently switch off client misconduct entirely, and nothing would say so. The set is submitted whole, the way a tier set is. This was found by test interference behaving exactly as the production failure would: not as an error, but as a record that quietly under-reports.

**An empty table falls back to the shipped defaults**, and the admin surface reports `isDefault` so "nobody has decided yet" is distinguishable from "somebody decided this". A system that stops recording misconduct because a table is empty is worse than one that refuses to start.

Enforcement — suspension, restricted booking, removal — is §5 and #34. A strike changes nothing about an account on its own.

## 5. Enforcement ladders

**The account consequence, not the fee, is the real deterrent.** A ₦2,000 fee liability is a rounding error to a working artist; losing listing visibility is not.

### Artist ladder

```
strike accrual → suspension pending review → permanent removal on repeat
```

Suspended artists are **excluded from listings and undiscoverable** — absent from `GET /artists`, `404` on detail (`02` §4). Not greyed out, not marked unavailable: absent.

### Client ladder

```
warning → restricted booking (minimum lead time enforced) → suspension
```

The middle rung exists deliberately rather than jumping from warning to suspension. **Minimum-lead-time enforcement addresses the specific failure mode** — last-minute cancellation — without removing an otherwise usable customer. A client who cancels late twice can still book a month out, which is the behaviour we actually want from them.

Restricted clients are blocked from booking **inside their enforced minimum lead time** (`restrictedMinLeadDays` on `User`). Suspended clients are blocked from creating bookings at all, with a **clear, non-technical message explaining their standing** — not a bare `403`.

### Admin override

An admin may review, override, or expire any strike, with a **written reason recorded** and the actor named in `AuditLog`.

### How the ladders are stored (#34)

A versioned, append-only `EnforcementRule` table, like the strike weights. A rung applies at `minWeight` of **active** strike weight and above, and **the harshest matching rung wins** — a client at weight 5 matches warning, restricted and suspended, and picking the lowest would mean accruing strikes made an account safer.

The thresholds and the weights were chosen **together**, not separately. `ARTIST_CANCEL_DAY_OF` is weight 3 and artist suspension begins at 3, so a single day-of cancellation lands exactly on "strike + suspension pending review" as §2 requires. `DISPUTE_FALSE_NO_SHOW_CLAIM` is weight 3 and client restriction begins at 3, so one attempt to obtain a performance for free restricts immediately. A test asserts both, so retuning one without the other fails loudly.

**Accrual only ever escalates.** An admin who lifted a suspension has made a decision, and a later unrelated strike recomputing from weight alone would silently overturn it. Relief is an explicit act — overriding a strike — and that is the one path allowed to lower standing.

**An override deactivates, never deletes.** The strike happened, and the record of it happening and then being overturned is more useful than its absence, particularly to the next person reviewing the account. Standing is recomputed from what remains, so overturning one of two strikes leaves the other's consequence in force.

A rung may not set standing back to `GOOD`: a published ladder must not be able to silently clear an existing suspension.

Affected users are **notified of a change in standing and the reason**. A consequence someone discovers by failing to book is a support ticket; a consequence they were told about is a deterrent.

## 6. The cancellation rate

Two rules make this statistic fair rather than merely available.

### Rolling window, not lifetime

**Default 12 months, configurable.** An artist who had a bad year and then improved should not carry it indefinitely. A lifetime statistic gives no path back and stops measuring current reliability — which is the only thing a client looking at it actually wants to know.

Cancellations outside the window are excluded from the calculation entirely.

### Minimum-bookings display threshold

**Below the threshold the API returns `null` and the UI renders nothing at all.**

"100% cancellation rate" on an artist with one cancelled booking is not information, it is noise presented as a verdict.

And the below-threshold case must render **nothing** — not `0%`, not `N/A`, not `No data`:

| Rendering | Why it is wrong |
|---|---|
| `0%` | Implies a perfect record that has not been earned |
| `N/A` / `No data` | Draws attention to an absence and reads as a warning |
| *(nothing)* | ✅ An artist with two completed bookings looks neutral, because they are |

The threshold is configurable — `00` §11.7. Changing it changes display eligibility without a deploy.

### How it is computed (#35)

**The window is measured on the booking's conclusion**, and numerator and denominator share that basis. "Of the bookings that concluded in the last twelve months, what fraction did you cancel?" is a question with one answer; mixing the conclusion date with the creation date produces a figure that can exceed 100% or silently drop a recent cancellation of an older booking.

**In-flight bookings are excluded entirely.** A booking whose outcome is unknown is not evidence either way, and counting it in the denominator would let someone dilute their rate simply by making bookings.

**A booking that ended without a cancellation counts against nobody** — a dispute, an uncontradicted no-show refund. It belongs in the denominator because it happened, and in no numerator because neither party walked away.

**A reclassified cancellation counts against the artist, not the client.** That is the entire point of #29: the client cancelled because of the artist's conduct, and leaving it on the client's record would publish a statistic the platform has already ruled is wrong.

The rate is a **whole percent**. One decimal place invites a precision the sample size does not support.

Window and threshold live in a versioned `ReputationConfig` table like every other tunable decision. A threshold of zero is refused outright: it would publish a verdict on a single booking, which is the failure this section exists to prevent.

## 7. Where it is displayed

- On the artist profile, **above the booking action**, before commitment. It exists so a client can factor reliability into the decision, which requires seeing it *before* committing — not in a footer, not on a review page afterwards.
- **Mirrored**: artists see the client's equivalent statistic on an incoming request. Reliability runs both ways, and an artist deciding whether to hold a date deserves the same signal.

The API contract for the field — always present, `null` below threshold, never omitted — is established in #12 and populated in #35. See `02` §4.
