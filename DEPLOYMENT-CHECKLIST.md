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

**Status:** ☐

- [ ] Web service created, root directory `apps/backend`, Node 22
- [ ] Build `npm install`, start `npm start`
- [ ] `WEB_ORIGIN` set to the Vercel URL
- [ ] `/health` answers at the live URL

### Two values to record here when it is live

| Value | Why it matters | Recorded |
|---|---|---|
| **Default request timeout** | #17 sets the EscrowPay client timeout *below* this. A provider call that outlives the request can create an escrow we have no record of (`docs/03` §7) | _pending_ |
| **Does the instance sleep when idle?** | Determines whether #5's BullMQ workers need a separate always-on process | _pending_ |

Render's free tier sleeps idle instances, so a **separate worker process** is built from the outset regardless of which plan is chosen.

**Gates:** #2 — "The deployed backend's `/health` route responds at a live URL". Also feeds #5 and #17.

---

## #3 — Web host (Vercel)

**Status:** ☐

- [ ] Project created with **root directory `apps/web`**
- [ ] `NEXT_PUBLIC_API_URL` set to the Render backend URL
- [ ] Deployed URL reachable, and successfully calling the backend's `/health` cross-origin

**Gates:** #3 — "Deployed and reachable at a live Vercel URL, successfully calling the deployed backend's `/health`".

---

## #4 — Managed Postgres

**Status:** ☐ *(local development is unblocked — a local PostgreSQL instance is already running)*

- [ ] Instance provisioned
- [ ] `DATABASE_URL` set on the Render service
- [ ] `npx prisma migrate deploy` run **against the deployed database**, not only locally

**Gates:** #4 — "Managed Postgres provisioned, with `DATABASE_URL` set on the deployed backend", "Migration applied successfully against the deployed database".

---

## #5 — Managed Redis

**Status:** ☐ *(local development is unblocked — a local Redis instance is already running)*

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
