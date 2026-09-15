# 04 — Confirmation and Disputes

Check-in codes, the two-sided confirmation matrix, auto-release, and dispute resolution authority.

---

## 1. The check-in code

### Why it exists

Client-only confirmation was rejected because it permits the highest-value fraud available against this system: receive the performance, then claim a no-show and take the refund. The code produces an **independent record that the two parties were physically together**, which converts the common dispute from competing recollections into a binary fact.

### Direction matters

The code is issued to the **client**. The artist must obtain it from them, in person, and redeem it.

That direction is the entire mechanism. A code the artist could retrieve from their own portal would prove nothing about attendance — they could redeem it from home. The artist having the code is only possible if the client handed it over, and the client is only present to hand it over at the event.

### Why not geolocation

Considered and rejected as the primary mechanism:

- GPS drifts 50–150m indoors, which is where most of these events happen.
- At a large venue, "on the property" is indistinguishable from "on stage".
- Mock-location apps make spoofing trivial on Android.

It is captured as supporting metadata where available and **never gates a redemption**. An artist in a basement venue with no GPS lock has still arrived, and turning a signal problem into a payment failure would be a worse error than the one it prevents.

### Generation rules

- **Cryptographically random.** Not sequential, not derived from the booking id, not predictable from a previously issued code.
- **Single-use.**
- **Valid only within a configurable window around the event time.**
- Delivered in-portal and by SMS ahead of the event.
- Rendered as a QR alongside the human-readable form.
- **No API path by which an artist can retrieve it** (`02` §5).

Keep the human-readable form short enough to read aloud over noise. This gets used at a live event, not in an office — a 32-character token is the wrong answer even though it is the more secure one, because the failure mode it creates is an artist who cannot check in.

### Issued at funding, sent before the event

The code is written to the booking **inside the same transaction** as the `FUNDED_HELD` transition and the funding ledger entries. A funded booking with no code is a booking nobody can complete, so that must not be a state the database can hold, not even briefly.

It is **sent** much later — `CHECKIN_CODE_SMS_LEAD_HOURS` before the event, default 24. Funding can happen months ahead, and a code received in June for a September wedding has been forwarded, screenshot and forgotten by the time it matters.

The delivery job's id is derived from the booking, so the funding webhook redelivering cannot put two messages in a client's inbox. It re-reads the booking when it fires rather than trusting its payload: a booking cancelled in the intervening weeks sends nothing.

### The validity window

| Setting | Default | Why |
|---|---|---|
| `CHECKIN_WINDOW_BEFORE_HOURS` | 2 | Artists arrive early to set up. A code that only works at the advertised start time strands them at the door |
| `CHECKIN_WINDOW_AFTER_HOURS` | 12 | Generous on purpose — an artist who forgot to check in during a five-hour set has still performed |

Outside the window the code is still **shown** to the client, with `valid: false` and the reason. Visibility is not what is gated; redemption is. A client who cannot see their code until two hours before the event has no way to check they have it.

## 2. Redemption

`POST /bookings/:id/check-in` creates a `CheckIn` with a **server-side timestamp**. No client-supplied time is accepted, and a timestamp in the request body is ignored rather than trusted.

This record is the primary evidence in every subsequent dispute, and its entire value rests on the timestamp being ours. A client-supplied time is an assertion, which would return the dispute to exactly the competing-recollection problem the code was built to eliminate.

Rejected with `409`: an incorrect code, an already-redeemed code, a code outside its validity window, and a booking not in a check-in-eligible state. Each gets a **distinct message** — "wrong code" and "already used" send the artist to different next actions, and collapsing them into "invalid code" strands someone at a venue (`39`).

On success the booking transitions to `CHECKED_IN`.

## 3. The confirmation matrix

Neither party may confirm before `eventEndAt` — `409` otherwise.

| Client | Artist | Outcome |
|---|---|---|
| Confirms | Confirms | **Release** |
| Confirms | Silent | **Release** |
| Silent | Checked in | **Auto-release** after the grace period (§4) |
| Claims no-show | No check-in | **Refund the client** |
| Claims no-show | Check-in recorded | **`DISPUTED`** |

Each row encodes a specific piece of reasoning:

**Client confirms, artist silent → release.** The artist has no incentive to withhold confirmation of their own payment. Silence here is indifference, not a signal, and requiring their active confirmation would strand payouts on nothing.

**Client silent → auto-release.** Without this, a client withholds an artist's money indefinitely by simply never responding — the exact failure the platform exists to prevent, arriving through inaction rather than bad faith.

**No-show claim, no check-in → refund.** The claim is uncontradicted. Nobody has evidence the event happened.

**No-show claim contradicted by a check-in → dispute.** This is the case the code exists to catch. It **must never auto-resolve in either direction.** One of the two parties is not telling the truth, and the system cannot determine which from the data alone.

Transitions are validated against the explicit allowed-transition map in `01` §4. An illegal transition throws.

## 4. Auto-release

A BullMQ job scheduled at funding, firing at `eventEndAt` + grace period.

| Rule | Reason |
|---|---|
| Grace period read from configuration, **never hardcoded** | Open item `00` §11.5 — the right value needs real data. Default 48–72h |
| Fires **only where a `CheckIn` exists** | No check-in and no client response means nobody has evidence the event happened. Releasing on silence there pays out for a performance that may never have occurred |
| Suppressed while a dispute is open | §5 |
| **Idempotent** — a duplicate run releases once | A job runner retrying after partial failure must not double-release |
| Cancelled when the booking reaches a terminal state earlier | |
| The deadline is **disclosed** to the client in the post-event prompt | The client is being told that silence has a consequence. That only works if they know when |

## 5. Disputes

### State machine

```
OPEN ──► UNDER_REVIEW ──┬──► RESOLVED_RELEASE
                        ├──► RESOLVED_REFUND
                        └──► RESOLVED_SPLIT
```

### Rules

- Opened **automatically** on a no-show claim contradicted by a check-in record.
- Either party may also open one manually.
- Both parties may submit written statements and files.
- **Funds remain held for the duration. There is no automatic resolution in either direction.**
- **The auto-release job is cancelled on dispute open.** Without that, a dispute raised near the grace boundary could be overtaken by an automatic release while under review — money gone, mid-review.
- The check-in record is attached automatically where one exists.
- A dispute cannot reach a resolved state without an admin action.

There is deliberately **no auto-resolve timer.** Any default outcome is gameable: whichever party it favours simply waits.

## 6. Resolution authority

**Dispute authority sits with us, not the provider.** EscrowPay does not arbitrate on the API product; funds stay held until we instruct otherwise. That is the correct arrangement — we know the users, the categories, and the market.

- The admin issues **release, refund, or split**, with a **mandatory written reason**.
- Resolution executes via `escrowService.js` only (`03` §5).
- The record names the deciding admin and feeds strike accrual (`06`).
- The check-in record is surfaced **above the fold**, not buried among attachments. Most disputes should be cheap to resolve because that single record reduces the common case to a binary fact; burying it makes every dispute expensive.

### The external mediator field

Optional, and **informational only. Nothing executes from it.**

Where a dispute turns on quality or duration rather than attendance — *"he arrived but left after twenty minutes"* — an outside opinion may be worth having. But the verdict returns to us and **we** issue the instruction. The field records that an opinion was sought and what it said; it is not an input to any automated path.
