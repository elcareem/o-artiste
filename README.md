# Artist Escrow

Artist booking platform with escrow-held funds.

A client books an artist and pays upfront. The money is custodied by a CBN-licensed
bank and released only when both sides confirm the event took place. If the artist
does not appear, the client is refunded. **The platform never holds client funds.**

## Structure

```
apps/backend/    Express + Prisma REST API (CommonJS, Node 20+)
apps/web/        Next.js App Router client (TypeScript, Tailwind v4)
docs/            Authoritative specification, 00 through 08
scripts/         Rule enforcement
```

## Specification

`docs/` is the source of truth. Read it in order before writing code.

| Doc | Covers |
|---|---|
| [00-OVERVIEW](docs/00-OVERVIEW.md) | Business context, custody decision, fee-bearer rules, **open items** |
| [01-DATA-MODEL](docs/01-DATA-MODEL.md) | Models, kobo precision, booking state machine, ledger design |
| [02-API-CONTRACT](docs/02-API-CONTRACT.md) | Endpoints, payloads, the unified error shape |
| [03-ESCROW-FLOW](docs/03-ESCROW-FLOW.md) | Fund lifecycle, webhook verification, idempotency |
| [04-CONFIRMATION-AND-DISPUTES](docs/04-CONFIRMATION-AND-DISPUTES.md) | Check-in codes, confirmation matrix, auto-release, disputes |
| [05-CANCELLATIONS-AND-FEES](docs/05-CANCELLATIONS-AND-FEES.md) | Fee schedule, rounding rule, tier table, disclosure |
| [06-REPUTATION-AND-STRIKES](docs/06-REPUTATION-AND-STRIKES.md) | Strike triggers, enforcement ladders, cancellation rate |
| [07-ADMIN-CONFIG](docs/07-ADMIN-CONFIG.md) | Permission tiers, versioned config, snapshots, audit |
| [08-BUILD-PLAN](docs/08-BUILD-PLAN.md) | Implementation order and phase gates |

## The rules that do not bend

1. **Money is integer kobo.** No `Float`, no `Decimal`, anywhere. Naira exists only in `formatNaira(kobo)` at display time.
2. **The platform never holds funds.** No code path routes client money into a platform account.
3. **Only `escrowService.js` moves money.** No route handler, job, or other service instructs a release or refund.
4. **The ledger is append-only.** Corrections are new offsetting entries, written in the same transaction as the state change.
5. **Webhooks are signature-verified and idempotent.** The event id is recorded before processing.
6. **Bank transfer only.** No card path — chargebacks and escrow are incompatible.
7. **Payout math reads the booking's snapshot**, never live configuration.

`npm run check:rules` enforces these mechanically. It is not advisory.

## Development

```bash
npm install          # from the repository root
npm run dev:backend  # port 4000
npm run dev:web      # port 3000
npm run test:backend
npm run lint
npm run check:rules
```

Requires Node 20+, PostgreSQL, and Redis. External service setup is tracked in
`DEPLOYMENT-CHECKLIST.md`.

## Contributing

Issue templates are in [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/).
Work is spec-first: the relevant `docs/` section is read before code is written,
and each step is independently verifiable before the next begins.
