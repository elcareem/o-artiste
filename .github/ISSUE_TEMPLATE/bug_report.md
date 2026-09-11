---
name: Bug Report
about: Create a report to help reproduce and resolve an issue
title: '[BUG] <Short Description>'
labels: bug, triage
assignees: ''
---

## 🐛 Bug Description
A clear description of what the bug is.

## 🔄 Reproduction Steps
Steps to reproduce the behavior:
1. Go to '...'
2. Click on '....'
3. Execute request / API call '...'
4. See error

## 📉 Expected vs Actual Behavior
* **Expected:** e.g. Webhook returns 200 OK and updates booking status to `FUNDED_HELD`.
* **Actual:** e.g. Booking remains in `PENDING_PAYMENT` due to missing reference check.

## 💻 Environment / Endpoint Details
* **App:** `apps/backend` | `apps/web`
* **Route / Endpoint:** e.g., `POST /webhooks/escrowpay`
* **Payload / Error Response:**
```json
{
  "error": "Sample error message"
}
```

## 🛡️ Idempotency & Safety Impact
- Does this bug risk double-release, double-refund, or duplicate database state? Yes/No
- Does this bug cause a ledger entry to be missing, duplicated, or inconsistent with escrow state? Yes/No
- Does this bug violate any rule in `docs/`? (Specify)
