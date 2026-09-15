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
