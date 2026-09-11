# Contributing to artist-escrow

This system holds other people's money. A few conventions keep that defensible as
more people contribute.

## Spec first

`docs/` is the source of truth, not the code. Read the relevant specification
before writing anything — `docs/00-OVERVIEW.md` through `docs/08-BUILD-PLAN.md`,
in order.

If the spec is wrong, change the spec. Open a `[SPEC]` issue using the template
rather than writing code that contradicts it and fixing the document afterwards.

## Branch naming

Format: `<type>/<issue-number>-<short-description>`

```
chore/1-repo-scaffold
feat/9-auth-roles-middleware
feat/20-webhook-idempotency
fix/27-cancellation-refund-floor
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`.

Never commit directly to `main` — it's protected and requires a PR.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), no emojis:

```
feat(backend): add versioned commission rate resolver
fix(backend): floor cancellation refund at zero
chore(web): pin next to 16.3.3
docs(spec): correct fee curve claim in 05
```

Scope should match the workspace you touched: `backend`, `web`, `spec` for
`docs/` changes, or omit it for repo-wide changes.

The body matters more here than in most repos. State:

- what was built
- which acceptance criteria were verified, and how
- anything deferred or blocked, and why
- any file added outside the issue's stated scope

End with `Closes #N`.

## Before opening a PR

Run these from the repo root — they mirror what CI runs, so if they pass
locally, CI should pass too:

```bash
npm run lint --workspaces --if-present
npm run build --workspaces --if-present
npm run test --workspaces --if-present
npm run check:rules
```

`check:rules` is not advisory. Every rule in it corresponds to an acceptance
criterion and to a line in the pre-launch review. If it fails, the change is
wrong — don't weaken the check to make it pass.

Also make sure:

- You've tested the change locally (both apps running, if relevant)
- Every acceptance box on the issue is exercised by a real command, with the
  output recorded in `docs/ACCEPTANCE-LOG.md`. A box ticked by inspection is
  not ticked.
- A box that depends on a third-party account you don't have is recorded as
  **blocked**, not ticked.
- No unrelated changes — formatting-only diffs on files you didn't otherwise
  touch, stray `console.log`s, commented-out code.
- No secrets. `.env.example` lists every variable the app reads, with no real
  values.
- If you changed the schema, both a fresh `prisma migrate` and the existing
  seed still succeed.

## Opening a PR

- Use the PR template — fill in the checklist honestly, don't just tick boxes
- Link the issue it closes (`Closes #12`)
- Tag at least one reviewer

## Merging

Every change reaches `main` through a pull request. **`main` takes no direct
commits** — that's the rule the branch protection enforces, and it's the one
that matters: each issue arrives as a reviewable, revertable unit linked to the
issue it closes.

While this is a single-maintainer project, **required approvals are set to 0**,
so the author can merge their own PR once checks pass. That is a deliberate
setting, not an oversight: GitHub does not let an author approve their own pull
request, so requiring one approval would block every merge.

Raise it to 1 as soon as there is a second collaborator. Approval from **any**
collaborator is sufficient — reviews aren't limited to a single gatekeeper.

## The rules that do not bend

These are specified in `docs/` and enforced by `npm run check:rules`. They are
not style preferences, and a PR that breaks one does not get merged with a
follow-up promised.

1. **Money is integer kobo.** No `Float`, no `Decimal`, anywhere — not on money,
   not on rates, not "just for this one field." Naira exists only inside
   `formatNaira(kobo)` at display time. Percentages are basis-point integers.
2. **The platform never holds funds.** No code path routes client money into a
   platform-controlled account.
3. **Only `escrowService.js` moves money.** No route handler, job, or other
   service may instruct a release or refund.
4. **The ledger is append-only.** No update, no delete, anywhere. Corrections
   are new offsetting entries, written inside the same transaction as the state
   change they accompany.
5. **Webhooks are signature-verified against the raw body, and idempotent.** The
   event id is recorded *before* processing. This is the highest-severity path
   in the system.
6. **Bank transfer only.** No card path — chargebacks and escrow are
   incompatible.
7. **Payout and cancellation math reads the booking's snapshot**, never live
   configuration.

Rounding has a documented rule (`docs/05-CANCELLATIONS-AND-FEES.md` §4).
Remainders are assigned to a named party and never dropped. If you find yourself
reaching for `Math.round`, `toFixed`, or float division on money, stop.

## Project structure conventions

Inside `apps/backend`, keep the layering intentional:

- **`routes/`** — thin handlers only: parse the request, call a service, return a
  response. No business logic, no direct provider calls, no Prisma queries that
  encode a rule.
- **`services/`** — where the logic lives. `escrowService.js` is the only module
  permitted to move money; `feeService.js` is pure, with no database, network or
  clock.
- **`lib/`** — integration clients and shared singletons. `escrowpay.js` is a
  transport only: no business logic, no ledger writes, no state transitions.
- **`jobs/`** — scheduled and deferred workers.

Error responses are always `{ "error": "Human readable message" }`. Throw
`AppError` from `lib/errors.js` rather than building a response by hand — that's
how shape drift starts. The frontend renders the `error` string directly and
unaltered, so the backend owns the wording.

If you're adding a new file or folder that isn't already scoped in the issue
you're working from, mention it in the commit body and the PR description so
reviewers know it was an intentional addition, not scope creep.
