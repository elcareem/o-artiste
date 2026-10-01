#!/usr/bin/env bash
#
# End-to-end lifecycle verification — issue #40.
#
# Drives the real backend over HTTP through every outcome path — happy path,
# auto-release, a client cancellation in every band, an artist cancellation with
# its fee liability settled later, a no-show, a dispute decided each of three
# ways, a reclassification, a payout that bounces — and asserts after each one
# that our ledger sums to zero AND that the provider holds nothing.
#
#   scripts/e2e-sandbox-test.sh                      local provider simulator
#   E2E_PROVIDER=sandbox scripts/e2e-sandbox-test.sh  the real EscrowPay test book
#
# The default runs unattended and exits 0 only if every scenario passes. The
# sandbox mode needs a person: EscrowPay's public API cannot fund an escrow, so
# at each funding step the script prints the hosted checkout URL and waits for
# someone to pay it in the simulator. See apps/backend/e2e/provider-simulator.ts.
#
# Needs PostgreSQL and Redis — the same ones the test suite uses. Runs in its own
# database schema and queue prefix, so it never touches development data.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/apps/backend"

if [ "${E2E_PROVIDER:-simulator}" = "sandbox" ]; then
  echo "Sandbox mode: you will be asked to pay each booking on EscrowPay's hosted checkout."
  echo "Only sk_test_ keys are accepted — the script refuses to run against the live book."
  echo
fi

exec node e2e/run.ts "$@"
