#!/usr/bin/env bash
#
# check-rules.sh — mechanical enforcement of the non-negotiable rules in docs/.
#
# Every rule here corresponds to an acceptance criterion in the issue backlog and
# to a line in the pre-launch hardening review (#41). Rules are added as the
# issue that introduces them lands; a rule whose target does not exist yet is
# reported as SKIP, not as a pass.
#
# Run from the repository root:  npm run check:rules

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0; FAIL=0; SKIP=0

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
grey()  { printf '\033[90m%s\033[0m' "$1"; }

pass() { PASS=$((PASS+1)); printf '  %s  %s\n' "$(green PASS)" "$1"; }
skip() { SKIP=$((SKIP+1)); printf '  %s  %s %s\n' "$(grey SKIP)" "$1" "$(grey "($2)")"; }
fail() {
  FAIL=$((FAIL+1))
  printf '  %s  %s\n' "$(red FAIL)" "$1"
  printf '        %s\n' "$2"
  if [ -n "${3:-}" ]; then printf '%s\n' "$3" | sed 's/^/        > /'; fi
}

# absent <label> <reason-on-hit> <path> <pattern...>
# Passes when the pattern does NOT appear under <path>.
absent() {
  local label="$1" reason="$2" path="$3"; shift 3
  if [ ! -e "$path" ]; then skip "$label" "$path not present yet"; return; fi
  local hits
  hits="$(grep -rnE "$*" "$path" 2>/dev/null || true)"
  if [ -z "$hits" ]; then pass "$label"; else fail "$label" "$reason" "$hits"; fi
}

echo
echo "Rule checks — docs/ non-negotiables"
echo

# ── Money precision — docs/01 §1, issue #4 ──────────────────────────────────
SCHEMA="apps/backend/prisma/schema.prisma"
if [ ! -f "$SCHEMA" ]; then
  skip "No Float or Decimal field type in the Prisma schema" "$SCHEMA not present yet"
else
  # Matches a FIELD DECLARATION whose type is Float or Decimal — an indented
  # identifier followed by the type — rather than the bare word anywhere in the
  # file. The rule forbids the types, not the words: the schema documents the
  # rule in its own comments, and a check that cannot tell a violation from its
  # own documentation is a check nobody trusts.
  hits="$(grep -nE '^[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]+(Float|Decimal)\b' "$SCHEMA" || true)"
  if [ -z "$hits" ]; then
    pass "No Float or Decimal field type in the Prisma schema"
  else
    fail "No Float or Decimal field type in the Prisma schema" \
         "All monetary fields are Int kobo. See docs/01-DATA-MODEL.md §1." "$hits"
  fi
fi

# ── Append-only ledger — docs/01 §5, issue #19 ──────────────────────────────
absent "No ledger update or delete path" \
       "The ledger is append-only; corrections are new offsetting entries. docs/01-DATA-MODEL.md §5." \
       "apps/backend/src" \
       'ledgerEntry\.(update|delete|updateMany|deleteMany|upsert)'

# ── Single money-moving module — docs/03 §5, issue #26 ──────────────────────
SRC="apps/backend/src"
if [ ! -d "$SRC" ]; then
  skip "escrowService.js is the sole caller of release/refund" "$SRC not present yet"
else
  hits="$(grep -rnE 'escrowpay\.(release|refund)|(release|refund)\s*\(' "$SRC" 2>/dev/null \
          | grep -vE '(services/escrowService\.js|lib/escrowpay\.js)' || true)"
  if [ -z "$hits" ]; then
    pass "escrowService.js is the sole caller of release/refund"
  else
    fail "escrowService.js is the sole caller of release/refund" \
         "Only escrowService.js may instruct a money movement. docs/03-ESCROW-FLOW.md §5." "$hits"
  fi
fi

# ── No card path — docs/03 §4 ───────────────────────────────────────────────
absent "No card payment path" \
       "Bank transfer only. Escrow and card chargebacks are incompatible. docs/03-ESCROW-FLOW.md §4." \
       "apps/backend/src" \
       'card_number|cardNumber|/charge/card|pay_with_card|payWithCard|card_payment|cardPayment'

# ── Frontend isolation — docs/03 §8 ─────────────────────────────────────────
absent "Frontend makes no direct provider calls" \
       "The frontend talks only to our backend. docs/03-ESCROW-FLOW.md §8." \
       "apps/web/src" \
       'escrowpay\.app|api\.escrowpay|ESCROWPAY_(API_)?(KEY|SECRET)'

# ── No leaked internals in the UI — docs/02 §2, issue #39 ───────────────────
# Targets values rendered out of an error or response object, which is what
# #39 actually forbids. A bare `.status` is not enough to match: this codebase
# has legitimate domain fields named `status` (the health payload, verification
# state), and a rule that fires on those would be switched off within a week.
absent "No raw stack traces or HTTP status codes rendered in the web app" \
       "Users never see stack traces or status codes. docs/02-API-CONTRACT.md §2." \
       "apps/web/src" \
       '\{[^}]*\b(error|err|e|res|response|apiError)\.(stack|status)\b[^}]*\}'

echo
printf 'passed %s   failed %s   skipped %s\n' "$PASS" "$FAIL" "$SKIP"
echo

if [ "$FAIL" -gt 0 ]; then
  echo "Rule violation. These are acceptance criteria, not style preferences."
  exit 1
fi
exit 0
