# 02 — API Contract

Endpoint definitions, payload shapes, and the unified error convention.

Base URL is `NEXT_PUBLIC_API_URL` on the frontend; the server listens on port 4000.

---

## 1. Conventions

- JSON in, JSON out. `Content-Type: application/json` everywhere **except** `/webhooks/*`, which receives the raw body untouched (`03` §6).
- **All monetary values in every request and response are kobo integers.** No endpoint accepts or returns a formatted currency string, and nothing in the backend converts to Naira. Display conversion happens only in `formatNaira(kobo)` in the web app.
- Authentication is `Authorization: Bearer <jwt>`.
- Timestamps are ISO 8601 UTC.
- List endpoints are paginated as `{ "data": [...], "page": 1, "pageSize": 20, "total": 57 }`.

## 2. Error shape

Every error response, without exception:

```json
{ "error": "Human readable message" }
```

No error code field, no nested detail object, no stack trace, no array of validation objects. One string, written for a person.

| Status | Used for |
|---|---|
| `400` | Validation failure — malformed input, a rate outside the permitted range, a past event date |
| `401` | Missing, malformed, or expired token; invalid webhook signature |
| `403` | Authenticated but not permitted — wrong role, unverified, suspended, editing another user's resource |
| `404` | Not found, **or** deliberately hidden (a suspended artist returns 404, not 403) |
| `409` | State conflict — confirming before event end, redeeming a used code, funding without acknowledgement |
| `500` | Unexpected. The message is generic; the detail goes to logs, never to the client |

The message is the user-facing copy. The frontend renders `error` **directly and unaltered** — it does not map, rewrite, or prefix it. That means the backend owns the wording, so every message must name what went wrong and, where possible, what to do about it:

> ✅ `"Artist rates must be between ₦20,000 and ₦3,000,000."`
> ✅ `"This check-in code has already been used."`
> ✅ `"Verify your identity before creating a booking."`
> ❌ `"Validation failed"` · ❌ `"Error 4012"` · ❌ `"Bad request"`

A `403` from an unverified user must direct them to verification, not merely refuse (#10).

Implementation: `lib/errors.js` exports `AppError(status, message)`. Route handlers throw it; one terminal middleware serialises it. No handler builds an error response by hand — that is how shape drift starts.

## 3. Auth — `routes/auth.js`

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/auth/register` | — | `role` accepts **only** `CLIENT` or `ARTIST`, whitelisted server-side |
| `POST` | `/auth/login` | — | Returns JWT with expiry |
| `GET` | `/me` | any | Profile plus `verificationStatus` and `accountStanding` |

**There is no public route by which an account can self-assign `ADMIN` or `SUPER_ADMIN`.** Those accounts are seeded or created manually. Passing `"role": "SUPER_ADMIN"` to `/auth/register` is rejected, not ignored — silently downgrading hides an attempt worth seeing.

## 4. Artists — `routes/artists.js`

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/artists` | public | Paginated; filter by `category`, `location` |
| `GET` | `/artists/:id` | public | Full profile, rate card, `cancellationRate` |
| `POST` | `/artists` | `ARTIST` | Create own profile |
| `PATCH` | `/artists/:id` | `ARTIST` (owner) | Another artist's id → `403` |

`baseRateKobo` is validated against **₦20,000 – ₦3,000,000** (2,000,000 – 300,000,000 kobo). Outside that range returns `400` with a message naming the limit. The bound is the provider's transaction range, not product policy — a booking outside it cannot be funded at all, so the artist finds out when setting their rate rather than the client at the point of payment.

`cancellationRate` is **always present in the response shape** and is `null` when the display threshold is not met — never omitted, never `0`. The field exists from #12 and is populated in #35; a `null` contract established early forces the frontend to handle the below-threshold case properly instead of bolting it on later (`06` §4).

Suspended, unverified, and incomplete-profile artists are excluded **at the query level**, not filtered client-side. A suspended artist appearing in a listing even briefly is a trust failure. Detail returns `404`.

## 5. Bookings — `routes/bookings.js`

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/bookings` | `CLIENT`, verified | Snapshots config; state `PENDING_PAYMENT` |
| `GET` | `/bookings/:id` | party or admin | Polled by the status page |
| `GET` | `/bookings` | any | Caller's own bookings |
| `POST` | `/bookings/:id/acknowledge-terms` | `CLIENT` (owner) | Must precede funding |
| `POST` | `/bookings/:id/fund` | `CLIENT` (owner) | `409` without an acknowledgement |
| `GET` | `/bookings/:id/check-in-code` | `CLIENT` (owner) | The code, its QR, and whether it is redeemable yet |
| `POST` | `/bookings/:id/check-in` | `ARTIST` | Redeems the client's code |
| `POST` | `/bookings/:id/confirm` | `CLIENT` or `ARTIST` | `409` before `eventEndAt` |
| `POST` | `/bookings/:id/claim-no-show` | `CLIENT` | Refund or dispute, per `04` §2 |

`POST /bookings` rejects: unverified or suspended clients (`403`), bookings against unverified or suspended artists (`403`), event dates in the past (`400`), and clients whose standing is `RESTRICTED` booking inside their enforced lead time (`403`).

### Check-in code visibility

The code is returned to the **client only**. No response body on any endpoint, for any role, ever includes `checkInCode` for an artist token — this is asserted by test in #22. Serialisation is role-aware at the boundary rather than relying on each handler to remember.

`GET /bookings/:id/check-in-code` is the **only** endpoint in the system that returns it, and it is the one place the field is read. Two independent guards hold that line, because one is not enough for the mechanism the whole escrow rests on:

- A test sweeps **every route the booking router registers** with an artist token and fails if the code's value, or the field name, appears in any byte of any response. A route added later is covered without anyone remembering to add it to a list.
- `npm run check:rules` fails if `checkInCode` is named anywhere in `apps/backend/src` outside `checkInService.ts`, `checkInCodeJob.ts` and `types.d.ts`, or **anywhere at all** in `apps/web/src`. That catches what the sweep cannot: a module not yet mounted on that router.

The response is `{ "checkIn": { code, qrDataUrl, validFrom, validTo, valid, reason, message } }`. `code` is hyphenated for reading aloud (`K7QX-M2F9`); `qrDataUrl` is a PNG data URL rendered server-side, so the code never reaches a third-party QR service.

`valid` is `false` outside the window, with `reason` one of `too_early`, `expired` or `already_redeemed` — but **the code is still returned**. Visibility is not what is gated; redemption is. A client who cannot see their code until two hours before the event has no way to check they have it.

Before funding the endpoint returns `409`, not an empty code: the client is told the code appears once payment is received.

A caller who is not this booking's client gets `404`, never `403`. A `403` confirms the booking exists, and "this booking has a code you may not see" is worth nothing to a stranger and something to an artist probing for one.

### Redemption — `POST /bookings/:id/check-in`

`ARTIST` only, and only this booking's artist; anyone else gets `404`. A client calling it gets `403`: a client who could redeem their own code could manufacture attendance for an event nobody played.

Body: `{ code, latitude?, longitude?, accuracyMeters? }`. **There is no time field, and adding one to the body changes nothing** — `redeem()` has no parameter for a time and `CheckIn.redeemedAt` is a database default, so there is nowhere for a supplied value to go. `check:rules` fails if any service, library or job so much as names the column.

Geolocation is **supporting metadata and never a gating condition**. A reading that is absent, refused, unparseable or out of range is dropped and the check-in proceeds. A latitude without a longitude is dropped as a pair — half a position reads as a location in a dispute record and is not one.

Response `201`: `{ checkIn: { bookingId, redeemedAt, hasLocation }, booking }`. The coordinates themselves are not echoed back; they exist for dispute review, not for the caller.

Rejections are all `409`, each with **its own message**, because "wrong code" and "already used" send an artist standing at a venue to different next actions:

| Case | Message shape |
|---|---|
| Wrong code | "That code is not right. Check it with the client…" |
| Already redeemed | "This check-in code has already been used." |
| Before the window | "This code becomes active shortly before your event starts." |
| After the window | "This code has expired." |
| Ineligible state | Phrased for the state — "This booking has not been paid for yet…", "This booking was cancelled." |

A raw state name never reaches the artist. `PENDING_PAYMENT` tells them nothing they can act on; "the client has not paid yet" tells them who to talk to.

A missing `code` is `400`, not `409` — nothing about the booking is in conflict, the request is incomplete.

### Confirmation — `POST /bookings/:id/confirm` and `POST /bookings/:id/claim-no-show`

`confirm` is open to **both** parties; the caller's part in the booking is resolved server-side from the token, and there is no role field in the body to disagree with it. `claim-no-show` is `CLIENT` only — an artist reporting their own absence is a cancellation (#28), not a claim about someone else's conduct. A stranger gets `404` from both.

Both return `{ confirmation: { outcome, reason, state, actedBy, … } }`, where `outcome` is one of:

| Outcome | Meaning |
|---|---|
| `release` | Paid out. Carries a `release` summary |
| `refund` | Client made whole. Carries a `refund` summary |
| `dispute` | Opened and **not decided**. Carries `disputeId` |
| `awaiting_auto_release` | A check-in exists; #25's job will release after the grace period |
| `awaiting_response` | No check-in and no client response — **nothing will happen on its own** |

The last two are separated deliberately. Both are "nothing now", but only the first has anything that will ever happen without a person, because #25 fires only where a check-in exists.

`409` before `eventEndAt` — not `eventDate`. A confirmation taken mid-performance confirms something that has not happened yet, and it is the artist who would be asking for it.

`409` on a booking that has already concluded, with a message naming the conclusion rather than the state (`"This booking has already been paid out."`). A client who has confirmed cannot then claim a no-show, and vice versa: the second statement is refused rather than stored, so a booking never carries a contradiction.

Confirming twice is idempotent and **keeps the first timestamp**. When a party responded is evidence; a double tap must not rewrite it.

## 6. Verification

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/verification` | any authenticated | Body: `{ "method": "NIN" \| "BVN", "identifier": "..." }` |
| `GET` | `/verification` | any authenticated | Current status |

The `identifier` is passed to the provider and **never persisted**. Only the result and the provider's reference are stored (`01` §3, NDPR).

An already-`VERIFIED` user calling `POST /verification` makes **no provider call** and is not charged again — verification is once per person for life, not per transaction.

A provider timeout sets `RETRYABLE_FAILURE`, not `REJECTED`, and the response says so. Collapsing the two would lock a legitimate user out permanently over a network blip.

## 7. Cancellations — `routes/cancellations.js`

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/bookings/:id/cancellation-preview` | party | **Exact** figures, before committing |
| `POST` | `/bookings/:id/cancel` | `CLIENT` or `ARTIST` | Behaviour differs by caller role |

The preview returns the applicable tier, the exact refund, the exact artist compensation, and the exact fees — including a `₦0` refund where fees exceed it. **A cancellation cannot be committed without the client having been served these figures**; discovering a deduction afterwards is the precise scenario `00` §10 exists to prevent.

## 8. Disputes — `routes/disputes.js`

| Method | Path | Auth |
|---|---|---|
| `POST` | `/bookings/:id/disputes` | party |
| `POST` | `/disputes/:id/evidence` | party |
| `GET` | `/disputes/:id` | party or admin |

## 9. Admin — `routes/admin.js`

| Method | Path | Auth |
|---|---|---|
| `GET` | `/admin/bookings` | `ADMIN` |
| `GET` | `/admin/bookings/:id` | `ADMIN` |
| `POST` | `/admin/bookings/:id/release` | `ADMIN` — written reason mandatory |
| `POST` | `/admin/bookings/:id/refund` | `ADMIN` — written reason mandatory |
| `GET` | `/admin/disputes` | `ADMIN` |
| `POST` | `/admin/disputes/:id/resolve` | `ADMIN` — written reason mandatory |
| `POST` | `/admin/cancellations/:id/reclassify` | `ADMIN` — written reason mandatory |
| `POST` | `/admin/queue/echo` | `ADMIN` | Schedules the do-nothing job; `delayMs` defaults to 10,000 |
| `GET` | `/admin/queue/echo/:id` | `ADMIN` | Whether it ran, and when |
| `GET` | `/admin/queue/dead-letter` | `ADMIN` | Jobs that exhausted every retry |
| `GET` | `/admin/diagnostics` | `ADMIN` | Whether the dependencies actually answer. `503` when one does not |

### Health versus diagnostics

`GET /health` is **public** and reports that the process is alive **and which build is answering** — `{ status, version, commit, startedAt, uptimeSeconds }`. The commit is what makes a deploy verifiable from outside; without it, "did that merge ship?" is answered by poking at routes and inferring.

It deliberately reports nothing about dependencies. `GET /admin/diagnostics` does, and is `ADMIN`-only, because "the database is not answering" tells an attacker when to try something. Which build is running does not — it is an opaque hash against a private repository.

This split exists because a bare `ok` is what let two multi-day failures go unnoticed: `JWT_SECRET` unset, so no login could ever succeed, and the provider credentials never set at all. `/health` answered `ok` throughout both.

The database check is a **count through the generated client**, not `select 1`. A pool can hold an open socket to a database that has stopped answering, and `select 1` succeeds against a schema missing every column the code needs — so the check fails exactly when the deployed schema has drifted from the deployed code.

The queue check reports **how many workers are attached**. A queue with no consumer accepts jobs and runs none of them, which looks healthy from every angle except the one that matters.

**Configuration is reported as present or absent, never by value.** An endpoint that echoes a signing key to whoever holds an admin token has replaced one problem with a worse one. `JWT_SECRET` shows its length, because length is the defence; `ESCROWPAY_API_KEY` shows its prefix only, because `sk_test_` versus `sk_live_` decides which book the money moves in.

### Queue diagnostics

`echoJob` exists so that "is the queue running at all?" has an answer depending on nothing else. On a developer's machine that answer is a log line; on a deployed host it was a log line nobody could reach — which left two of #5's acceptance criteria unverifiable and would make the first question in any auto-release incident unanswerable.

`ranAt` is generated **inside the worker process** and returned by the job. A `completed` state proves the queue finished the job; a timestamp from the processor proves a worker executed it, which is the question actually being asked on a deployed host.

These are deliberately narrow. **There is no endpoint that enqueues an arbitrary job onto an arbitrary queue** — that would be a remote code path into the worker. The only job they can schedule is the one that logs and exits, and a `queue`, `name` or `data` field in the body is asserted by test to be inert rather than merely undocumented.

`delayMs` is capped at one hour, so nothing can be parked in the queue indefinitely. Unspecified — absent, `null`, or an empty string — means the default, **not zero**: JSON carries neither `NaN` nor `Infinity`, so a client whose own delay calculation failed sends `null`, and reading that as "run now" would turn a broken input into a silently different schedule.
| `GET` | `/admin/users/:id/strikes` | `ADMIN` |
| `POST` | `/admin/strikes/:id/override` | `ADMIN` — written reason mandatory |
| `PUT` | `/admin/config/commission` | **`SUPER_ADMIN`** |
| `PUT` | `/admin/config/cancellation-tiers` | **`SUPER_ADMIN`** |
| `GET` | `/admin/config/history` | `ADMIN` |

**Every money movement and every configuration change requires a written reason**, rejected with `400` if absent. A money movement without a recorded justification is indefensible later.

The two `SUPER_ADMIN` endpoints are permission-checked **at the endpoint, server-side**. Hiding a field in the UI is not a permission check — #36 asserts that an invalid or unauthorised request submitted directly to the API is rejected even though the UI prevented it.

## 10. Webhooks — `routes/webhooks.js`

`POST /webhooks/escrowpay` — fully specified in `03` §6. Two properties matter more than the rest: the signature is verified against the **raw bytes**, and the event id is recorded **before** any processing begins.

## 11. Health

`GET /health` → `200 {"status":"ok"}`. No auth, no database dependency — it must answer while the database is down, or it cannot distinguish a dead process from a dead dependency.
