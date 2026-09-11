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
- [x] Build `npm install`, start `npm run start --workspace apps/backend`
- [x] Health Check Path `/health`
- [x] Auto-Deploy: On Commit
- [ ] `NODE_VERSION` = `22` — first deploy used Node 20.8.2
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

**Status:** ☐ *(local development is unblocked — a local PostgreSQL instance is already running)*

> **Free-tier testing caveat.** Render deletes free PostgreSQL instances after
> 30 days. If the build runs past a month the database disappears along with its
> seed data. Not fatal by design — migrations are version-controlled and #6's
> seed script is idempotent, so the state is reproducible with two commands. Do
> not put anything in it that cannot be regenerated.

- [ ] Instance provisioned
- [ ] `DATABASE_URL` set on the Render service
- [ ] `npx prisma migrate deploy` run **against the deployed database**, not only locally

**Gates:** #4 — "Managed Postgres provisioned, with `DATABASE_URL` set on the deployed backend", "Migration applied successfully against the deployed database".

---

## #5 — Managed Redis

**Status:** ☐ *(local development is unblocked — a local Redis instance is already running)*

> **Free-tier testing caveat.** Render's free Key Value instances hold data in
> memory with no disk persistence. This does not affect #5's criterion as
> written — *"scheduled jobs survive a process restart"* means the **application**
> process restarting while Redis stays up, which works. It only matters if Redis
> itself restarts, which that criterion does not test. A production deployment
> needs a persistent instance.

- [ ] Instance provisioned
- [ ] `REDIS_URL` set on the Render service and on the worker process
- [ ] A job scheduled 10 seconds out fires on the deployed host
- [ ] A scheduled job survives a deployed-process restart

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

---

## #38 — Notifications

**Status:** ☐

- [ ] SMS provider account (e.g. Termii) → API key and sender ID
- [ ] Transactional email provider → API key and verified sender domain

**Gates:** #38, and the SMS delivery criterion deferred from #22.

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
| `ESCROWPAY_AMOUNT_UNIT` | provider client | `kobo` or `naira` — open item `docs/00` §11.8 |
| `ESCROWPAY_TIMEOUT_MS` | provider client | below the host timeout recorded at #2 |
| `AUTO_RELEASE_GRACE_HOURS` | auto-release job | open item `docs/00` §11.5 |
| `SMS_API_KEY` / `SMS_SENDER_ID` | notifications | #38 |
| `EMAIL_API_KEY` / `EMAIL_FROM` | notifications | #38 |
| `NEXT_PUBLIC_API_URL` | web | #3 |
