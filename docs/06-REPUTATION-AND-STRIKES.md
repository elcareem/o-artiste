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

## 7. Where it is displayed

- On the artist profile, **above the booking action**, before commitment. It exists so a client can factor reliability into the decision, which requires seeing it *before* committing — not in a footer, not on a review page afterwards.
- **Mirrored**: artists see the client's equivalent statistic on an incoming request. Reliability runs both ways, and an artist deciding whether to hold a date deserves the same signal.

The API contract for the field — always present, `null` below threshold, never omitted — is established in #12 and populated in #35. See `02` §4.
