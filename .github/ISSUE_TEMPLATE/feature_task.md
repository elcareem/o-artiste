---
name: Feature / Build Task
about: Track development tasks aligned with project build plans
title: '[PHASE-X] <Task Summary>'
labels: feature, implementation
assignees: ''
---

## 🎯 Task Description
A clear and concise description of the feature to be implemented.

## 📄 Reference Specifications
List the relevant documentation files that define the specification for this task:
- [ ] `docs/01-DATA-MODEL.md`
- [ ] `docs/02-API-CONTRACT.md`
- [ ] `docs/03-ESCROW-FLOW.md`
- [ ] `docs/04-CONFIRMATION-AND-DISPUTES.md`
- [ ] `docs/05-CANCELLATIONS-AND-FEES.md`
- [ ] `docs/06-REPUTATION-AND-STRIKES.md`
- [ ] `docs/07-ADMIN-CONFIG.md`
- [ ] `docs/08-BUILD-PLAN.md`

## ⚙️ Requirements & Scope
- [ ] Requirement 1
- [ ] Requirement 2
- [ ] All monetary calculations must use **kobo integers**.
- [ ] All money movements write a `LedgerEntry` in the same transaction.

## 🚫 Out of Scope (Phase Constraints)
Specify any related features that are explicitly out of scope:
- [ ] No card payment paths
- [ ] No direct frontend-to-EscrowPay communication

## ✅ Acceptance Criteria
Verifiable criteria that must pass before closing this issue:
- [ ] Acceptance step 1 (e.g. `curl http://localhost:4000/artists` returns 200 OK)
- [ ] Acceptance step 2 (e.g. state machine correctly transitions `PENDING_PAYMENT` -> `FUNDED_HELD`)

## 🧪 Testing Plan
Describe the end-to-end testing steps using EscrowPay sandbox credentials.
