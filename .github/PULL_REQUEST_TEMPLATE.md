## What this does

Brief description of the change.

Closes #

## Acceptance criteria

Copy the acceptance criteria from the issue and state how each was verified —
the command run and what it returned. Evidence goes in
`docs/ACCEPTANCE-LOG.md`.

- [ ] Criterion 1 — verified by `...`
- [ ] Criterion 2 — verified by `...`

Anything **deferred** to a later issue or **blocked** on something external:
say which, and on what. Don't tick a box that isn't done.

## Checks

Run from the repo root:

- [ ] `npm run lint --workspaces --if-present`
- [ ] `npm run build --workspaces --if-present`
- [ ] `npm run test --workspaces --if-present`
- [ ] `npm run check:rules`
- [ ] Tested locally (both apps running, if relevant)

## Money and safety

Tick only what applies to this change — but tick honestly, these are the rules
that don't bend (`CONTRIBUTING.md`, `docs/`).

- [ ] All monetary values are `Int` kobo — no `Float`, no `Decimal`, no
      `Math.round`/`toFixed`/float division on money
- [ ] Every money movement writes a `LedgerEntry` in the **same transaction**
      as its state change
- [ ] No ledger update or delete path added
- [ ] Money moves only through `escrowService.js`
- [ ] Payout and cancellation math reads the booking's **snapshot**, not live
      config
- [ ] Any new webhook path is signature-verified against the raw body and
      idempotent
- [ ] No card payment path
- [ ] N/A — this change touches none of the above

## Scope

- [ ] No files added outside the scope of the linked issue

If any were, list them here with why, so reviewers can see they were an
intentional addition rather than scope creep.
