# Deployment Checklist

External services this project depends on, what each one gates, and the environment variables it produces.

Nothing here can be completed from the development machine. Each item is owned by the repository maintainer and blocks the acceptance criteria named against it.

Status: `☐` not started · `◐` in progress · `☑` done

---

## #1 — GitHub repository

**Status:** ☐

- [ ] Repository created and pushed to `main`
- [ ] Branch protection on `main`:
  - [ ] Require a pull request before merging
  - [ ] Required approvals: **0** — see note
  - [ ] Do **not** require code owner review
  - [ ] Dismiss stale approvals on new commits
  - [ ] Block direct pushes to `main`

**Approvals note.** #1 specifies 1 approval. GitHub does not let a PR author
approve their own pull request, so on a single-maintainer project that blocks
every merge. Set to 0 for now — the PR requirement and the direct-push block
still deliver the intent — and raise to 1 as soon as a second collaborator
exists. Recorded in `docs/ACCEPTANCE-LOG.md` as a deliberate deviation.

**Note:** `gh` is not installed on this machine. Either install and authenticate it (`sudo apt install gh && gh auth login`) so branch protection can be applied via `gh api`, or create the repository and apply protection in the browser and supply the remote URL.

**Gates:** #1 acceptance — "Repo is pushed with a clean `git status`", "Branch protection is active on `main`".

---

## #2 — Backend host (Render)

**Status:** ☑ live at **https://o-artiste-api.onrender.com**

- [x] Web service created — `o-artiste-api`, region Ohio (US East)
- [x] **Root Directory blank** (repository root)
- [x] **Build `npm install && npm run build --workspace apps/backend`**
- [x] Start `npm run start --workspace apps/backend`

> **The backend is TypeScript, and neither command changes.** Node 22 strips
> types at runtime (`process.features.typescript === 'strip'`), so `npm start`
> runs `node src/index.ts` directly — there is no build output and no
> transpiler on the deploy path.
>
> **`tsc` is deliberately NOT part of the build.** It is a devDependency, and a
> host that omits devDependencies would fail a build that needed it — for no
> gain, since the runtime never uses it. The type check is its own gate:
> `npm run typecheck`, run alongside `npm run check:rules` before every commit.
>
> This requires **Node 22.18 or newer** (type stripping is off by default
> before that). `NODE_VERSION=22` is already set, and `engines.node` is
> `>=20.9.0` — tightened to `>=22.18.0` for the backend.

**The build command must include `npm run build`.** `npm install` alone does not
generate the Prisma client here: the install runs at the repository root while
the schema lives at `apps/backend/prisma/schema.prisma`, and Prisma's implicit
install hook does not reliably locate a schema inside a workspace — especially
when a build cache skips lifecycle scripts. Without it the service installs
cleanly, starts, and then crashes the moment a route requires the client:

```
Error: @prisma/client did not initialize yet.
Please run "prisma generate" and try to import it again.
```

Scoped to `--workspace apps/backend` deliberately: the unscoped root `build`
would also compile the Next.js app, which this host does not serve.
- [x] Health Check Path `/health`
- [x] Auto-Deploy: On Commit
- [ ] `NODE_VERSION` = `22` — **still running 20.8.2**, below the `>=20.9.0`
      the workspaces declare in `engines`. Render does not enforce `engines`, so
      this has to be set explicitly.
- [x] `WEB_ORIGIN` = `https://o-artiste-web.vercel.app` (set at #3)

**Root Directory must stay blank.** This is an npm workspaces monorepo: the
lockfile and the `overrides` block that pins `qs` to a non-vulnerable version
both live at the repository root. Setting Root Directory to `apps/backend` makes
Render install from that folder alone, silently discarding the override and
reinstating the advisories closed in #2.

Verified live:

```
$ curl -sS -i https://o-artiste-api.onrender.com/health
HTTP/2 200
content-type: application/json; charset=utf-8
access-control-allow-origin: http://localhost:3000
x-render-origin-server: Render

{"status":"ok"}
```

### The two values #2 requires recording

| Value | Answer |
|---|---|
| **Does the instance sleep when idle?** | **Yes** — free plan. Render's own banner: *"Your free instance will spin down with inactivity, which can delay requests by 50 seconds or more."* |
| **Default request timeout** | **Not established.** See below. |

**Idle behaviour — consequence for #5 and #25.** A sleeping instance cannot run
BullMQ workers. Auto-release fires 48–72h after an event, precisely when nobody
is making requests and therefore precisely when a free instance is asleep — an
artist would not be paid until someone happened to wake the service. #5's
criteria ("executes at approximately the right time... on the deployed host",
"scheduled jobs survive a process restart") cannot pass on this plan.

**Resolved for the build, by an external keepalive.** A cron-job.org job pings
`/health` every 10 minutes, which keeps the instance from ever spinning down.
Ten minutes rather than fifteen, because Render's idle window is ~15 minutes and
a ping at exactly that interval races the thing it exists to prevent.

`/health` is the right target for it: no database or Redis dependency, so it
stays cheap and answers even when a dependency is down.

That removes the blocker for #5 and #25 rather than deferring it — the worker
process stays alive, so scheduled jobs fire on time. **This is a testing
arrangement**, accepted deliberately:

- The free tier allows 750 instance-hours a month; one service kept awake
  around the clock uses roughly 730, leaving no room for a second free service.
- A production deployment should use a paid instance, and should run the worker
  as its own always-on service. The separate worker entry point is being built
  either way, so that move is configuration, not a rewrite.
- Revisit at #41, which asks for every launch risk to be closed or explicitly
  accepted in writing. This one is accepted for testing and **not** carried into
  production.

**Request timeout — designed around rather than measured.** Render does not
document a single figure, and community reports range from 15s to 100s across
different years. Measuring it would mean deploying a deliberately slow endpoint,
which is not worth doing.

Resolution: at #17 the EscrowPay client timeout is set to **15 seconds or less**,
which sits below the *lowest* figure Render has ever been reported to use. That
removes the dependency on knowing the exact number, and satisfies #17's
criterion by construction rather than by measurement. A simple REST call to
create or release an escrow has no business taking longer than that; if it does,
our own timeout firing first is what we want, because the self-generated
reference (`docs/03-ESCROW-FLOW.md` §3) makes the retry safe.

**Gates:** #2 — satisfied. Feeds #5 (worker hosting) and #17 (client timeout).

---

## #3 — Web host (Vercel)

**Status:** ☑ live at **https://o-artiste-web.vercel.app**

- [x] Project `o-artiste-web` created with **root directory `apps/web`**
- [x] Preset Next.js, all build/output/install overrides left OFF
- [x] `NEXT_PUBLIC_API_URL` = `https://o-artiste-api.onrender.com`
- [x] Deployed and calling the backend cross-origin successfully

**Root directory is the opposite of Render's, on purpose.** Vercel takes
`apps/web` and hoists the workspace itself, installing from the repository root
(`npm install --prefix=../..`). Render takes a **blank** root directory, because
pointing it at `apps/backend` would install from there alone and discard the
root lockfile and the `qs` override. Same monorepo, opposite settings, same
underlying requirement: install at the root.

**Never deploy the backend to Vercel.** It is serverless and cannot run the
BullMQ workers #25 depends on, and a second public API URL is a webhook hazard —
at #17 exactly one URL is registered with EscrowPay, and a webhook reaching the
wrong instance is the duplicate-processing case `docs/03-ESCROW-FLOW.md` §6
calls the highest-severity bug class in the system.

`NEXT_PUBLIC_` values are embedded in the browser bundle at build time. They are
not secret and cannot be, so do not mark them sensitive on Vercel — that only
prevents reading the value back when debugging. Real secrets (`JWT_SECRET`,
`ESCROWPAY_API_KEY`, the webhook signing secret) live on Render and never carry
a `NEXT_PUBLIC_` prefix.

**Gates:** #3 — satisfied.

---

## #4 — Managed Postgres

**Status:** ☑ provisioned, migrated, and wired to the API

- [x] Instance provisioned — `o-artiste-db`, PostgreSQL 16, Ohio
- [x] Migration applied against the deployed database (16 tables verified)
- [x] `DATABASE_URL` set on `o-artiste-api` from the **Internal** string

> **Free-tier testing caveat.** Render deletes free PostgreSQL instances after
> 30 days. If the build runs past a month the database disappears along with its
> seed data. Not fatal by design — migrations are version-controlled and #6's
> seed script is idempotent, so the state is reproducible with two commands. Do
> not put anything in it that cannot be regenerated.

- [ ] Instance provisioned (Render → New → PostgreSQL, **same region as the web
      service**, Ohio)
- [ ] `DATABASE_URL` set on the `o-artiste-api` service — use the **Internal**
      connection string, not the external one
- [x] `npx prisma migrate deploy` run **against the deployed database**, not only locally — now part of the build, so every deploy applies what is pending

### How the migration is applied

**Automatically, as part of the deploy.** The backend's `build` script is
`prisma migrate deploy && prisma generate`, so Render applies every committed
migration before the new code starts.

This is not a convenience. Migrations were previously applied by hand from a
laptop while the build ran `prisma generate` alone, which meant any pull request
carrying a migration would deploy code selecting columns the database did not
have — and the first symptom would be every read of that table failing in
production. Found at #24, whose migration was sitting unapplied against a
deployed API that was about to be given code that needed it.

`migrate deploy` only applies what is already committed. It never generates a
migration and never resets, which is the only behaviour that should touch an
instance holding real data — `migrate dev` can do both and must never run
against one.

It is idempotent: a deploy with nothing pending prints `No pending migrations to
apply` and moves on. Verified by applying all four migrations to an empty schema
and then running it again.

> **A destructive migration must not ride in on this.** Dropping or renaming a
> column now happens automatically, before the code that expects the change is
> live. Any migration that removes or rewrites data has to be split: ship the
> additive half, deploy, backfill, then remove — with the removal as a
> deliberate, separately reviewed step.

### Applying one by hand

Only needed to repair a database that has fallen behind, or to bootstrap one
before a service exists:

```bash
DATABASE_URL="<render external connection string>" \
  npx prisma migrate deploy --schema apps/backend/prisma/schema.prisma
```

`migrate dev` is a development command — it can reset the database and it
generates new migrations. `migrate deploy` only applies what is already
committed, which is the only thing that should ever touch an instance holding
real data.

Use the **external** connection string when running this from a laptop, and set
the **internal** one on the service itself — internal is faster and stays off
the public network, but is only reachable from inside Render.

**Gates:** #4 — "Managed Postgres provisioned, with `DATABASE_URL` set on the deployed backend", "Migration applied successfully against the deployed database".

---

## #5 — Managed Redis

**Status:** ☑ provisioned — `o-artiste-redis`, Valkey 8.1.4, Ohio

- [x] Created with maxmemory policy **`noeviction`** (Render defaults to
      `allkeys-lru`, which silently evicts queued jobs)
- [x] `REDIS_URL` set on `o-artiste-api` from the **Internal** string
- [x] External traffic left **closed** — the internal URL carries no password,
      so exposing it would be a serious misconfiguration
- [x] **Worker hosting decided — see "Running the workers" below.**

> **Free-tier testing caveat.** Render's free Key Value instances hold data in
> memory with no disk persistence. This does not affect #5's criterion as
> written — *"scheduled jobs survive a process restart"* means the **application**
> process restarting while Redis stays up, which works. It only matters if Redis
> itself restarts, which that criterion does not test. A production deployment
> needs a persistent instance.

### Running the workers

Two queues now need a consumer: `webhooks` (retry of failed webhook processing,
#20 — **already merged and currently inert on the deployed host**) and
`maintenance`. `#25` adds auto-release.

**A separate Render Background Worker is the production answer, and it is not
available on the current plan.** Background Workers are a paid service type, and
the free plan's 750 instance-hours a month are already almost entirely consumed
by one always-awake web service (~730). There is no room for a second free
service.

#### Now — workers inside the API process (free, testing)

On `o-artiste-api` → **Environment** → add:

| Key | Value |
|---|---|
| `RUN_WORKERS_IN_WEB` | `true` |

Save. Render redeploys. The startup log then reads:

```
[backend] listening on :10000
[backend] in-process workers ON
[worker] listening on queues: maintenance, webhooks
```

Nothing else changes — `REDIS_URL` and `DATABASE_URL` are already set on this
service, and the cron-job.org keepalive already prevents it spinning down.

This is a real consumer, not a stand-in: jobs retry, exhausted jobs dead-letter,
and `SIGTERM` waits for active jobs rather than killing them. Its one cost is
that job processing competes with request handling on the same instance, which
at testing volumes is immaterial.

#### Later — a dedicated worker service (production)

When on a paid plan, **New → Background Worker**:

| Field | Value |
|---|---|
| Repository | `elcareem/o-artiste` |
| Branch | `main` |
| **Root Directory** | **leave BLANK** — the workspace lockfile and the `qs` override live at the repo root |
| Runtime | Node |
| Build Command | `npm install && npm run build --workspace apps/backend` — `build` is `prisma migrate deploy && prisma generate`, so migrations apply here |
| Start Command | `npm run start:worker --workspace apps/backend` |

Environment variables — the worker needs fewer than the API, because it serves
no requests and verifies no signatures (it replays bytes already recorded):

| Key | Source |
|---|---|
| `NODE_VERSION` | `22` |
| `DATABASE_URL` | same Internal string as the API |
| `REDIS_URL` | same Internal string as the API |
| `QUEUE_PREFIX` | same value as the API, or both are unset |
| `ESCROWPAY_BASE_URL` | same as the API — `transaction.funded` reads the escrow back |
| `ESCROWPAY_API_KEY` | same as the API |

Then set `RUN_WORKERS_IN_WEB=false` on `o-artiste-api`. Running both is safe —
BullMQ claims jobs atomically, so two consumers share the queue rather than
double-processing — but there is no reason to keep job load on the web instance
once a dedicated worker exists.

**`QUEUE_PREFIX` must match** across the API and the worker. It namespaces the
queues, so a mismatch produces a worker that connects, reports healthy, and
consumes nothing.

- [x] Instance provisioned
- [x] `REDIS_URL` set on the Render service and on the worker process
- [x] `RUN_WORKERS_IN_WEB=true` set on `o-artiste-api`
- [ ] A job scheduled 10 seconds out fires on the deployed host
- [ ] A scheduled job survives a deployed-process restart

**How to verify the last two.** Both need an `ADMIN` login on the deployed
instance. Registration whitelists `CLIENT` and `ARTIST` on purpose (#9), so
create one with the script — it is the only supported way:

```
DATABASE_URL="<the deployed External connection string>" \
  npm run create-admin --workspace apps/backend
```

It prints the host and database it is about to write to before asking anything
else. Check that line.

| Field | What it should be |
|---|---|
| Role | **`ADMIN`**, not `SUPER_ADMIN`. `ADMIN` resolves disputes and moves money on one booking; `SUPER_ADMIN` changes the commission rate and cancellation tiers, which govern **every booking created afterwards**. The diagnostics need only `ADMIN`. Pass `--super` when a super-admin is genuinely required, and it will make you type a confirmation |
| Email | A mailbox you actually control. Not `@artist-escrow.test` — it is how a locked-out administrator is recovered, and there is no reset flow until #38. The script refuses `.test`, `.local`, `.invalid` and `.example` |
| Phone | E.164, a number you control |
| Password | Generated, 16+ characters, straight into a password manager. `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` |

**Never the seed password**, and never anything that has been pasted into a
chat, an issue or a terminal that gets recorded. The script rejects the seed
password by value, refuses to take a password as a command-line argument
(argv reaches shell history and `ps`), and does not echo what you type.

```
# fires on the deployed host
TOKEN=...   # an ADMIN login against https://o-artiste-api.onrender.com
curl -sX POST https://o-artiste-api.onrender.com/admin/queue/echo \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"delayMs":10000,"label":"deployed check"}'
# wait ~15s, then, with the id it returned:
curl -s https://o-artiste-api.onrender.com/admin/queue/echo/<id> \
     -H "Authorization: Bearer $TOKEN"
# state must be "completed" AND ranAt must be present — ranAt is produced
# inside the worker, so it is what proves a worker ran it rather than the
# queue merely accepting it.

# survives a restart
# schedule with delayMs 300000, restart the service in the Render dashboard,
# then read the job back after it falls due.
```

**The deployed database must never be seeded.** `prisma/seed.ts` creates
`super@artist-escrow.test` with a password that is committed to this
repository. Confirmed on 2026-09-15 that the deployed API rejects those
credentials, so the seed has not been run there — re-confirm before launch
(#41).

**Gates:** #5 — "executes at approximately the right time, locally **and on the deployed host**".

---

## #17 and #10 — EscrowPay sandbox

**Status:** ☐

Needed before `lib/escrowpay.js` can be finished:

- [ ] Sandbox base URL
- [ ] API key / secret, and the **name of the auth header**
- [ ] Webhook signing secret, the **signature header name**, and the **algorithm**
- [ ] Request body shapes for `release` and `refund`
- [ ] **Amount unit — kobo or whole Naira** (open item `docs/00` §11.8)
- [ ] Verification endpoint path and payload (Prembly via EscrowPay)
- [ ] Webhook URL registered with the provider, pointing at the Render backend

The amount unit is the one that must not be guessed. The provider's public example shows `"amount": 145000` for a ₦145,000 transaction, which reads as whole Naira, while this codebase is kobo throughout. Getting it wrong creates escrows at 100× or 1/100 of the intended value. Handled by a single conversion point gated on `ESCROWPAY_AMOUNT_UNIT`.

**Gates:** #17 — "Each method verified against the EscrowPay sandbox". #10 — verification flow.

### Webhook endpoint registration — #20

- [ ] Register **exactly one** URL with EscrowPay:
      `https://o-artiste-api.onrender.com/webhooks/escrowpay`
- [ ] Copy the signing secret shown at registration into
      `ESCROWPAY_WEBHOOK_SECRET` on the **backend** service
- [ ] Confirm the deployed worker is running the `webhooks` queue — the retry
      path is inert without it, and a failed delivery then sits `FAILED` with
      nothing to pick it up

**Registration is dashboard-only**; `POST /webhook-endpoints` exists in the API
but the provider keeps webhook CRUD outside the public surface.

**Only one URL, ever.** A webhook reaching a second deployment — a preview
environment, an old service, a staging host — is a second process acting on the
same money movement. This is the reason the backend is never deployed to Vercel
alongside the web app.

**Rotating the secret:** set the outgoing value as
`ESCROWPAY_WEBHOOK_SECRET_PREVIOUS` and the new one as
`ESCROWPAY_WEBHOOK_SECRET` **before** rotating at the provider. Verification
tries both, which is what makes the provider's 24-hour overlap a rotation rather
than an outage. Remove the previous value after the overlap closes.

---

## #38 — Notifications

**Status:** ☐

- [ ] SMS provider account (e.g. Termii) → API key and sender ID
- [ ] Transactional email provider → API key and verified sender domain

**Gates:** #38. Real SMS transport — #22's delivery is met by the job log until
then.

**Do not set `SMS_API_KEY` before #38 lands.** `lib/notifications.ts` reads it
as the signal that a provider exists, and will throw rather than log. That is
deliberate: a half-configured notifier that silently drops a client's check-in
code is worse than one that is obviously absent.

---

## #41 — Pre-launch

**Status:** ☐

- [ ] Production webhook URL registered with EscrowPay
- [ ] Database backups configured
- [ ] **A restore from backup actually performed** — configured is not verified
- [ ] Rate limiting live on auth, booking creation and check-in endpoints
- [ ] `.env.example` complete; no secrets in the repository

---

## Environment variables

Maintained alongside `apps/backend/.env.example`.

| Variable | Used by | Source |
|---|---|---|
| `PORT` | backend | default 4000 |
| `WEB_ORIGIN` | backend CORS | Vercel URL |
| `DATABASE_URL` | Prisma | #4 |
| `REDIS_URL` | BullMQ | #5 |
| `JWT_SECRET` | auth | generated |
| `JWT_EXPIRES_IN` | auth | default `7d` |
| `ESCROWPAY_BASE_URL` | provider client | #17 |
| `ESCROWPAY_API_KEY` | provider client | #17 |
| `ESCROWPAY_WEBHOOK_SECRET` | webhook verification | #17 |
| `ESCROWPAY_WEBHOOK_SECRET_PREVIOUS` | webhook verification during rotation | #20 — optional, set only for the 24h overlap |
| `ESCROWPAY_AMOUNT_UNIT` | provider client | `kobo` or `naira` — open item `docs/00` §11.8 |
| `ESCROWPAY_TIMEOUT_MS` | provider client | below the host timeout recorded at #2 |
| `AUTO_RELEASE_GRACE_HOURS` | auto-release job | open item `docs/00` §11.5 |
| `CHECKIN_WINDOW_BEFORE_HOURS` | check-in codes | #22 — default `2`; artists arrive early to set up |
| `CHECKIN_WINDOW_AFTER_HOURS` | check-in codes | #22 — default `12`; a forgotten check-in must not become a payment dispute |
| `CHECKIN_CODE_SMS_LEAD_HOURS` | check-in codes | #22 — default `24`; when the SMS goes out, not when the code is issued |
| `SMS_API_KEY` / `SMS_SENDER_ID` | notifications | #38 |
| `EMAIL_API_KEY` / `EMAIL_FROM` | notifications | #38 |
| `NEXT_PUBLIC_API_URL` | web | #3 |
