# Acceptance Log

Evidence that each issue's acceptance criteria were genuinely met.

One entry per issue. Every box records the **command that was run and its
output** — a box ticked by inspection is not ticked. A box that depends on a
third-party account or service unavailable at the time is recorded as
**BLOCKED**, naming what it is blocked on, and is never marked complete on the
basis that the code "should" work.

This log is what `#41` means by *"each code rule verified and evidenced."*

Legend: `[x]` verified · `[~]` deferred to a later issue · `[!]` blocked

---

## #1 — chore: scaffold monorepo

Branch `chore/1-repo-scaffold`. Verified 2026-09-11 on Node v22.23.2, npm 10.9.8.

### `[x]` `npm install` from repo root resolves both workspaces without errors

```
$ npm install
up to date, audited 5 packages in 2s
found 0 vulnerabilities
exit=0
```

### `[x]` `npm ls --workspaces --depth=0` shows backend and web with no `ELSPROBLEMS`

```
$ npm ls --workspaces --depth=0
artist-escrow@0.1.0 /home/elcareem/Documents/o-artiste
├── @artist-escrow/backend@0.1.0 -> ./apps/backend
└── @artist-escrow/web@0.1.0 -> ./apps/web

exit=0
```

Exit code 0 and no `ELSPROBLEMS` in the output. Both workspaces resolve as
symlinks, which is what a correctly linked npm workspace looks like.

### `[x]` `docs/00-OVERVIEW.md` through `docs/08-BUILD-PLAN.md` are present

```
$ ls -1 docs/*.md
00-OVERVIEW.md
01-DATA-MODEL.md
02-API-CONTRACT.md
03-ESCROW-FLOW.md
04-CONFIRMATION-AND-DISPUTES.md
05-CANCELLATIONS-AND-FEES.md
06-REPUTATION-AND-STRIKES.md
07-ADMIN-CONFIG.md
08-BUILD-PLAN.md
```

All nine present and authored — not placeholders. They are the authoritative
specification every later issue is written against.

### `[x]` `.github/ISSUE_TEMPLATE/` contains all three templates

```
$ ls -1 .github/ISSUE_TEMPLATE/
bug_report.md
feature_task.md
spec_update.md
```

### `[x]` `npm run check:rules` passes

```
$ npm run check:rules
Rule checks — docs/ non-negotiables

  SKIP  No Float or Decimal in the Prisma schema (apps/backend/prisma/schema.prisma not present yet)
  SKIP  No ledger update or delete path (apps/backend/src not present yet)
  SKIP  escrowService.js is the sole caller of release/refund (apps/backend/src not present yet)
  SKIP  No card payment path (apps/backend/src not present yet)
  SKIP  Frontend makes no direct provider calls (apps/web/src not present yet)
  SKIP  No raw stack traces rendered in the web app (apps/web/src not present yet)

passed 0   failed 0   skipped 6
exit=0
```

Six SKIPs, zero failures. The script deliberately reports **SKIP rather than
PASS** for a rule whose target does not exist yet — a check that passes because
there is nothing to check would be a false guarantee, and these rules are the
ones #41 relies on. Each converts to PASS as the issue that introduces its
target lands.

### `[x]` Repo pushed with a clean `git status` — no `node_modules`, `.env`, or build artifacts tracked

Local portion verified — see the git status output recorded at commit time.
`node_modules/`, `.env`, `.env.local`, `.next/`, `dist/`, `*.log` are all
gitignored. The *push* half of this criterion is covered by the blocked item
below.

### `[!]` Branch protection is active on `main`: PRs required, 1 approval, no code-owner restriction

**BLOCKED — no GitHub repository yet, and `gh` is not installed on this machine.**

```
$ gh --version
gh not installed
```

Needs either `sudo apt install gh && gh auth login`, so protection can be applied
via `gh api`, or the repository created manually with the remote supplied.
Tracked in `DEPLOYMENT-CHECKLIST.md` § #1.

**Deliberate deviation — required approvals set to 0, not 1.** #1 asks for 1
approval. GitHub does not permit a PR author to approve their own pull request,
so on a single-maintainer project that setting blocks every merge outright.

The criterion's *intent* — no unreviewed change reaching `main`, every change
arriving as a reviewable unit linked to its issue — is preserved in full by the
other three rules: a PR is required, direct pushes to `main` are refused, and
stale approvals are dismissed on new commits. Only the approval **count**
differs, and it is raised to 1 the moment a second collaborator exists.

Recorded here rather than silently applied, and documented in `CONTRIBUTING.md`
§ Merging so the setting doesn't later read as an oversight.

### Deviations from the issue as written

Both are deliberate and were agreed, not silent:

1. **`PROJECT_GUIDE.md` and `ISSUES-PART-1`–`4` are gitignored.** #1's required
   layout places `PROJECT_GUIDE.md` in the committed repository; the maintainer
   asked for it and the issue backlog to stay local instead. They remain on disk
   as reference. Consequence: `docs/` is now the only specification inside the
   repository, which raises rather than lowers the bar those nine documents have
   to meet.

2. **Two files added outside the issue's stated scope:**
   - `README.md` — gitignoring `PROJECT_GUIDE.md` left the repository with no
     entry point at all.
   - `CONTRIBUTING.md` — adapted from the maintainer's existing house style,
     carrying the branch, commit and review conventions plus this project's
     layering and money rules.

### Spec corrections made while authoring `docs/`

Recorded here because they change what later issues must test:

- **#14's "non-monotonic fee curve around ₦250,000" is incorrect.** ₦2,000 is
  exactly 0.8% of ₦250,000, so the fee schedule is *continuous* at that
  boundary — ₦250,000 costs ₦2,000 and ₦260,000 costs ₦2,080, an increase. The
  genuinely non-monotonic thing is the effective rate across the whole range.
  The tests #14 asks for are still worth having; only the stated reason was
  wrong. Documented in `docs/05-CANCELLATIONS-AND-FEES.md` §1.

- **The ₦2,000 cap first binds around ₦126,667**, not ₦250,000 — that is where
  `1.5% + ₦100` exceeds ₦2,000. #14's listed boundaries would test only the
  capped and uncapped regions and miss the percentage region entirely.
  Documented in `docs/05-CANCELLATIONS-AND-FEES.md` §2.

- **`DisputeEvidence` added to the data model**, which #4's model list does not
  name. #31 requires both parties to attach evidence to one dispute, and a JSON
  blob would make "who submitted what, when" unqueryable — the exact question a
  dispute review asks. Flagged in `docs/01-DATA-MODEL.md` §3.

### Dependency corrections applied to the build order

Documented in full in `docs/08-BUILD-PLAN.md` §2. The issue numbering is not a
valid build order:

- **#9 before #7 and #8** — both config endpoints are `SUPER_ADMIN`-restricted
  and cannot close without role middleware.
- **#17 pulled into Phase 1, before #10** — verification is reached *through*
  EscrowPay.
- **#26 before #24 and #25** — both consume release execution.
- **#33 pulled into Phase 3, before #28** — #33 and #28 list each other as
  dependencies. Resolved by separating the accrual engine from its triggers.

---

## #2 — chore(backend): bootstrap Express server and deploy

Branch `chore/2-backend-bootstrap`. Verified 2026-09-11 on Node v22.23.2.

### `[x]` `curl localhost:4000/health` returns 200 with `{"status":"ok"}`

```
$ curl -sS -i http://localhost:4000/health
HTTP/1.1 200 OK
Access-Control-Allow-Origin: http://localhost:3000
Vary: Origin
Access-Control-Allow-Credentials: true
Content-Type: application/json; charset=utf-8
Content-Length: 15

{"status":"ok"}
```

CORS headers reflect `WEB_ORIGIN`. The route has no database or Redis
dependency, so it still answers while a dependency is down — otherwise it
cannot distinguish a dead process from a dead dependency
(`docs/02-API-CONTRACT.md` §11).

### `[x]` A `/webhooks/*` path exposes the raw body to the handler

```
$ node --test "test/bodyParsers.test.js"
#   raw body isBuffer: true
#   raw body bytes   : 71
#   raw body verbatim: "{\"event\":\"escrow.funded\",  \"escrow_id\":\"esc_9f2b\",   \"amount\":14500000}"
ok 1 - a /webhooks/* path receives the raw body as a Buffer
ok 2 - a non-webhook path still receives parsed JSON
ok 3 - a path merely beginning with the prefix is not treated as a webhook
ok 4 - isWebhookPath boundaries
# pass 4  # fail 0
```

The payload was written with deliberately irregular key spacing that
`JSON.stringify` would not reproduce. It came back **byte-for-byte identical**,
which is the property that actually matters: it proves nothing parsed and
re-serialised the body on the way through. That is what makes #20's signature
verification possible at all.

`/webhooksomething` is correctly *not* treated as a webhook path — the prefix
match is `/webhooks` exactly, or `/webhooks/` followed by anything.

**Deviation, and an improvement on the plan.** This was to be evidenced by a
temporary `POST /webhooks/_rawbody-probe` route. It is evidenced by a test on
the real middleware instead, so no debug endpoint ships to production and the
guarantee is re-checked on every run rather than once by hand.

### `[x]` `.env.example` lists every variable the app reads, no real secrets

```
$ grep -rhoE 'process\.env\.[A-Z_]+' src/ | sort -u
process.env.PORT
process.env.WEB_ORIGIN
```

Both are documented in `.env.example` with safe defaults and no real values.
The file grows as each issue introduces a variable; `#41` checks it is complete
at launch.

### `[x]` Full suite green, rules hold

```
$ npm run test:backend
# tests 7  # pass 7  # fail 0

$ npm run check:rules
  SKIP  No Float or Decimal in the Prisma schema (not present yet)
  PASS  No ledger update or delete path
  PASS  escrowService.js is the sole caller of release/refund
  PASS  No card payment path
  SKIP  Frontend makes no direct provider calls (not present yet)
  SKIP  No raw stack traces rendered in the web app (not present yet)
passed 3   failed 0   skipped 3
```

Three rules flipped from SKIP to PASS now that backend source exists.

### `[x]` The deployed backend's `/health` route responds at a live URL

Live at **https://o-artiste-api.onrender.com**.

```
$ curl -sS -i https://o-artiste-api.onrender.com/health
HTTP/2 200
content-type: application/json; charset=utf-8
access-control-allow-origin: http://localhost:3000
x-render-origin-server: Render

{"status":"ok"}

$ curl -w 'http=%{http_code} total=%{time_total}s'
http=200  total=0.602708s
```

`WEB_ORIGIN` is still the `http://localhost:3000` placeholder — updated to the
Vercel URL at #3.

Two deploys failed first, both configuration rather than code, and both worth
recording because they are the monorepo traps:

1. `npm install` had been entered into the **Root Directory** field rather than
   Build Command. Render tried to enter a directory of that name and exited in
   4.5s.
2. With that fixed the build succeeded but start failed with
   `Missing script: "start"` — Render was deploying `b994b93`, the #1 scaffold,
   which predates the server existing. The log gave it away twice: *"added 2
   packages, audited 5"* is the #1 tree, and #2's `start` script had not yet
   been merged.

**Root Directory must remain blank.** The lockfile and the `overrides` block
pinning `qs` both live at the repository root; pointing Render at
`apps/backend` would install from there alone, silently discarding the override
and reinstating the advisories this issue closed.

### The two host values #2 requires recording

**Does the instance sleep when idle? Yes.** Free plan — Render's own banner
reads *"Your free instance will spin down with inactivity, which can delay
requests by 50 seconds or more."*

Left alone this would block #5 and #25. Auto-release fires 48–72h after an
event, exactly when nobody is making requests and therefore exactly when a free
instance is asleep.

**Resolved for the build by an external keepalive**: a cron-job.org job pings
`/health` every 10 minutes, so the instance never spins down and the worker
process stays alive. Ten minutes rather than fifteen, because Render's idle
window is ~15 minutes and a ping at that exact interval races the thing it
exists to prevent. `/health` suits the job precisely because it has no database
or Redis dependency.

Accepted deliberately as a **testing** arrangement, to be revisited at #41:
production should use a paid instance with the worker as its own always-on
service. The separate worker entry point is being built either way, so that is
configuration rather than a rewrite. Recorded in `DEPLOYMENT-CHECKLIST.md` § #2.

**Default request timeout: not established, and designed around instead.**
Render publishes no single figure and community reports range from 15s to 100s
across different years. Measuring it would mean deploying a deliberately slow
endpoint.

Resolution: #17 sets the EscrowPay client timeout to **15 seconds or less** —
below the lowest figure Render has ever been reported to use. That satisfies
#17's criterion by construction rather than by measurement, and removes the
dependency on a number we cannot pin down. A REST call to create or release an
escrow has no business taking longer; if it does, our own timeout firing first
is the outcome we want, because the self-generated reference
(`docs/03-ESCROW-FLOW.md` §3) makes the retry safe.


### Security finding fixed in this issue

`npm install` reported **2 moderate vulnerabilities**: Express 4.22.2 depends on
`qs` at `~6.15.1`, and every 6.15.x release is affected by GHSA-x5fp-wj9c-mxmx
(array-limit bypass) and GHSA-4mjr-xmp4-gh2g (denial of service via attacker-
controlled `isBuffer`).

Express's own range cannot reach the fix, so `npm audit fix` does not resolve
it. Added a root `overrides` entry pinning `qs` to `^6.16.0` — a minor,
API-compatible bump — and regenerated the lockfile:

```
$ node -p "require('./node_modules/qs/package.json').version"
6.16.0
$ npm install
found 0 vulnerabilities
```

A denial-of-service vector in the query parser is worth closing on a service
that will hold funding instructions, and it would otherwise have sat in the
tree until someone noticed it at #41.

### Added outside the issue's stated scope

- `src/app.js` — application assembly split from `src/index.js`, so tests can
  build an app without binding a port. The issue names only `src/index.js`.
- `src/lib/errors.js` — `AppError` plus the terminal error middleware,
  establishing the unified error shape now rather than retrofitting it across
  every route later.
- `src/lib/bodyParsers.js` — the raw-body exception, extracted so it can be
  tested directly.
- Root `package.json` `overrides` — see the security finding above.
- SIGTERM/SIGINT handling in `src/index.js`, so in-flight requests finish on
  deploy rather than being cut mid-response. On this system a request cut
  mid-flight can be one that has already instructed a money movement.

---

## #3 — chore(web): bootstrap Next.js client and deploy

Branch `chore/3-web-bootstrap`. Verified 2026-09-11.

### `[x]` `npm run dev:web` starts the dev server; `localhost:3000` loads

```
▲ Next.js 16.3.3 (Turbopack)
- Local:  http://localhost:3000
✓ Ready in 365ms

$ curl -w 'http=%{http_code} total=%{time_total}s' http://localhost:3000
http=200 total=0.026824s
```

Server-rendered output contains `₦200,000`, `₦0`, and the configured API base.

### `[x]` `formatNaira(20000000)` returns `₦200,000`

### `[x]` `formatNaira(0)` returns `₦0`, not an empty string or `₦NaN`

```
$ npm run test --workspace apps/web
# tests 7  # pass 7  # fail 0
```

`Intl.NumberFormat` with `style: 'currency'` emits `₦200,000.00`, so the symbol
is prefixed manually over a plain grouping formatter. That keeps the output
exactly what the criterion specifies and leaves control over the decimal rule:
whole Naira render without decimals, an amount carrying kobo renders to two
places, so a figure is never silently rounded away from what the ledger holds.

| Input (kobo) | Output |
|---|---|
| `20000000` | `₦200,000` |
| `0` | `₦0` |
| `2000000` | `₦20,000` (EscrowPay floor) |
| `300000000` | `₦3,000,000` (EscrowPay ceiling) |
| `123456` | `₦1,234.56` |
| `1` | `₦0.01` |
| `-50000` | `-₦500` |

A property test sweeps integers and asserts no output is ever empty, contains
`NaN`, or loses the symbol.

**`formatNaira` throws on a non-integer, `NaN` or `Infinity`.** Every amount
reaching it comes from our own API, which guarantees kobo integers, so a float
arriving is a contract violation upstream. Rendering `₦0` or `₦NaN` for a real
amount would hide a money bug behind something that looks fine. This follows the
same posture as the booking state machine, where an impossible transition throws
rather than proceeding (`docs/01-DATA-MODEL.md` §4).

No reverse `naira → kobo` helper exists, and none may be added — parsing a
user-entered amount is a backend concern, and a second place where money changes
representation is a second place a rounding bug can live.

### `[x]` `npm run lint` passes

```
$ npm run lint
> eslint
lint exit=0
```

`eslint-config-next` 16 ships **native flat config**, so it is imported and
spread directly. The initial `FlatCompat` bridge — the documented approach for
older versions — crashed with `TypeError: Converting circular structure to JSON`
when asked to normalise a config that is already flat. `@eslint/eslintrc` was
dropped from devDependencies as a result.

### `[x]` Production build succeeds

```
$ npx next build
▲ Next.js 16.3.3 (Turbopack)
✓ Compiled successfully in 308ms
  Finished TypeScript in 1454ms
✓ Generating static pages (3/3)
```

`allowImportingTsExtensions` was enabled. Node's type stripping requires the
`.ts` extension on relative imports so tests can run without a build step, while
TypeScript rejects that extension by default. The flag reconciles the two, and
is valid because `noEmit` is set.

### `[x]` Cross-origin path verified against the deployed backend

```
$ curl -H "Origin: http://localhost:3000" https://o-artiste-api.onrender.com/health
access-control-allow-origin: http://localhost:3000

$ curl -H "Origin: https://evil.example.com" https://o-artiste-api.onrender.com/health
access-control-allow-origin: http://localhost:3000
```

The allowed origin is echoed regardless of who asks, so a browser on any other
origin blocks the response. That is correct for a fixed allowlist, and confirms
`WEB_ORIGIN` is doing its job rather than being permissive.

The health check runs from a **client** component deliberately. A server-side
fetch would succeed even with CORS misconfigured, and would prove nothing about
the path the real application uses.

### `[x]` Deployed and reachable at a live Vercel URL, calling the deployed backend

Live at **https://o-artiste-web.vercel.app**, root directory `apps/web`.

```
$ curl https://o-artiste-web.vercel.app
vercel page: http=200 total=0.447471s
page money : ₦0 ₦200,000

$ curl -H "Origin: https://o-artiste-web.vercel.app" \
       https://o-artiste-api.onrender.com/health
HTTP/2 200
access-control-allow-origin: https://o-artiste-web.vercel.app
{"status":"ok"}

$ curl -X OPTIONS -H "Origin: https://o-artiste-web.vercel.app" \
       -H "Access-Control-Request-Method: GET" ...
HTTP/2 204
access-control-allow-origin: https://o-artiste-web.vercel.app
vary: Origin, Access-Control-Request-Headers
```

The preflight is checked as well as the simple request, because a browser issues
`OPTIONS` first for anything non-trivial and a backend can pass one while
failing the other.

Still correctly restricted rather than wildcarded — a request from
`https://evil.example.com` is answered with the Vercel origin, not its own, so
that browser blocks the response:

```
$ curl -H "Origin: https://evil.example.com" .../health
access-control-allow-origin: https://o-artiste-web.vercel.app
```

**Full chain proven:** browser → Vercel page → Render API → `{"status":"ok"}`,
with money rendered through `formatNaira` at both ends of the deploy.

**Vercel configuration differs from Render's, deliberately.** Vercel takes root
directory `apps/web` and handles npm workspace hoisting itself, installing from
the repository root via `npm install --prefix=../..`. Render takes a *blank*
root directory, because pointing it at `apps/backend` would install from there
alone and discard the root lockfile and the `qs` override. Same monorepo,
opposite settings, for the same underlying reason: the install must happen at
the root.

**Two deploys were misdirected first, both instructive.** The Vercel import
initially targeted `apps/backend` with the Express preset — that would have put
a second copy of the API behind a second public URL, and at #17 exactly one URL
gets registered with EscrowPay as the webhook endpoint. A webhook reaching the
wrong instance is the duplicate-processing scenario `docs/03-ESCROW-FLOW.md` §6
calls the highest-severity bug class in this system. The backend is on Render
alone, and must stay that way; Vercel is serverless and cannot run the BullMQ
workers #25 depends on.

Then Vercel showed no Next.js detection for `apps/web`, because at that moment
`main` held only the placeholder `package.json` from #1 — no `next` dependency,
no source. Same shape as the earlier Render failure, which deployed a commit
predating the `start` script. **Every deployment reads `main`, so `main` must
contain the thing being deployed before the platform can see it.**

### Rule refined — and re-verified for teeth

`check:rules` reported a **false positive**: the pattern matched
`{state.status}`, the backend's health string `"ok"`, because it fired on any
field literally named `status`. This codebase will have many legitimate ones.

The pattern now matches only values rendered out of an error or response object
— `{error.stack}`, `{err.status}`, `{response.status}` — which is what #39
actually forbids. A rule that fires on correct code gets switched off within a
week, so precision here is what keeps it alive.

Confirmed it still catches the real thing, by injecting a violation and removing
it again:

```
# with {error.stack} injected:
  FAIL  No raw stack traces or HTTP status codes rendered in the web app
        > apps/web/src/app/backend-status.tsx:47: ... {error.stack}</span>;
passed 4   failed 1   skipped 1

# restored:
passed 5   failed 0   skipped 1
```

This is the same standard #40 sets for the webhook replay assertion: a check
that cannot fail proves nothing.

### Framework docs read, per `PROJECT_GUIDE.md` §3

`next dev` generates `apps/web/AGENTS.md` and `CLAUDE.md`, which the project
guide requires retaining, and which instruct reading
`node_modules/next/dist/docs/` before writing Next.js code. Doing so caught a
real incompatibility and flagged one for later.

**Node 20.9 is the minimum for Next 16.** The `engines` field said `>=20`, which
permits 20.0 through 20.8 — and the first Render deploy ran on **20.8.2**, below
the floor. Tightened to `>=20.9.0` across all three `package.json` files, keeping
both workspaces on one Node target per #1's technical note. `NODE_VERSION=22` on
Render remains the right setting; this makes the requirement explicit rather
than relying on the host default happening to be new enough.

**Async Request APIs — relevant at #13, not yet.** Next 16 removes synchronous
access to `params`, `searchParams`, `cookies` and `headers` entirely; they are
promises now. `app/artists/[id]/page.tsx` and `app/artists/[id]/book/page.tsx`
must `await params`. Nothing in this issue uses them, so there is nothing to fix
here — recorded so #13 does not rediscover it.

Two other Next 16 changes worth knowing, neither affecting current code:
Turbopack is the default for `dev` and `build` (no `--turbo` flag, confirmed in
the build output), and the `middleware` convention is renamed to `proxy`.

### Added outside the issue's stated scope

- `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` — generated by `next dev`.
  Committed deliberately: `PROJECT_GUIDE.md` §3 requires retaining them, §2
  lists both as expected files, and the block itself notes that removing it from
  a diff only recreates the uncommitted change.
- `src/app/backend-status.tsx` — a client component, so the cross-origin call is
  exercised from the browser rather than the server.
- `apps/web/.env.example` — documents `NEXT_PUBLIC_API_URL` and records that
  `NEXT_PUBLIC_` values are embedded in the browser bundle, so nothing secret
  may ever go there.
- `ApiError` in `src/lib/api.ts` — carries the backend's `error` string so the
  UI can render it unaltered, and distinguishes a network failure from a server
  rejection, which need different copy.

---

## #4 — feat(backend): Prisma schema, managed Postgres, initial migration

Branch `feat/4-prisma-schema`. Verified 2026-09-11 against PostgreSQL 16.15.

### `[x]` `npx prisma migrate dev` applies cleanly against a fresh database

Proven by `migrate reset`, which drops everything and replays from scratch —
a stronger check than applying to a database that already matched:

```
$ npx prisma migrate reset --force --skip-seed
Applying migration `20260911204031_init`
Database reset successful

$ npx prisma migrate status
1 migration found in prisma/migrations
Database schema is up to date!
```

16 tables created: the 15 named in #4, plus `DisputeEvidence`.

### `[x]` `npx prisma generate` produces a client with no errors

```
✔ Generated Prisma Client (v5.22.0) to ./../../node_modules/@prisma/client
```

### `[x]` Grepping `schema.prisma` for `Float` and `Decimal` returns zero matches

Zero matches **in field-type position**:

```
$ grep -nE '^[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]+(Float|Decimal)\b' prisma/schema.prisma
zero matches
```

A bare word-match does return two hits — lines 7 and 305 — but both are
**comments documenting the rule itself**, not field declarations. The check in
`check:rules` was therefore made type-position-aware rather than word-matching.
The rule forbids the *types*, not the *words*, and a check that cannot tell a
violation from its own documentation is a check nobody trusts. Same reasoning as
the `{state.status}` false positive corrected at #3.

Confirmed it still has teeth, by replacing three `amountKobo Int` declarations
with `Float` and running it:

```
  FAIL  No Float or Decimal field type in the Prisma schema
        > 228:  amountKobo Float
        > 452:  amountKobo Float
        > 481:  amountKobo Float
passed 5   failed 1   skipped 0
```

Restored: **6 pass, 0 fail, 0 skip** — every rule in the file is now active, with
nothing skipped for the first time.

**Verified independently against the database**, which is the claim that
actually matters — the schema is an intention, the database is the fact:

```sql
select ... where data_type in ('double precision','real','numeric','money');
-> NONE
```

Every one of the 14 money and basis-point columns reports `integer`:
`Artist.baseRateKobo`, `Booking.amountKobo`,
`Booking.commissionRateBpsSnapshot`, `Cancellation.{clientRefundKobo,
artistCompensationKobo, escrowFeesKobo}`, `CancellationTier.{clientRefundBps,
artistCompensationBps}`, `CommissionRate.rateBasisPoints`,
`Dispute.{splitClientKobo, splitArtistKobo}`, `FeeLiability.amountKobo`,
`LedgerEntry.amountKobo`, `TermsAcknowledgement.commissionRateBpsAsDisplayed`.

Geolocation on `CheckIn` is stored as `text` precisely so that a genuinely
fractional value cannot introduce a `Float`. It is supporting metadata that is
never computed on (`docs/01` §1).

### `[x]` Required constraints exist, verified in the database

```
Booking.escrowReference        UNIQUE
WebhookEvent.providerEventId   UNIQUE
CheckIn.bookingId              UNIQUE
Cancellation.bookingId         UNIQUE
TermsAcknowledgement.bookingId UNIQUE
```

`BookingState` holds exactly the nine specified values, in order:
`PENDING_PAYMENT FUNDED_HELD CHECKED_IN AWAITING_CONFIRMATION RELEASED REFUNDED
CANCELLED DISPUTED RESOLVED`.

`CheckIn` columns — note there is **no client-writable timestamp field at all**,
which is the point rather than an omission:

```
redeemedAt  timestamp  default CURRENT_TIMESTAMP
createdAt   timestamp  default CURRENT_TIMESTAMP
```

### `[x]` Schema guarantees exercised by test

```
$ npm run test:backend
# tests 13  # pass 13  # fail 0  # skipped 0
```

| Test | What it protects |
|---|---|
| `escrowReference` is unique | Two escrows for one booking is unrecoverable (`docs/03` §3) |
| `WebhookEvent.providerEventId` is unique | The idempotency guarantee — a provider retry cannot produce a second row, which is what makes "record before processing" safe |
| `CheckIn` timestamp is server-set | The primary evidence in every dispute; a client-supplied time is an assertion, not evidence |
| Config snapshot survives a round trip | Payout math reads the snapshot, never live config (`docs/07` §4) |
| **A completed booking sums to exactly zero** | The widest-catching financial check in the system |
| State defaults to `PENDING_PAYMENT` | |

The ledger test encodes the canonical worked example from `docs/01` §5 and
`docs/05` §3 — ₦200,000 at 5%, money-in capped at ₦2,000, money-out ₦70 — and
asserts both that the five entries sum to zero and that the artist's line is
exactly **18,793,000 kobo (₦187,930)**, the figure #14 and #26 will be held to.

### `[x]` Managed Postgres provisioned, `DATABASE_URL` set on the deployed backend

Render PostgreSQL 16, instance `o-artiste-db`, database `artist_escrow`, region
**Ohio (US East)** — the same region as `o-artiste-api`, since internal
connections only work within a region and the region cannot be changed after
creation.

`DATABASE_URL` is set on the service from the **Internal** connection string.
Verified by exercising a database-backed route rather than by reading the
dashboard:

```
$ curl -X POST https://o-artiste-api.onrender.com/auth/login \
       -d '{"email":"nobody@example.test","password":"wrong-password-here"}'
{"error":"Email or password is incorrect."}   http=401
```

Reaching that message requires the Prisma client to have generated,
`DATABASE_URL` to resolve, and a real query against the `User` table to return
nothing. A misconfigured database would have produced a 500.

### `[x]` Migration applied against the deployed database, not just locally

```
$ DATABASE_URL="<render external>" npx prisma migrate deploy \
    --schema apps/backend/prisma/schema.prisma
Applying migration `20260911204031_init`
All migrations have been successfully applied.
```

`migrate deploy` rather than `migrate dev` — `dev` can reset the database and
generates new migrations, while `deploy` only applies what is already committed.
That distinction stops mattering the moment an instance holds data anyone cares
about, so the habit is worth forming before it does.

Verified against the deployed instance directly, not inferred from the command
exiting zero:

| Check | Result |
|---|---|
| Tables created | **16** |
| Columns of type `double precision`, `real`, `numeric`, `money` | **NONE** |
| Money and basis-point columns that are `integer` | **14 of 14** |

The money rule therefore holds on the deployed database, not only in the schema
file and not only locally.

A first `migrate deploy` appeared to succeed while `migrate status` still
reported the migration unapplied — the output had been over-filtered while
masking the connection string, hiding the real result. Re-run unfiltered, it
applied. Worth recording: **a deployment step verified only by its own exit code
is not verified.** The table count and column types are the evidence.

The 30-day free-tier expiry applies. It is survivable by design: the migration
is version-controlled and #6's seed is idempotent, so the state is reproducible
with two commands.

### Security note carried to #41

The instance accepts inbound connections from `0.0.0.0/0` — Render's default,
and a precondition for running the migration from a developer machine at all.
Acceptable for a test database holding regenerable seed data; not acceptable
once it holds identity records and booking history.

Added to the #41 checklist: restrict inbound to Render's egress ranges, have the
application reach the database over the internal hostname only, and issue
production credentials that have never been pasted into a chat transcript or a
terminal history.

### Local development database

`sudo` requires interactive authentication on this machine and no `elcareem`
Postgres role exists, so the system instance could not be used. Development runs
against a container instead:

```
docker run -d --name artist-escrow-pg \
  -e POSTGRES_USER=artist -e POSTGRES_PASSWORD=artist_dev \
  -e POSTGRES_DB=artist_escrow_dev -p 55432:5432 postgres:16-alpine
```

Port 55432 deliberately, to avoid colliding with the system Postgres on 5432.
`apps/backend/.env` holds the local connection string and is gitignored —
confirmed with `git check-ignore`.

### Added outside the issue's stated scope

- `src/lib/prisma.js` — the Prisma Client singleton named in `PROJECT_GUIDE.md`
  §2. One instance per process: instantiating per request exhausts the
  connection pool, and a connection failure mid-transaction is not a cheap error
  on a service holding funding instructions.
- `test/schema.test.js` — the guarantees above. Skips cleanly when
  `DATABASE_URL` is absent so the suite still runs without a database.
- `NODE_ENV` documented in `.env.example`. Cross-checked that every variable the
  app reads — including `DATABASE_URL`, which Prisma reads from the schema
  rather than through `process.env` — is documented.

---

## #9 — feat(backend): authentication, roles, and permission middleware

Branch `feat/9-auth-roles-middleware`. Verified 2026-09-11.

Built before #6, #7 and #8 per the corrected order in `docs/08-BUILD-PLAN.md` §2:
both config endpoints are `SUPER_ADMIN`-restricted and cannot close without this
middleware, and #6's seed hashes passwords with the utility this issue adds.

```
$ npm run test:backend
# tests 22  # pass 22  # fail 0  # skipped 0
```

### `[x]` A registered user can log in and call `GET /me`

Verified in-process and against a live server:

```
$ curl -X POST localhost:4000/auth/register -d '{...,"role":"CLIENT"}'
http=201

$ curl localhost:4000/me -H "Authorization: Bearer <token>"
{"user":{"id":"cmtxh1xli...","role":"CLIENT","verificationStatus":"UNVERIFIED",
 "accountStanding":"GOOD",...},"profile":{"displayName":"..."}}
```

The `Client` or `Artist` profile row is created **in the same transaction** as
the `User`. A user without their profile is a half-registered account every
later query has to defend against.

### `[x]` An expired or malformed token returns 401

Five distinct failure modes, each asserted, each returning `401` in the unified
error shape: genuinely expired (signed with `expiresIn: '-1s'`, not merely
invalid), valid structure with the **wrong signing key**, malformed, empty, and
nonsense. A valid token is checked immediately afterwards, so the suite cannot
pass by rejecting everything.

All five return the **same message**. Distinguishing "expired" from "bad
signature" tells an attacker which part of a forged token to fix next.

**A token belonging to a deleted user is also rejected.** `requireAuth` loads
the live database row rather than trusting the token payload — the token says
what the role *was* when issued, and tokens last days while account standing
changes in seconds. A user suspended or demoted five minutes ago still holds a
cryptographically perfect token.

### `[x]` Each role is blocked from at least one endpoint above its level

| Caller | `/admin/ping` | `/admin/config/ping` |
|---|---|---|
| no token | `401` | `401` |
| `CLIENT` | **`403`** | `403` |
| `ADMIN` | `200` | **`403`** |
| `SUPER_ADMIN` | `200` | `200` |

The `ADMIN` → `403` row is the one that matters. **Roles are matched exactly,
with no implicit hierarchy** — `SUPER_ADMIN` is not "`ADMIN` plus more" in code.
An admin resolving a dispute affects one booking; a super-admin changing the
commission rate affects every booking created afterwards (`docs/07` §1). Implicit
rank is how a permission ends up somewhere nobody intended, so if an endpoint
should accept both roles it lists both.

These two endpoints exist so the guarantee is testable now; #7 and #8 mount the
real configuration endpoints behind the same guard.

### `[x]` There is no public route by which an account can self-assign `ADMIN` or `SUPER_ADMIN`

Four separate attempts, all refused:

1. `POST /auth/register` with `"role": "ADMIN"` → **`403`**, and no row created
2. `POST /auth/register` with `"role": "SUPER_ADMIN"` → **`403`**, and no row created
3. `"role": ["CLIENT","SUPER_ADMIN"]` — smuggling it in a different shape → `403`
4. A self-minted JWT claiming `SUPER_ADMIN`, signed with a guessed key → `401`

The database is queried after each attempt to confirm **no account was created
at all**, rather than trusting the status code.

**Rejected outright, never silently downgraded.** Quietly creating a `CLIENT`
when someone asked for `SUPER_ADMIN` would hide an attempt worth seeing.

### `[x]` Passwords are hashed, never plaintext, never reversible

```
stored.passwordHash  →  $2a$12$...   (bcrypt, cost factor 12)
```

Asserted to differ from the plaintext, to match the bcrypt format, and to carry
cost factor **12** — roughly 250ms, slow enough that offline cracking is
expensive and fast enough that login does not feel broken. Raising it later is
safe: bcrypt encodes the cost in the hash, so existing hashes keep verifying
against their original factor.

`GET /me` is asserted to contain **no `passwordHash`, no bcrypt string anywhere
in the payload, and no `verificationReference`**. The serialiser is an explicit
**allowlist**, not a delete-list, so a column added later is private by default
rather than exposed until someone notices.

### `[x]` Enumeration is not possible through registration or login

Two paths that commonly leak who holds an account, both closed and both asserted
by comparing the response bodies are **identical**:

- Duplicate email and duplicate phone return the same `409` and the same message
- Wrong password and no-such-user return the same `401` and the same message

A suspended account gets a distinct `403` with clear, non-technical wording
(`docs/06` §5) — that one is deliberately different, because it is shown only to
someone who has already proven they hold the password.

### Added outside the issue's stated scope

- `requireVerified` in `src/middleware/auth.js` — written here because it
  belongs beside the other guards, but not yet mounted anywhere. Its acceptance
  criterion (#10: an unverified client receives `403` on `POST /bookings`) is
  verified at #15, where that endpoint exists. Recorded as deferred, not ticked.
- `/admin/ping` and `/admin/config/ping` — the endpoints the role matrix above
  is verified against. #7 and #8 replace them with the real configuration
  routes behind the same guards.
- `JWT_SECRET` and `JWT_EXPIRES_IN` documented in `.env.example`. The app
  **refuses to sign or verify tokens when `JWT_SECRET` is unset** rather than
  falling back to a default — a predictable signing key means anyone can mint a
  `SUPER_ADMIN` token, which is the whole permission system defeated by one
  missing environment variable.

### Out of scope, per the issue

No social login. No password reset flow.

### Audit logging for rejected privilege escalation (added by decision)

Agreed after review, as an extension to #9 rather than a separate issue. Two
decisions were put to the maintainer; both were taken:

**1. `requireAuth` reads the live database row, not the token payload — kept.**
The alternative is short-lived tokens plus a refresh mechanism. Rejected for
now: one indexed primary-key lookup per request is cheap, and the failure mode
of trusting the token is that a suspended artist keeps accepting bookings and
taking client money into escrow for the remaining days of their token's life.
#34's enforcement rules would be decorative otherwise. Revisit only if the query
ever appears in profiling.

**2. Privilege-escalation attempts are now recorded in `AuditLog`.**

Previously the 403 was returned and nothing was written — the signal existed and
nobody was listening.

Two events are recorded:

| Action | When | Actor |
|---|---|---|
| `REGISTRATION_ROLE_REJECTED` | `POST /auth/register` asks for a role that is not publicly registerable | none — anonymous |
| `ROLE_DENIED` | an authenticated user is refused an endpoint above their level | the user, named |

**Schema change: `AuditLog.actorUserId` is now nullable**, with `actorIp` and
`actorUserAgent` added. The column was a required foreign key, which meant the
events most worth recording — the anonymous ones — were the only events the
table could not hold. An unauthenticated request trying to register itself as
`SUPER_ADMIN` has no user id. Migration `20260911214328_audit_log_anonymous_actors`,
applied locally and to the deployed database:

```
actorUserId    text  nullable=YES
actorIp        text  nullable=YES
actorUserAgent text  nullable=YES
```

**Two write paths, because the two kinds of event have opposite failure
requirements** (`src/lib/audit.js`):

- `recordAudit(tx, entry)` — inside the caller's transaction, and **must
  succeed**. For configuration changes, dispute resolutions and manual money
  movements: if the audit row cannot be written, the change it records must not
  happen either. Used from #7 onward.
- `recordAuditSafe(entry)` — best effort, **never throws**. For security events:
  the rejection has already happened and is correct, and a failure to log must
  not turn a clean 403 into a 500. Otherwise an attacker could suppress their
  own audit trail by breaking the logger.

Verified by three tests (25 backend tests total, all passing):

- A rejected `SUPER_ADMIN` registration writes a row with `actorUserId: null`,
  the captured IP, and `after.attemptedRole: "SUPER_ADMIN"` — and still creates
  no account
- A `CLIENT` refused `/admin/config/ping` writes a row **naming them**, with
  `after.held: "CLIENT"` and `after.required: ["SUPER_ADMIN"]`
- A permitted `SUPER_ADMIN` request writes **no** denial row, so the log is not
  merely recording everything

Rate limiting on these endpoints remains open at #41; this records the attempts,
it does not yet slow them down.

---

## #6 — chore(backend): seed script

Branch `chore/6-seed-script`. Verified 2026-09-12.

```
$ npm run test:backend
# tests 30  # pass 30  # fail 0  # skipped 0
```

### `[x]` `node prisma/seed.js` run twice produces identical database state

Fingerprinted with an MD5 over every seeded row **including `createdAt` and
`updatedAt`**, so any write at all would change it:

```
counts after run 1 (user/artist/client/rate/tier): 6/2/2/1/4
counts after run 2 (user/artist/client/rate/tier): 6/2/2/1/4
md5 after run 1: 4e32b6fd2b8f4cc8248e3a8bdc671dec
md5 after run 2: 4e32b6fd2b8f4cc8248e3a8bdc671dec
IDENTICAL — including every timestamp
```

**Every write is guarded by an existence check rather than an upsert.** An
upsert would satisfy a row-count assertion while still issuing an `UPDATE` on
every run, moving `updatedAt`. The criterion says *identical state*, so nothing
may be written twice — not even harmlessly.

### `[x]` Seeded artist rates fall within the EscrowPay transaction range

```
DJ Ekene:   5000000 kobo  (₦50,000)
Tolu Live: 25000000 kobo  (₦250,000)
```

Both inside ₦20,000–₦3,000,000. The seed **refuses to run** if a rate falls
outside it, rather than leaving the failure to surface when a client tries to
pay — `assertRatesAreFundable()` throws before anything is written.

Tolu Live at ₦250,000 sits exactly on the EscrowPay money-in cap boundary, which
makes it a useful fixture for #14's fee tests.

### `[x]` The default tier set has no gaps or overlaps in its day ranges

```
0 to 0   refund 1500  / comp 8500  = 10000
1 to 2   refund 4000  / comp 6000  = 10000
3 to 6   refund 7000  / comp 3000  = 10000
7 to ∞   refund 10000 / comp 0     = 10000
```

Asserted four ways, because "no gaps or overlaps" is easy to eyeball and easy to
get wrong:

- Every row's two percentages sum to exactly **10000 bps**
- **Day 0 is covered** — a booking cancelled on the day has to resolve to
  something
- Exactly **one open-ended band**, and it is the last one
- Each band starts exactly where the previous ended (`min == previous.max + 1`)
- **Every day from 0 to 30 resolves to exactly one band**, checked by iteration
  rather than by inspection

A gap would mean a cancellation in that window has no applicable rule, and there
is no safe default: refunding everything harms the artist, refunding nothing is
FCCPA exposure (`docs/05` §5).

### `[x]` Configuration seeded as records, not constants

One `CommissionRate` at **500 bps**, attributed to the seeded `SUPER_ADMIN` —
an audit trail with no actor is not an audit trail. Asserted to be an integer,
never a float percentage, so `0.05` can never enter a money calculation.

This is the real point of seeding here: it establishes from day one that the
rate and the tier table are **data**, so no later issue is tempted to hardcode
5% and quietly diverge from the versioned record payout math is supposed to read
(`docs/07` §3).

### `[x]` Accounts cover every role, with the right verification posture

Six accounts: 1 `SUPER_ADMIN`, 1 `ADMIN`, 2 `CLIENT`, 2 `ARTIST`.

Clients and artists are **pre-verified**, so later phases have something to work
against without running the provider flow. Admins are deliberately **not** —
they never transact, and verification exists so money has a confirmed recipient.

`verificationReference` holds the **result** of the check, never a NIN or BVN.
Retaining the identifier is NDPR exposure with no operational benefit.

Every seeded user has its `Client` or `Artist` profile row, created in the same
transaction, so a half-seeded account cannot exist.

### Test contamination found and fixed

The seed tests initially failed in the full suite while passing alone: they
asserted whole-table counts, and the auth and audit suites create users in the
same database — 3 super-admins and 9 artists by the time they ran.

The assertions are now **scoped to the seeded rows** (by known email, commission
rate id, and tier version id). That is the correct scope regardless: a seed test
should measure what the seed writes, not what its neighbours happen to be doing.
A test that fails because another test did its job is a test that gets deleted.

---

## #7 — feat(backend): versioned commission rate configuration

Branch `feat/7-commission-config`. Verified 2026-09-12.

```
$ npm run test:backend
# tests 38  # pass 38  # fail 0  # skipped 0
```

### `[x]` A non-super-admin token receives 403 from the endpoint

```
$ curl -X PUT /admin/config/commission -H "Authorization: Bearer <ADMIN>" \
       -d '{"rateBasisPoints":700,"reason":"admin attempt"}'
{"error":"You do not have permission to do that."}  http=403
```

Asserted for `CLIENT`, `ARTIST` and `ADMIN`, plus `401` with no token — and
`201` for `SUPER_ADMIN`, so the guard is a real discrimination rather than a
blanket refusal.

**`ADMIN` can read the rate but cannot change it.** Reading what the take is
does not carry the risk that changing it does: an admin resolving a dispute
affects one booking, this affects every booking created afterwards
(`docs/07` §1).

This replaces the `/admin/config/ping` placeholder from #9 — that endpoint is
now deleted, and #9's role-matrix assertions point at the real route.

### `[x]` Changing the rate leaves the prior record intact and queryable

```
$ curl PUT .../commission  -d '{"rateBasisPoints":700,...}'   → 201

$ curl GET .../commission
700 bps from 2026-09-12T04:51:02.449Z
500 bps from 2026-01-01T00:00:00.000Z
```

A change writes a **new record** with a new id. The test reads the original row
back by id afterwards and asserts it still reads `500`, not `700` — proving it
was neither updated nor deleted.

### `[x]` The resolver returns the correct historical rate for a past timestamp

The canonical scenario from the issue — set 5%, change to 7%, query yesterday,
get 5% — plus the boundary either side of it:

| Query moment | Rate |
|---|---|
| day before the change | **500** |
| exactly at `effectiveFrom` | **700** (inclusive) |
| 1 ms before `effectiveFrom` | **500** |
| day after the change | **700** |

**A future-dated rate is scheduled, not active.** A rate set to take effect in
30 days does not alter what today resolves to, and does take effect once its
time comes. Both directions asserted.

Ties on `effectiveFrom` break by `createdAt` descending, so two records sharing
a moment resolve deterministically to the later-written one — the one an admin
most recently intended.

**With no record at all the resolver throws** rather than defaulting. A silent
fallback to 5% would price real bookings off a number nobody configured, and the
discrepancy would surface only in a ledger that will not reconcile.

### `[x]` An audit row exists naming the actor for every change

```
COMMISSION_RATE_CHANGED by cmtxwqee80001pciztqt6sbf3 : 500 -> 700
  reason: provider fees increased
```

Both sides of the change are recorded, so the trail reconstructs rather than
merely noting that something happened.

**The audit row and the rate record commit or fail together.** Asserted
directly: calling the service with a non-existent `actorUserId` makes the audit
insert violate its foreign key, and the rate record count is unchanged
afterwards. A configuration change that cannot be attributed must not happen at
all — which is why this uses `recordAudit` inside the transaction rather than
the best-effort `recordAuditSafe` used for security events (`docs/07` §5).

### `[x]` Rate is basis points, integer, never a float percentage

Rejected with `400`: `5.5`, `"500"`, `-1`, `10001`, `null`, and omitted.
Accepted: `0` and `10000`, the permitted extremes.

Basis points are integers so that `0.05` can never enter a money calculation
(`docs/00` §6).

### Additional constraints applied

**A written reason is mandatory** — `400` when absent or whitespace. A change to
the platform's take without a recorded justification is indefensible later, and
"later" means a regulator or an artist asking months afterwards.

**Rates cannot be backdated** — `400` for an `effectiveFrom` in the past.
Backdating would rewrite what the resolver reports for moments that have already
passed, which is the audit trail changing its own history. Existing bookings are
protected by their snapshots either way, so backdating buys nothing and costs
reconstructability. Forward-dating is allowed and useful: it schedules a change.

### Test contamination, second instance

`before.rateBasisPoints` was asserted as a literal `500` and picked up a `700`
written by an earlier test in the same file. The service behaviour was correct —
`previous` should be the latest record globally, which is what it returned.

The test now captures the current record immediately before the change and
asserts `before` matches it. That tests the real guarantee without depending on
isolation the shared database does not provide. Same lesson as #6: assert what
the code guarantees, not what the table happens to contain.

---

## Follow-ups agreed at review (after #7)

Three decisions taken by the maintainer after reviewing #7.

### 1. `ADMIN` may read the commission rate — confirmed, no change

Reading what the take is does not carry the risk that changing it does, and
admins resolving disputes need it to explain why an artist received ₦187,930
rather than ₦200,000.

### 2. Backdating stays forward-only — confirmed after comparison

The maintainer asked what comparable systems do before deciding. Summary given:

- **Money systems are almost universally forward-only.** Payroll engines, tax
  tables, billing platforms, insurance rating engines: effective-dated
  configuration is append-only and takes effect forward. Where backdating exists
  it is a separate privileged *correction* workflow that generates its own
  adjustment records.
- **Accounting systems allow it but fence it** — QuickBooks and Xero permit
  posting into the past, then lock closed periods. The fence is the point.
- **Ordinary SaaS configuration allows anything**, because nothing depends on
  reconstructing history.

This system is in the first category, and bookings snapshot the rate at
creation, so backdating cannot move money already committed. The only thing it
changes is the answer to *"what was the rate on 3 March"* — the question an
audit asks. It buys nothing operationally and costs reconstructability.

Kept forward-only. A correction path, if ever needed, follows the ledger's
existing philosophy: new offsetting records, never edits.

### 3. The resolver now falls back instead of throwing

**Decided by the maintainer**, against my initial recommendation. Implemented
with one refinement so the concern behind that recommendation is still met.

With no `CommissionRate` configured, `resolveCommissionRate()` returns a
synthetic record at **500 bps** — the same value `prisma/seed.js` writes, so a
seeded and an unseeded database price identically rather than diverging.

The fallback is **visible, not silent**:

| Property | Value | Why |
|---|---|---|
| `isDefault` | `true` | The admin endpoint returns it, so the UI can flag an unconfigured platform |
| `id` | `null` | Synthetic — never persisted, so an unconfigured platform stays distinguishable from a configured one |
| `setByUserId` | `null` | Nobody set it, so nobody is named |
| first use | logs a warning | The signal survives even if nobody looks at the screen |

A real record always reports `isDefault: false`.

This removes a real failure mode found by the isolation work below:
`GET /admin/config/commission` previously returned **500** on a platform with no
rate configured, taking the admin screen down at exactly the moment an admin
would be trying to fix it.

---

## Test isolation (option B, agreed at review)

### The problem

Two failures in #6 and #7 had the same shape: the code was correct and the test
was wrong, because every test file shared one database.

- #6 asserted "exactly one `SUPER_ADMIN`" and counted users created by the auth
  suite — found 3
- #7 asserted a prior rate of `500` and read a `700` written moments earlier

Both were fixed by scoping assertions, which measures the right thing but
depends on remembering to do it on every future issue. The stakes rise from
here: **#19's headline assertion is that a booking's ledger entries sum to
zero**, which is worthless if another suite can add rows to the same table. A
financial suite that fails intermittently is one people stop believing.

Three options were put to the maintainer; **B was chosen**.

### The implementation

`apps/backend/test/db.js`. Each test file gets **its own PostgreSQL schema**
inside the same database:

```js
const { prisma, hasDatabase } = require('./db')('auth');   // → schema test_auth
const { createApp } = require('../src/app');               // bound to it
```

`DATABASE_URL` is rewritten with `?schema=test_<name>` **before the Prisma
singleton is constructed**, so every module that later requires it — routes,
services, middleware — transparently uses that schema. `prisma db push` creates
and populates it; the migrations themselves are verified against a real database
in #4, so a throwaway schema does not need migration history.

The seed subprocess is handed the schema explicitly, since it runs as a separate
process and would otherwise seed the default schema.

### Proof that it works

The scoping workarounds added in #6 were **reverted to absolute, whole-table
assertions** — `exactly 1 SUPER_ADMIN`, `exactly 2 artists`, `exactly 1
commission rate` — and the suite still passes:

```
$ npm run test:backend
# tests 41  # pass 41  # fail 0  # skipped 0
real 0m12.1s
```

Those assertions failed before isolation. Zero scoping workarounds remain in
`seed.test.js`.

### What it does not fix, stated plainly

Isolation is **per file, not per test**. Cases within one file share a schema by
design, so #7's `before.rateBasisPoints` fix stays: that contamination came from
an earlier case in the *same* file, and per-file isolation does not address
ordering within a file.

Where a case genuinely needs an empty schema, the answer is now a separate file
— which is why `commissionDefault.test.js` exists rather than deleting rows
other cases depend on and hoping the ordering holds.

Cost: about 4 seconds across the suite for the per-file `db push`.

---

## #8 — feat(backend): versioned cancellation tier configuration

Branch `feat/8-cancellation-tiers`. Verified 2026-09-12.

```
$ npm run test:backend          (three consecutive runs)
# tests 54  # pass 54  # fail 0  # skipped 0
```

### `[x]` Submitting overlapping ranges returns 400 with a message naming the conflict

```
{"error":"Bands day 1 to 6 and day 5 and above overlap.
          A cancellation in that window would match two rules."}
```

**Both offending bands are named.** "Invalid tier set" tells an admin nothing
they can act on.

### `[x]` Submitting a set with a gap at days 3–4 returns 400 naming that window

```
{"error":"Days 3 to 4 are not covered by any band.
          A cancellation in that window would have no applicable rule."}
```

The uncovered window is computed and named, not merely detected. A single-day
gap is phrased in the singular — *"Day 1 is not covered"* — because a message
that reads as broken English gets trusted less than one that reads as written.

### `[x]` Submitting a row summing to 9500 bps returns 400

```
{"error":"day 1 and above: client refund 4000 + artist compensation 5500
          = 9500 basis points. They must sum to 10000."}
```

Shows both numbers and their sum, so the admin can see which one to move.

The two percentages divide the **booking total**. Platform commission applies to
the artist's share *afterwards* and is never carved out of this split —
conflating them silently changes what the client was shown (`docs/05` §5).

### `[x]` A set that does not cover day 0 is rejected

```
{"error":"Day 0 is not covered. The lowest band starts at day 1,
          so a booking cancelled on the event day has no applicable rule."}
```

### `[x]` A prior tier set remains queryable after a change

The second version in the test **restructures** the table — five bands instead
of four, adding a 14-day tier, which is exactly the change the issue says rows
must be addable for rather than merely editable.

After the change: the prior version still returns four rows, and its day-0 band
still reads `1500`, not the new `1000`. The resolver returns the new version.

### `[x]` A non-super-admin receives 403

`CLIENT`, `ARTIST` and `ADMIN` all rejected; no token gives `401`. `ADMIN` **can
read** the table — seeing it does not carry the risk of changing it.

### Additional guarantees

**The open-ended band is required, unique, and must be the top band.** Zero
open-ended bands means a cancellation made far in advance matches nothing; two
means it matches both. Both rejected with distinct messages.

**Rows are validated individually before the set is considered** — fractional
basis points, numeric strings, negative days, a band ending before it starts,
and an empty set each produce their own message.

**Every day from 0 to 400 resolves to exactly one band** in a saved set,
verified by iteration rather than inspection.

**The validator is pure** — no database, no clock — and is exercised directly as
well as through the route. #36 mirrors these rules client-side for immediate
feedback, but the server stays authoritative: a tier table with a gap must be
unsaveable regardless of which path the request arrives by.

**Changes require a written reason and are recorded in full.** The audit row
stores the whole resulting set, not merely that something changed.

---

## Test-suite defects found and fixed while building #8

The isolation work merged before this issue exposed three real problems. All
three produced *intermittent* failures — the kind that get rerun rather than
investigated.

### 1. Schemas persisted between runs

`db push` creates structure, not a clean slate. A file asserting "this schema
starts empty" passed the first time and failed every time after.

`test/db.js` now truncates every table in the schema before the file runs —
`TRUNCATE ... RESTART IDENTITY CASCADE`, so foreign keys do not dictate order
and sequences do not drift.

### 2. Connection-pool exhaustion looked like a deadlock

Prisma defaults to `cpus * 2 + 1` connections per client — 17 here. Nine test
files run in parallel, each with its own client, plus subprocesses: comfortably
past PostgreSQL's 100-connection ceiling.

The failure mode is genuinely misleading. An interactive transaction acquires a
connection, completes one statement, then waits forever for a second one the
pool cannot give it. It surfaces as `idle in transaction` followed by a
transaction timeout, which reads like a deadlock rather than exhaustion.

Test clients now cap `connection_limit=5`.

### 3. Two seed subprocesses could overlap on the same unique index

Diagnosed from `pg_stat_activity` and `pg_blocking_pids`:

```
1318 | idle in transaction | INSERT INTO "test_seed"."User" ...
1319 | active | wait=Lock/transactionid | INSERT INTO "test_seed"."User" ...
1319 <- blocked by 1318
```

One seed held the `User` unique index inside an open transaction while a second
blocked behind it, and both hit the timeout.

`prisma/seed.js` now exports `main()` and self-executes **only when run as a
script** (`require.main === module`). Tests call it in-process, against the
already-open client, which removes the second connection pool and the overlap by
construction — and is faster.

The command-line form the acceptance criterion actually names is still
exercised, once, at the end of the file with nothing else touching the schema.

The seed's interactive transaction budget was also raised from Prisma's 5s
default to 30s. That default is tuned for a request handler; a seed may run
against a managed database over the public internet during a deploy, and failing
halfway leaves a partially seeded state.

**Verified by three consecutive clean full-suite runs**, not one.

---

## #5 — chore(backend): Redis and BullMQ job infrastructure

Branch `feat/5-redis-bullmq`. Verified 2026-09-12.

```
$ npm run test:backend          (two consecutive runs)
# tests 59  # pass 59  # fail 0  # skipped 0
```

### `[x]` A job scheduled out executes at approximately the right time

Asserted in both directions: the job **does not run before** its delay elapses,
and then runs within tolerance. Checking only that it eventually ran would pass
even if delays were ignored entirely.

The delay is 2s rather than the issue's 10s. The property under test is that a
*delayed* job fires after its delay and not before, which does not depend on the
number being ten — and ten seconds of a test run is ten seconds of waiting.

### `[x]` A job that throws is retried per the configured backoff

Three attempts observed, numbered in order, the third succeeding.

**The backoff itself is asserted, not just the attempt count.** The first retry
must wait at least ~1s, and the second gap must exceed the first. Without that,
retries firing instantly would still pass a count-only assertion, and the
exponential policy would be decorative.

Exponential because the failures worth retrying are transient — a provider
timeout, a brief partition — and hammering a struggling dependency every second
makes its recovery slower.

### `[x]` A job failing all retries is visible in the dead-letter queue

A job set to fail more times than it has attempts lands in `dead-letter`
carrying the originating queue, the job name and data, `attemptsMade`, the
failure reason, and when it gave up.

The original also remains in the failed set: **the dead letter is a record, not
a relocation.** A job that vanishes without trace is indistinguishable from one
that never existed, and on this system the one that vanished might have been
releasing an artist's payment.

Nothing processes the dead-letter queue. It exists for a human, so retrying it
automatically would defeat the purpose.

### `[x]` Scheduled jobs survive a process restart

The critical property, and verified by **actually killing and starting
processes** rather than reasoning about Redis:

1. A delayed job is scheduled while **no worker exists at all**
2. Its state is confirmed as `delayed` — queued with nothing able to run it
3. `src/worker.js` is spawned as a **separate OS process**
4. That new process runs the job, and its stdout is checked for the marker

Also verified outside the suite, with the worker as a long-running service and
the job scheduled from a different process entirely:

```
$ npm run start:worker
[worker] listening on queues: maintenance
[echo] scheduled-from-api-process (job 1, attempt 1)
```

This is what makes auto-release survive a deploy.

### `[x]` The queue refuses to start without Redis configured

Throws rather than silently accepting jobs into nothing. A queue that appears to
work while dropping everything is worse than one that will not start.

### Valkey parity — checked rather than assumed

Render's Key Value runs **Valkey 8.1.4**, not Redis. Valkey is the fork that
followed Redis's licence change; it reports `redis_version:7.2.4` for
compatibility. "Compatible" and "identical" are not the same word, and BullMQ
leans on Lua scripts, so this was tested rather than reasoned about.

The full queue suite was run against both:

| Runtime | Result |
|---|---|
| Redis 8.0.5 (local dev) | 5 pass, 0 fail |
| **Valkey 8.1.4 (matches Render)** | **5 pass, 0 fail** |

Identical. The Valkey container is started with `--maxmemory-policy noeviction`
to match the deployed instance exactly.

### `maxmemory-policy` must be `noeviction`

Render defaults Key Value to `allkeys-lru`, and that default is correct **for a
cache**. This is not a cache.

Under an eviction policy Redis silently deletes least-recently-used keys when
memory fills. Those keys are queued jobs — a scheduled auto-release would
disappear with no error in any log, and an artist would not be paid until
someone noticed by hand. `noeviction` makes Redis return an error instead, which
is visible and fixable.

Set correctly on the deployed instance, and documented in `.env.example` beside
`REDIS_URL` so it is not lost.

### Architecture notes

**`src/worker.js` is a separate entry point** (`npm run start:worker`), built
now rather than later. Render's free web service sleeps when idle, and a
sleeping process runs no jobs — auto-release fires 48–72h after an event,
exactly when nobody is making requests. The cron-job.org keepalive covers this
for testing; production should run the worker as its own always-on service, and
that move is configuration rather than a rewrite **because the entry point
already exists**.

**Queue namespace is configurable** (`QUEUE_PREFIX`). Test files set their own,
isolating jobs the way `test/db.js` isolates schemas — without it one suite's
workers consume another's jobs, which is the flakiness class that cost real time
at #6, #7 and #8.

**Connections are capped deliberately.** The deployed instance allows 50 and
each Queue and Worker opens its own. The Postgres pool exhaustion found at #8
was the same mistake made once already.

**SIGTERM finishes in-flight jobs** rather than killing them. A job cut
mid-flight here may be one that has already instructed a money movement.

### `[!]` Executes at approximately the right time **on the deployed host**

**BLOCKED, and deliberately not unblocked by opening the instance.**

Render blocks external traffic to Key Value by default — a better posture than
the Postgres instance, which defaults to `0.0.0.0/0`. It matters more here: the
internal URL carries **no password**, since Internal Authentication is an
optional extra that is off. Exposing an unauthenticated Redis to the public
internet is among the most reliably exploited misconfigurations there is.

So this is verified **through the deployed application** instead: the API
schedules a job on Render, the worker consumes it over the internal network, and
execution appears in Render's logs. That exercises the real path rather than a
developer machine reaching in from outside, which is the better test regardless.

Requires `REDIS_URL` set on `o-artiste-api` from the Internal URL.

### Deploy fix: the Prisma client was never generated on Render

Found when the API redeployed after `REDIS_URL` was added. The build succeeded,
the service started, and then crashed:

```
Error: @prisma/client did not initialize yet.
Please run "prisma generate" and try to import it again.
    at Object.<anonymous> (/opt/render/project/src/apps/backend/src/lib/prisma.js:11:16)
    at Object.<anonymous> (/opt/render/project/src/apps/backend/src/routes/auth.js:7:18)
```

**Cause.** `npm install` runs at the repository root — correctly, since that is
where the lockfile and the `qs` override live — while the schema is at
`apps/backend/prisma/schema.prisma`. Prisma's implicit install hook does not
reliably find a schema inside a workspace, and a build cache that skips
lifecycle scripts removes even that chance.

Reproduced locally by simulating exactly that:

```
$ rm -rf node_modules/.prisma node_modules/@prisma/client
$ npm install --ignore-scripts        # as a cache would
  not generated
$ npm run build --workspace apps/backend
  CLIENT GENERATED
```

**Fix.** An explicit generate step rather than a reliance on implicit hooks:

- `apps/backend/package.json` gains `build: "prisma generate"` and a
  `postinstall` of the same, so local installs stay convenient
- the root gains `build: "npm run build --workspaces --if-present"`
- **Render's build command becomes
  `npm install && npm run build --workspace apps/backend`**

Workspace-scoped on purpose: the unscoped root `build` also compiles the Next.js
app, which the API host does not serve.

**Why it went unnoticed.** The deployed API kept answering `/health` throughout,
because Render leaves the previous working deploy serving when a new one fails
to boot. Every deploy since #9 merged — the first issue to require the Prisma
client at startup — had been failing silently behind a healthy-looking endpoint.

That is worth recording as a general lesson rather than a one-off: **a green
health check proves something is serving, not that the latest commit deployed.**
`/health` deliberately has no database dependency, which is right for liveness
and precisely why it could not have caught this.

Still outstanding on the same service: `NODE_VERSION` is unset, so Render runs
**Node 20.8.2** — below the `>=20.9.0` both workspaces declare in `engines`.
Render does not enforce `engines`, so it must be set explicitly.

### Deploy verified after the Prisma fix

Sequence, recorded because it took three attempts and each failure was a
different shape of the same mistake:

1. Build command was `npm install` — Prisma client never generated, service
   crashed on first database import
2. Build command corrected, but Render was checking out `6675d38`, a commit
   predating the `build` script — `Missing script: "build"`
3. Fix merged to `main`, redeployed, **working**

`NODE_VERSION=22` also took effect at step 2:

```
==> Requesting Node.js version 22
==> Using Node.js version 22.23.2 via environment variable NODE_VERSION
```

Previously 20.8.2, below the `>=20.9.0` both workspaces declare.

**The pattern, now three for three.** Render's `Missing script: "start"` at #2,
Vercel failing to detect Next.js at #3, and this. **Every deployment reads
`main`.** A fix that exists only on a branch cannot deploy, however correct the
dashboard is. Dashboard settings and code changes have to land together, and the
code has to land first.

Corollary already recorded above: a green `/health` proves something is serving,
not that the current commit deployed. From here, deploy verification checks the
**commit SHA** and exercises a route that touches a real dependency.

---

## #17 — feat(backend): EscrowPay API client

Branch `feat/17-escrowpay-client`. Verified 2026-09-12 against the live test book.

```
$ npm run test:backend
# tests 81  # pass 81  # fail 0  # skipped 0
```

Built against the contract in `docs/provider/ESCROWPAY-API-MAP.md`, which was
established from the provider's own OpenAPI document rather than the marketing
page — the four `/v1/escrows` calls the issue describes do not exist.

### `[x]` Each method verified against the EscrowPay sandbox

11 integration tests, all against the real API:

| Method | Endpoint | Verified |
|---|---|---|
| `credentialContext` | `GET /credential-context` | returns `environment: "test"` |
| `health` | `GET /health` | |
| `onboardParty` | `POST /parties/onboard` | identity verified, party active, identifier masked |
| `createPayoutAccount` | `POST /payout-accounts` | `status: verified`, account masked |
| `listBanks` | `GET /banks` | |
| `createEscrow` | `POST /transactions` | draft created with our policies |
| `getEscrow` | `GET /transactions/{id}` | |
| `release` | `POST /transactions/{id}/releases` | rejects cleanly on an unfunded escrow |
| `refund` | `POST /transactions/{id}/refunds` | rejects cleanly on an unfunded escrow |
| `estimateFees` | `POST /fees/estimates` | |

**The suite refuses to run against a non-test key.** Every call creates real
records; on a live book those would be real money. `isTestKey()` gates it and
the module throws rather than skipping quietly, so a misconfiguration is loud.

The created transaction was asserted field by field, because the defaults are
where the risk lives:

```
status              draft          activation is a separate step
amount_minor        20000000       kobo passes through unconverted
release_policy      manual_only    nothing releases unless we instruct it
refund_policy       manual_only
payout_preference   manual         never the default retain_in_wallet
payout_account_id   PAC_…          set explicitly
automatic_release_at   null        release timing is ours alone
marketplace_commission_bps  null   commission is computed and ledgered by us
```

The last two assert **absence**. They are the §5 and §6 decisions expressed as
tests, so a later change that starts delegating release timing or commission to
the provider fails here rather than being noticed in a reconciliation.

### `[x]` A repeated create with the same reference does not produce a duplicate

```
createEscrow({ reference: R, … })  → TXN_abc
createEscrow({ reference: R, … })  → TXN_abc   (same id)
```

The provider requires an `Idempotency-Key` header on every money-moving call and
we pass our self-generated `escrowReference` — never a random value, which on a
retry would defeat the entire mechanism. This is why the reference is ours
rather than the provider's (`docs/03` §3).

### `[x]` Signature verification rejects a tampered payload and accepts a valid one

11 unit tests, no network:

- A valid signature over the exact raw bytes is accepted
- **A tampered payload is rejected** — one byte changed, `TXN_123` → `TXN_999`,
  the field an attacker would most want to alter
- A signature made with the wrong secret is rejected
- **A replay outside the 300-second window is rejected**, while the signature
  itself is still cryptographically valid — a replay guard, not a correctness
  check. Just inside the window is accepted, so it is not simply refusing
  everything
- **A future timestamp is rejected too**, so clock skew forward is not a bypass
- **The previous secret is accepted during rotation.** The provider honours
  either for 24 hours; verifying against one would make every rotation an outage
- Malformed, missing and partial headers return a reason rather than throwing
- **A `v1` of the wrong length is rejected without throwing** — `timingSafeEqual`
  throws on a length mismatch, so a naive implementation turns a forged
  signature into a 500
- Comparison is constant-time

**The test that matters most:**

```js
// Exactly what express.json() would hand a handler: same data, different bytes.
const reserialised = Buffer.from(JSON.stringify(JSON.parse(RAW.toString())));
→ valid: false
```

This proves parsing and re-serialising breaks verification, which is what the
provider's guide warns about and what #2's raw-body exception exists to prevent.
The two issues now verify each other.

### `[x]` Request timeout is set below the host's request timeout

**15 seconds**, configurable via `ESCROWPAY_TIMEOUT_MS`.

#2 could not establish Render's figure — they publish none and community reports
range from 15s to 100s. 15s sits under the lowest, so the criterion is satisfied
**by construction rather than by measurement**. A REST call to create or release
an escrow has no business taking longer, and if it does, our timeout firing first
is the outcome we want because the idempotency key makes the retry safe.

Retries: network faults and 5xx only, twice, with exponential backoff. A 4xx is
our mistake and is never retried.

### `[x]` Provider errors carry diagnostics without leaking credentials

The provider uses two error shapes — `{"detail":{"code","message"}}` and
FastAPI's `{"detail":[{loc,msg}]}` — and neither matches ours, so the client
translates rather than passes through (`docs/02` §2).

The user-facing message stays generic; the provider's own wording, status,
code and `request_id` are attached to the error and logged:

```
[escrowpay] POST /payout-accounts → 409 payout_account_exists
            This bank account is already registered in this environment.
            (request_id 3c52c810-…)
```

Asserted that a serialised error never contains the API key. The key travels in
a header and axios does not include headers in error messages.

### Out of scope, per the issue

No business logic, no ledger writes, no state transitions. The module talks to
the provider and nothing else — which is what makes #26's rule enforceable: that
only `escrowService.js` may decide to release or refund is meaningless if this
client also decides *when*.

### Findings for later issues

**Identities are unique per environment.** Re-onboarding the same NIN returns
`409 identity_already_exists`. This is the provider enforcing #10's *"a returning
user is never re-charged or re-checked"* — but #10 must treat that 409 as
**success plus a lookup**, not a failure, or a returning user is locked out.

**Bank accounts are unique per environment too** — `409 payout_account_exists`.
#11 must handle an artist re-submitting the same account.

**The fee estimate confirms the published schedule.** For ₦200,000:

```json
{"amount_minor":200000,"currency":"NGN","fee_type":"escrow_service",
 "payer":"payer","timing":"at_funding","transaction_amount_minor":20000000}
```

200,000 kobo = **₦2,000**, exactly the documented cap. It also reveals
`payer` and `timing: at_funding` — who bears it and when — which #14 should read
rather than assume.

### Deviation from the plan

`ESCROWPAY_AMOUNT_UNIT` was planned as a configurable conversion point while the
unit was unknown. It is **not built**: `amount_minor` is already kobo, so kobo
passes through untouched and a conversion layer would be a place for a bug to
live with nothing to gain.

---

## #10 — feat(backend): identity verification (NIN/BVN)

Branch `feat/10-identity-verification`. Verified 2026-09-12, against stubs for
the failure modes and against the live sandbox for the happy path.

```
$ npm run test:backend
# tests 90  # pass 90  # fail 0  # skipped 0
```

### `[x]` Re-running verification for an already-verified user makes no provider call

Asserted by replacing the provider client with a stub that **throws if called at
all**, then verifying twice:

```
first call  → VERIFIED, cached: false, provider called
second call → VERIFIED, cached: true,  provider NOT called
```

The ₦50 is once per person for life, so a second call must not reach the
provider at all — checking status first is what guarantees that. The provider
also enforces it independently (see the 409 case below), but relying on their
rejection would mean making the call.

Confirmed against the live sandbox too:

```
status           : VERIFIED cached: false
platform cost    : 5000 kobo (IDENTITY_VERIFICATION)
2nd call cached  : true
costs after 2nd  : 1
```

### `[x]` A provider timeout leaves the user in a retryable state

```
provider throws provider_unreachable
  → 503 "We could not reach our verification partner. Please try again…"
  → verificationStatus = RETRYABLE_FAILURE   (not REJECTED)
  → getStatus().retryable = true
  → a later attempt succeeds
```

The retry is exercised, not just the flag — the state really is recoverable. A
network blip must never permanently lock out a real user.

### `[x]` The result is stored, never the identifier

```
verificationReference : IDN_85833e6046ae44ddb5ef477ef44f4b87
escrowPartyId         : PAR_694b24e9a795438eb67a4b3c06fc6f77
raw NIN stored?       : no
```

Asserted by serialising the whole user row and searching for the submitted
number. Retaining a NIN or BVN is NDPR exposure with no operational benefit, and
the provider masks it on their side too — so neither party holds it.

### `[x]` The ₦50 is recorded as a platform cost, outside per-booking economics

A new `PlatformCost` model, **deliberately not a `LedgerEntry`**. Every ledger
row references its booking (`docs/01` §5), and this cost is charged once per
person for life. Forcing it into the booking ledger would mean either a nullable
booking — weakening the model that makes a booking reconcile to zero — or
attaching a lifetime cost to whichever booking happened to be first.

Asserted that `ledgerEntry.count() === 0` after verification.

`reference` is unique on the provider's identity id, so a retry cannot charge
the same check twice.

### Four provider outcomes, four different reactions

The substance of this issue is refusing to collapse these together:

| Provider result | Status | Response | Why |
|---|---|---|---|
| success | `VERIFIED` | 201 | billable |
| `409 identity_already_exists` | `VERIFIED` | 201 | **not billable** |
| `identity_verification_failed` | `REJECTED` | 403 | terminal without support |
| 4xx (e.g. malformed email) | `UNVERIFIED` | 400 | fixable by the user |
| timeout / 5xx | `RETRYABLE_FAILURE` | 503 | fixable by waiting |

**The 409 case was found while building #17.** Identities are unique per
environment, so a user whose identity was onboarded before gets a 409. Treating
that as an error would lock out precisely the returning users the caching exists
to serve — so it is recorded as success, and deliberately not billed, because
the provider does not charge for an existing identity.

**The 4xx case was a real bug, found by running against the live sandbox.** A
malformed email returns `422`, and the original catch-all reported it as *"we
could not reach our verification partner — please try again in a few minutes."*
That is actively misleading: nothing is unreachable, and retrying unchanged
fails identically forever. A 4xx now returns `400` with copy naming what to
check, and leaves the user `UNVERIFIED` rather than `RETRYABLE_FAILURE` —
nothing is broken, the details simply need correcting. Regression test added.

A rejected identity is **not** retried against the provider on resubmission, and
no cost is incurred for a failed check.

### `[~]` An unverified client receives 403 on `POST /bookings`

### `[~]` An unverified artist cannot accept a booking

**Deferred to #15 and #18**, as anticipated at planning time — neither endpoint
exists yet. The `requireVerified` middleware was written at #9 and is ready to
mount; the criteria are verified where those routes are built, not asserted
here on routes that do not exist.

### Schema additions

| Field | Why |
|---|---|
| `User.escrowPartyId` | The `PAR_…` this user transacts as. Created once at verification and reused for every booking — it is what `payer.party_id` and `beneficiary.party_id` reference at escrow creation. Unique. |
| `User.verificationFailureReason` | Distinguishes *why* an attempt failed, which is what separates a retryable blip from a rejection |
| `User.verificationAttempts`, `lastVerificationAttemptAt` | Attempt history, for support and for #41's rate-limiting review |
| `PlatformCost` | Costs belonging to no single booking |

Migration `20260912170420_identity_verification` applied locally and to the
deployed database — **17 tables** there now.

A first attempt left an empty migration directory behind, which then applied as
a no-op migration. Removed, and the history replayed from scratch with
`migrate reset` to confirm all three migrations apply cleanly in order.

---

# Phase 2 — Artists, Booking & Escrow Funding

## #11 — feat(backend): artist profile and rate card

Branch `feat/11-artist-profile`, stacked on `feat/10-identity-verification`.
Verified 2026-09-12.

```
$ npm run test:backend          (eight consecutive runs)
# tests 97  # pass 97  # fail 0  # skipped 0
```

### `[x]` A rate of ₦19,999 or ₦3,000,001 returns 400 naming the permitted range

```
$ curl -X PUT /artists/:id -d '{"baseRateKobo":1999900}'
{"error":"Your rate must be between ₦20,000 and ₦3,000,000.
          Bookings outside that range cannot be processed by our payment partner."}
400

$ curl -X PUT /artists/:id -d '{"baseRateKobo":300000100}'
400  (same message)
```

**The message names both limits**, because "invalid rate" leaves an artist
guessing at a bound they have no way to discover. It also says *why* — the bound
is the provider's transaction range, not a policy we invented.

Tested at the boundary rather than with wild values: one kobo under the floor,
one kobo over the ceiling, and both bounds themselves **accepted**, so the range
is inclusive and the check is not simply refusing everything.

The bound is enforced **at profile level, not at checkout**. The artist finds
out while editing their own rate, rather than a client discovering it at the
point of payment.

### `[x]` An artist editing another artist's profile receives 403

```
$ curl -X PUT /artists/<someone-else's-id> -H "Authorization: Bearer <other artist>"
{"error":"You can only edit your own profile."}  403
```

Also asserted: **nothing was written**. A 403 that still mutated would be worse
than no check at all. No token gives 401, and a `CLIENT` token gives 403 —
the endpoint is role-guarded as well as ownership-guarded.

Ownership is resolved from the authenticated user, so there is no artist id in
the request to tamper with.

### `[x]` The rate is stored and returned as a kobo integer, never a formatted string

```json
{"baseRateKobo": 25000000}
```

Asserted to be a `number`, an integer, and that the serialised response contains
**no `₦` and no thousands separators**. Formatting is the web app's job via
`formatNaira()`; an API that returns `"₦250,000"` has made the value unusable
for arithmetic and invented a second representation of money.

### Additional behaviour

**Profile completeness is derived, not declared.** `profileComplete` is
recomputed on every update from `stageName`, `category`, `location` and
`baseRateKobo`. Clearing any one of them makes the profile incomplete again —
asserted by setting the rate to `null` and watching `listable` flip to false.

**Listability requires all three conditions**, each tested independently:
complete profile, `VERIFIED` user, and standing not `SUSPENDED`/`REMOVED`. A
suspended artist appearing in a listing even briefly is a trust failure, so the
filter is expressed as a Prisma `where` fragment for #12 to apply **at the query
level** rather than filtering after fetching.

`GET /me/artist-profile` returns `listable` and `verificationStatus` alongside
the profile, so an artist is told plainly why they are not yet discoverable
rather than left to wonder why nobody can find them.

### Added outside the issue's stated scope

- `src/lib/money.js` — `formatNairaForMessage()`, used **only** in error copy
  that has to name a limit. Deliberately not a general formatter: duplicating
  the web app's `formatNaira()` would create a second place where money changes
  representation, and every such place is somewhere a rounding bug can live.
  *"Your rate must be between 2000000 and 300000000"* is not a sentence anyone
  can act on, which is the one case that justifies it.
- `MIN_TRANSACTION_KOBO` / `MAX_TRANSACTION_KOBO` moved into
  `lib/escrowpay.js`, since they are provider facts rather than our policy, and
  #15 will need the same numbers when validating a booking amount.

### Open item left alone, deliberately

`docs/00` §11 carries an unresolved question about bookings above ₦3,000,000.
Per the issue's technical note, **the hard rejection stands and no workaround
path was built.** A partial-payment or split-booking mechanism invented now
would be a guess at a commercial answer that has not been given.

### A flaky sandbox suite, and two wrong diagnoses before the right one

The first full run after this issue showed **4 failures in `escrowpaySandbox`**,
then passed on a re-run. Intermittent, at roughly one run in three. That is the
worst failure mode for a financial suite — the kind that gets re-run rather than
investigated, until nobody believes a red result.

Three diagnoses, two of them wrong:

1. **Wrong — provider rate limiting under parallel load.** Plausible, and it
   explained the intermittency, but the suite passed in isolation for reasons
   that had nothing to do with concurrency.
2. **Wrong — random account numbers colliding.** `409 payout_account_exists`
   *was* occurring, and a retry-on-collision helper was added. It reduced the
   rate but did not remove it, which should have been the clue that it was a
   second symptom rather than the cause.
3. **Right, and only after measuring instead of guessing.** The account was
   being created with `status: "rejected"` and
   `rejection_reason: "destination_invalid"`. Registering ten accounts with
   final digits 0-9 gave the rule directly:

```
last digit 0  → rejected (destination_invalid)
last digit 1-9 → verified
```

**Account numbers ending in `0` are rejected.** My generator had been "fixed" to
produce even final digits — on the assumption that payout accounts followed the
same even/odd convention as identity fixtures — which put `0` in one slot of
five and produced almost exactly the observed failure rate.

The two fixtures do **not** share a convention: identities verify on an even
final digit, payout accounts verify on anything except `0`. Assuming otherwise
cost two rounds of wrong fixes.

Verified across **eight consecutive full-suite runs, all clean**. One green run
would not have distinguished a fix from luck at a one-in-three failure rate.

The `payout_account_exists` retry was kept — that collision is real, just not
the cause — and the rule is documented in the test rather than left as a magic
constant.

### Noted for a later issue, not silently absorbed

#17 established that an artist needs a **payout account** registered before any
release can reach them, and that bank accounts are unique per environment.
That is not in #11's stated scope — its field list is explicit — so it has not
been added here. It needs a home before #26 executes a release; raised rather
than folded in.

---

## #12 — feat(backend): artist listing and detail endpoints

Branch `feat/12-artist-listing`. Verified 2026-09-12.

```
$ npm run test:backend
# tests 104  # pass 104  # fail 0  # skipped 0
```

### `[x]` `curl <backend>/artists` returns 200 with a paginated payload

```
$ curl localhost:4000/artists          # no Authorization header
{"artists":[
  {"id":"cmtymgun7…","stageName":"DJ Ekene","category":"DJ","location":"Abuja",
   "baseRateKobo":5000000,"cancellationRate":null},
  {"id":"cmtymgun2…","stageName":"Tolu Live","category":"Afrobeats","location":"Lagos",
   "baseRateKobo":25000000,"cancellationRate":null}],
 "pagination":{"page":1,"limit":20,"total":2,"totalPages":1}}
200
```

Unauthenticated, because discovery is public.

### `[x]` A suspended artist does not appear in the listing and returns 404 on detail

```
$ UPDATE "User" SET "accountStanding"='SUSPENDED' …
$ curl localhost:4000/artists
listed: DJ Ekene | total: 1

$ curl localhost:4000/artists/<suspended id>
{"error":"Artist not found."}  404
```

The `total` drops too — the exclusion happens **at the query level**, not by
filtering a fetched page, so a suspended artist cannot appear even transiently
and cannot skew a count. Filtering after fetching would also corrupt pagination:
a page of 20 could return 19.

**404, not 403.** Distinguishing them would confirm the account exists, which is
information a suspended artist's would-be clients have no business receiving.

Unverified, `REMOVED` and incomplete-profile artists are excluded by the same
filter, each asserted independently.

### `[x]` `cancellationRate` is present and returns `null`, not omitted

Asserted with `'cancellationRate' in subject` rather than a truthiness check —
**the field existing while being null is the contract**, and a truthiness test
would pass just as happily if the field were missing.

Checked on both the listing and the detail endpoint.

It returns `null` today and is populated in #35. Adding it later would mean
revisiting the frontend; establishing the contract now forces #13 to handle the
below-threshold case from the start rather than bolting it on afterwards. `null`
means *"not enough bookings to say anything"*, and the UI renders **nothing** —
not `0%`, which implies a perfect record that has not been earned, and not
`N/A`, which draws attention to an absence and reads as a warning (`docs/06` §4).

### Additional behaviour

**Filtering** by `category` and `location`, case-insensitively, so a filter chip
need not match storage casing. A filter matching nothing returns an empty array
with `total: 0` and `totalPages: 1` — an empty page, not an error, which is what
#13 renders its empty state from.

**Pagination is bounded.** `limit` is capped at 100 and `page` floors at 1, so
`?limit=9999&page=-5` clamps rather than erroring or returning the whole table.
Asserted that consecutive pages do not overlap, and that a page beyond the end
is empty rather than an error.

**The public shape is an allowlist.** Asserted that `userId`, `passwordHash`,
`email`, `phone` and `profileComplete` appear nowhere in a public payload — a
column added later is private by default rather than exposed until someone
notices. `baseRateKobo` stays a kobo integer with no `₦` anywhere; formatting is
the web app's job.

---

## #13 — feat(web): discovery grid and artist profile page

Branch `feat/13-discovery-grid`. Verified 2026-09-12 against both servers
running, by asserting on the **rendered DOM** rather than on component code.

### `[x]` Rates display as `₦200,000`, never as raw kobo

```
$ curl localhost:3100/
rates rendered : ₦250,000 ₦50,000
raw kobo leak? : 0 occurrences

$ curl localhost:3100/artists/<id>
rate shown     : ₦250,000
```

Searched the HTML for the raw kobo values (`25000000`, `5000000`) as well as
checking the formatted output — a page can show `₦250,000` and still leak the
integer in a data attribute.

### `[x]` An artist with `cancellationRate: null` shows no stat element in the DOM

```
cancellation stat : 0 element(s)
the words N/A     : 0
a bare 0%         : 0
```

`CancellationRate` returns `null` when the rate is null, so **no element is
emitted at all** — nothing to style, space, or accidentally reveal. Checked for
`N/A`, `No data` and `0%` explicitly, because each is a plausible "helpful"
addition that would be wrong: `0%` implies a perfect record that has not been
earned, and `N/A` draws attention to an absence and reads as a warning. An
artist with two completed bookings should look neutral, because they are
(`docs/06` §4).

### `[x]` An artist with a rate shows it above the booking CTA, not below the fold

Proven by **byte position in the rendered HTML**, with the API temporarily
stubbed to return a rate (reverted immediately afterwards — the committed
backend still returns `null`):

```
stat byte 18153 | CTA byte 18546   →  stat ABOVE the CTA ✓
```

The value renders as `children: [12, "%"]` — React splits the text nodes, which
is why a naive `grep '12%'` finds nothing and the element check is the reliable
assertion.

Position is the whole point of the stat: it exists so a client can weigh
reliability *before* committing, which requires seeing it before the decision
rather than in a footer or on a review page afterwards.

### `[x]` Empty filter results show a readable empty state, not a blank page

```
$ curl 'localhost:3100/?category=Polka'
empty-state element : 1
"No Polka artists yet."
see everyone link   : 1
```

The message names the filter and offers the way out. An empty result is a normal
outcome, not an error.

### A suspended artist renders a readable page

```
$ curl localhost:3100/artists/<suspended id>
"This artist is not available."
status codes shown : 0
```

No status code or stack trace reaches the user (`docs/02` §2).

### `[!]` Known limitation: the not-found page returns HTTP 200

**Two fixes attempted, neither worked.** Recorded with what was actually tried,
so #39 does not repeat it.

Confirmed in a **production build**, not just dev: an unknown or suspended
artist renders the correct not-found page but with a `200` status rather than
`404`.

The cause is `loading.tsx` on the detail route. It creates a Suspense boundary,
so Next streams the shell — and the status line — before `notFound()` is
reached. Once streaming has begun the status cannot be changed.

**Kept the loading state.** #13 requires *"loading and empty states for both
views"*, and the user-facing behaviour is correct either way: the page is
readable and exposes no status code. What is affected is machine consumers —
a crawler would keep a suspended artist's URL indexed.

**Attempt 1 — resolve the artist in `generateMetadata`.** It runs before the
page component, so `notFound()` there should precede streaming. Verified in a
production build: **still 200.** The call was kept anyway, because it is the
right place to resolve the artist and it gives real page titles
(`<title>DJ Ekene — Artist Escrow</title>`), with `getArtist` wrapped in React's
`cache()` so the page component reuses the same request rather than doubling
API traffic.

**Attempt 2 — remove the Suspense boundary** by deleting `loading.tsx` from the
route. Inconclusive: the test run was interrupted before producing a result, and
it trades away a loading state this issue explicitly requires.

**Left as is, deliberately.** The user-facing behaviour is already correct — the
page is readable and exposes no status code. What is affected is machine
consumers: a crawler would keep a suspended artist's URL indexed. That is worth
fixing, but not worth further time during a feature issue.

Carried to #39, which owns user-facing failure handling across all three
portals. The remaining avenues are a route handler or proxy that resolves the
artist before the page renders at all, or `dynamic = 'force-dynamic'` being the
cause rather than the Suspense boundary — untested.

### Removed

`app/backend-status.tsx`, the #3 bootstrap probe that called `/health` from the
browser. It existed to prove the cross-origin path before any real page did.
The grid now exercises the same path with real data, so the probe is redundant.

---

## #14 — feat(backend): fee computation service

Branch `feat/14-fee-service`. Verified 2026-09-12.

```
$ node --test test/feeService.test.js
# tests 17  # pass 17  # fail 0
```

Pure: no database, no network, no clock. Asserted by reading the module's own
source and checking it contains no `require(`, `prisma`, `axios`, `Date.now` or
`new Date` — so purity is enforced rather than merely intended, and #26 and #27
can call it instead of reimplementing any of it.

### `[x]` A ₦200,000 booking at 5% yields an artist net of ₦187,930

```
money-in    200,000 kobo   (capped at ₦2,000)
commission  1,000,000      (5% of ₦200,000)
money-out   7,000          (payout above ₦50,000)
artist net  18,793,000     = ₦187,930
```

The figure #26 will be held to.

### `[x]` Unit tests at both sides of each boundary

`₦249,999 / ₦250,000 / ₦250,001` and `₦49,999 / ₦50,000 / ₦50,001`, as the
issue lists — **plus the boundary the issue's list misses entirely.**

**The ₦2,000 cap starts binding at ~₦126,667, not ₦250,000.** That is where
`1.5% + ₦100` first exceeds ₦2,000. Below it the percentage governs and rounding
is live; above it the fee is a flat constant. Testing only the ₦250,000 edge
would never exercise the percentage region at all:

```
₦126,666 → 199,999   percentage governs
₦126,667 → 200,000   floors to exactly the cap
₦126,668 → 200,000   capped
```

**#14's technical note is wrong about the curve.** It calls the schedule
non-monotonic around ₦250,000. It is not: ₦2,000 is precisely 0.8% of ₦250,000,
so the two rules coincide there and the schedule is *continuous* — ₦260,000
costs ₦2,080, an increase. Asserted directly. The tests the issue asks for are
still worth having; only the stated reason was wrong. Recorded in `docs/05` §1.

### `[x]` For every tested input, the parts sum to the total exactly

The assertion that catches the widest class of financial bug. **16 amounts × 8
commission rates**, including deliberately awkward values (`2,000,033`,
`2,000,077`, `12,345,678`, `99,999,999`) chosen to produce fractional
commissions:

```js
commission + moneyIn + moneyOut + artistNet === amountKobo   // every case
```

Every figure is also asserted to be an integer.

### `[x]` A fractional commission assigns the remainder per the documented rule

2,000,033 kobo at 5% = 100,001.65 → **floors to 100,001**, not 100,002. The
0.65 kobo is absorbed by the artist, because the artist's net is computed as
`total − everything else` rather than from its own percentage.

That is R2 (`docs/05` §4): **the last share in any split is the residual.** The
parts sum by construction rather than by luck. Computing both sides of a
7000/3000 split from their own basis points is exactly what loses a kobo.

### Cross-checked against the provider's own estimator

Our arithmetic is not merely internally consistent — it agrees with EscrowPay
to the kobo at every boundary, via `POST /fees/estimates`:

| Amount | Ours | Provider |
|---|---|---|
| ₦20,000 | 40,000 | 40,000 |
| ₦50,000 | 85,000 | 85,000 |
| **₦126,667** | 200,000 | 200,000 |
| ₦200,000 | 200,000 | 200,000 |
| ₦250,000 | 200,000 | 200,000 |
| ₦260,000 | 208,000 | 208,000 |
| ₦3,000,000 | 2,400,000 | 2,400,000 |

Seven for seven. This is why #17 kept their fee endpoints: their numbers are
facts to read, and now the published schedule is confirmed rather than trusted.

### Finding: the ₦0 refund floor is unreachable with the default tiers

Measured rather than assumed, and it changes what #30 must handle.

The floor triggers only when the client's share is smaller than the escrow fees.
On the **smallest booking the provider accepts** (₦20,000), fees are ₦440 —
while even the harshest default band returns the client ₦3,000:

```
day-of    share 300,000  fees 44,000  refund 256,000
1-2 days  share 800,000  fees 44,000  refund 756,000
```

An order of magnitude apart. My first version of this test asserted the floor
fired on a day-of cancellation of a minimum booking; the arithmetic says
otherwise, and the test was wrong rather than the code.

**It is reachable under a tier set an admin could create.** #8 permits any bps
split, so a 1% refund band gives a ₦200 share against ₦440 of fees → **₦0
refund, ₦240 unrecovered**. Both cases are now tested: that the default set
never floors, and that a plausible custom set does.

The shortfall is reported rather than hidden, and not chased — building
collection logic for a sub-₦2,000 gap costs more than the gap. It must be shown
before the client commits (#30), not discovered afterwards.

### Fee-bearer resolution

| Outcome | Bearer | Behaviour |
|---|---|---|
| Completes | Artist | commission + both escrow fees from the payout |
| Client cancels | Client | fees from the client's share only; the artist's compensation is touched by commission alone |
| Artist cancels | Artist | client refunded **100%**, fees fronted by the platform as a `FeeLiability` |

The artist's compensation on a client cancellation is deliberately untouched by
fees: they have already lost a date they cannot refill, and deducting a flat
processing cost from a reduced payment would penalise them twice for someone
else's decision.

### Open item, implemented as a flag

**Whether a refund leg incurs the money-out fee is unconfirmed** (`docs/00` §11).
`REFUND_INCURS_MONEY_OUT` defaults to **charged** — the conservative reading. If
we assumed it were free and it is not, every refund would be short by ₦40–₦70
and the platform would silently absorb it. Tested in both positions, and the
client is made whole either way: the flag only moves who bears a cost.
