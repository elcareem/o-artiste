# EscrowPay Merchant API — the real contract

Sourced from the provider's own OpenAPI document, **not** the marketing page.

```
https://staging-business-api.escrowpay.app/openapi/public.json
```

Committed alongside this file as `escrowpay-openapi.json` — 60 paths, 70
operations, matching the "70 operations" the docs site advertises. Found by
reading the docs site's JS bundle, which builds that URL from a constant; the
spec is not served from the production host.

## Host and authentication

```
https://production-business-api.escrowpay.app/api/v1
X-API-Key: sk_test_…
```

**One host for both books.** Test versus live is decided by the key, not the
hostname. Confirmed against the live API:

```json
GET /credential-context →
{"success":true,"data":{"environment":"test","type":"secret","scopes":["*"], …}}
```

`GET /health` reports the *deploy* (`production`), never the book.
`/credential-context` is the only reliable confirmation, which is why the
provider tells you to call it first.

**Envelopes.** Success is `{success, message, data}`. Errors are either
`{"detail": {"code", "message"}}` or, for validation, FastAPI's
`{"detail": [{type, loc, msg, input}]}`. Neither matches our
`{ "error": … }` shape, so `lib/escrowpay.js` must translate rather than pass
through (`docs/02-API-CONTRACT.md` §2).

## §1 — RESOLVED: amounts are in kobo

**`amount_minor`, an integer, on every money-moving request.** Minor units of
NGN are kobo. This closes open item §11.8, and it means **no conversion layer is
needed** — our kobo integers pass straight through. The
`ESCROWPAY_AMOUNT_UNIT` flag planned in the build plan is unnecessary and will
not be built.

Confirmed by the API itself rejecting an empty body:

```json
{"detail":[{"type":"missing","loc":["body","amount_minor"],"msg":"Field required"}]}
```

## §2 — `Idempotency-Key` is a required header

On `POST /transactions`, `POST …/releases`, and `POST …/refunds`. Not optional.

This is a gift: it is exactly the guarantee `docs/03-ESCROW-FLOW.md` §3 asks for
from our self-generated `escrowReference`. A timed-out create can be retried
with the same key and the provider recognises it rather than opening a second
escrow. `Booking.escrowReference` becomes the idempotency key directly.

## §3 — The shape is transactions and milestones, not "escrows"

The marketing page advertises four calls on `/v1/escrows`. **None of those paths
exist.** The real operations:

| Operation | Path |
|---|---|
| Create escrow | `POST /transactions` |
| Read escrow | `GET /transactions/{id}` |
| **Release** | `POST /transactions/{id}/releases` |
| **Refund** | `POST /transactions/{id}/refunds` |
| Activate | `POST /transactions/{id}/activate` |
| Cancel | `POST /transactions/{id}/cancel` |
| Fees for a transaction | `GET /transactions/{id}/fees` |
| Fee estimate, pre-creation | `POST /fees/estimates` |
| Timeline | `GET /transactions/{id}/timeline` |
| Milestones | `POST`/`GET /transactions/{id}/milestones`, `PATCH`/`DELETE /milestones/{id}` |

Releases and refunds are **sub-collections**, and each carries its own
`amount_minor` — so **partial and repeated releases and refunds are supported**.
That matters for #32: a split resolution is expressible natively rather than
needing to be simulated.

Both also have `GET`, `…/cancel` and `…/retry` operations, so a failed payout
leg is recoverable without creating a new one.

### `POST /transactions`

| Field | | Notes |
|---|---|---|
| `amount_minor` | **required** | integer, kobo |
| `payer` | **required** | `{ party_id }` |
| `beneficiary` | **required** | `{ party_id }` |
| `type` | | `standard` \| `milestone` |
| `currency` | | |
| `funding_mode` | | `exact` \| `partial_allowed` |
| `external_reference` | | our booking reference |
| `automatic_release_at` | | see §5 |
| `automatic_refund_at` | | |
| `marketplace_commission_bps` | | see §6 |
| `payout_preference` | | see §7 — **default is `retain_in_wallet`** |
| `payout_account_id` | | |
| `release_policy` / `refund_policy` | | business financial-control defaults |
| `funding_deadline`, `description`, `metadata` | | |

### `POST /transactions/{id}/releases`
`amount_minor` **required**; optional `milestone_id`, `reason`.

### `POST /transactions/{id}/refunds`
`amount_minor` **required**; `source` **required** —
`escrow_held` \| `wallet_available` \| `reserve`; optional `funding_record_id`,
`reason`.

## §4 — Parties and identity are first-class, and this is #10

`POST /parties/onboard` performs identity + KYC + party creation in one call.
`POST /parties` is only for an identity already verified (`IDN_…`).

Required: `type` (**lowercase** `nin` \| `bvn`), `identifier` (min 3 chars),
`email` (rejects reserved domains like `example.test`), and `consent: true` —
consent is enforced by the provider, not merely advisory.

A failed check returns the full identity record rather than a bare error:

```json
{"detail":{"code":"identity_verification_failed",
 "message":"Identity verification did not succeed; party was not created (data_mismatch).",
 "data":{"identity":{"id":"IDN_…","type":"bvn","masked_identifier":"*******8901",
   "verification_status":"failed","verification_reason":"data_mismatch", …}}}}
```

Three things this settles for #10:

- **The provider masks the identifier itself** (`*******8901`). We store the
  `IDN_…` reference and never the raw NIN or BVN, which is what `docs/02` §6
  already requires — now enforced on both sides.
- `verification_reason` distinguishes causes, so a **retryable provider failure
  can be told apart from a genuine rejection** — #10's fourth criterion.
- `POST /identities/{id}/verification-attempts` exists, so a retry is a
  first-class operation rather than a re-onboard.

### Sandbox identities

`GET /sandbox/identity-fixtures` returns working test identities, and the rule
is mechanical:

> *"Test environment KYC uses the EscrowPay simulator only — never Prembly. Use
> the fixtures below (or any identifier following the last-digit rules)."*

**Even final digit verifies, odd fails.** `nin` `12345678902` verifies;
`12345678901` returns `data_mismatch` — which is exactly what happened while
probing. Real Prembly only runs on live keys.

This means #10 can be tested end to end, including the failure paths, without
touching a real identity.

---

# Three decisions this forces, before #17 is built

The provider offers native features that overlap our design. Each is a real
choice, not a detail.

## §5 — `automatic_release_at` overlaps #25's auto-release job

The provider can release automatically at a timestamp we set. #25 builds a
BullMQ job to do the same.

**Recommendation: keep ours, do not set theirs.** Auto-release must fire only
where a `CheckIn` exists and no dispute is open (`docs/04` §4) — conditions the
provider cannot know. Handing it a date would release on silence in cases our
rules say must not release. Their timer is unconditional; ours is not.

## §6 — `marketplace_commission_bps` overlaps our commission model

The provider can take our commission for us.

**Recommendation: do not use it.** Our commission is computed from the
**snapshot on the booking** (#7, #15), so a rate change never reaches backwards.
Provider-side commission would move that decision outside our ledger, and
`docs/01` §5's guarantee — that a booking's ledger entries sum to zero — depends
on us recording every split ourselves. Worth revisiting only if reconciliation
proves harder than expected.

## §7 — `payout_preference` defaults to `retain_in_wallet` ⚠

This is the one that touches the platform's core promise.

Left at its default, released funds **stay in our EscrowPay wallet** rather than
moving to the artist. The API has `/wallets`, `/wallets/{id}/balances` and
`/wallets/{id}/payouts` to match.

`docs/00-OVERVIEW.md` §3 states the platform never holds client money. A balance
sitting in our wallet between release and payout is arguably exactly that, and
it is a licensing question as much as an engineering one.

**Recommendation:** set `payout_account_id` explicitly on every transaction so
funds move to the artist's own payout account on release, and never rely on the
default. `POST /parties/{party_id}/payment-accounts` and `POST /payout-accounts`
exist for registering those.

**This needs confirming with EscrowPay in writing** — it belongs on #41's
open-items list beside the commercial terms.

## Still unknown

**Webhook signature verification.** The OpenAPI document contains no webhook
definitions at all — confirmed by searching it: zero occurrences of `signature`,
`escrowpay-signature` or `whsec`. The dashboard states the header is
`escrowpay-signature` and the secret is `whsec_…`, shown once at creation, but
the **algorithm and signed payload format are still undocumented to us**.

#20 cannot be built on a guess: a signature check that silently never matches
would either reject every real webhook or, if written permissively, accept
forged ones. The provider's "Webhooks guide" page covers it and needs reading.

Endpoint registration is dashboard-only — `POST /webhook-endpoints` exists in
the API but the docs say webhook CRUD is not in the public OpenAPI.
