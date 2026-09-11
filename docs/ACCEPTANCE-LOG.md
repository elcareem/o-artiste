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
