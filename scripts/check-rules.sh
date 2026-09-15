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

# absent <label> <reason-on-hit> <paths> <pattern...>
# Passes when the pattern does NOT appear under any of <paths> (space separated).
# Paths that do not exist yet are dropped; if none exist the rule SKIPs, so a
# rule can name a directory a later issue creates without reporting a false pass.
absent() {
  local label="$1" reason="$2" paths="$3"; shift 3
  local existing=()
  local p
  for p in $paths; do [ -e "$p" ] && existing+=("$p"); done
  if [ ${#existing[@]} -eq 0 ]; then skip "$label" "$paths not present yet"; return; fi
  local hits
  # Comment lines are dropped before matching. These rules forbid CODE, and the
  # schema, the services and the docs all describe the rules they are subject to
  # in their own comments — a check that cannot tell a violation from its own
  # documentation is a check nobody trusts. Commenting a call out is not a
  # bypass either: a commented call does not run.
  hits="$(grep -rnE "$*" "${existing[@]}" 2>/dev/null \
          | grep -vE '^[^:]*:[0-9]+:[[:space:]]*(//|/\*|\*|#)' || true)"
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
# Scoped to the whole backend, not just src/: #19 requires that no update or
# delete path exists ANYWHERE in the codebase, and a mutation reached through a
# test helper or a seed script is a mutation.
absent "No ledger update or delete path" \
       "The ledger is append-only; corrections are new offsetting entries. docs/01-DATA-MODEL.md §5." \
       "apps/backend/src apps/backend/test apps/backend/prisma apps/web/src" \
       'ledgerEntry\.(update|delete|updateMany|deleteMany|upsert)'

# The transaction guard in ledgerService is only unbypassable while that module
# is the sole writer. A second writer reintroduces exactly the orphaned-row and
# lost-entry failures the guard exists to prevent, so the restriction is
# structural rather than a review habit — the same argument as escrowService.
SRC="apps/backend/src"
if [ ! -d "$SRC" ]; then
  skip "ledgerService.ts is the sole writer of ledger entries" "$SRC not present yet"
else
  hits="$(grep -rnE '\.ledgerEntry\.' "$SRC" 2>/dev/null \
          | grep -vE 'services/ledgerService\.(js|ts)' || true)"
  if [ -z "$hits" ]; then
    pass "ledgerService.ts is the sole writer of ledger entries"
  else
    fail "ledgerService.ts is the sole writer of ledger entries" \
         "All ledger writes go through services/ledgerService.ts, which requires a transaction client. docs/01-DATA-MODEL.md §5." \
         "$hits"
  fi
fi

# ── Raw webhook body — docs/03 §6, issues #2 and #20 ────────────────────────
# Signature verification runs against the exact bytes received. express.json()
# anywhere on the /webhooks path parses and re-serialises them, and every
# signature then fails — a failure that looks like a provider fault rather than
# ours. #20 asks explicitly that the exception configured at #2 be verified to
# have survived later middleware changes; this is that verification, mechanised.
SRC="apps/backend/src"
if [ ! -d "$SRC" ]; then
  skip "express.json() is confined to lib/bodyParsers.ts" "$SRC not present yet"
else
  hits="$(grep -rnE 'express\.json\s*\(' "$SRC" 2>/dev/null \
          | grep -vE 'lib/bodyParsers\.(js|ts)' \
          | grep -vE '^[^:]*:[0-9]+:[[:space:]]*(//|/\*|\*|#)' || true)"
  if [ -z "$hits" ]; then
    pass "express.json() is confined to lib/bodyParsers.ts"
  else
    fail "express.json() is confined to lib/bodyParsers.ts" \
         "Body parsing is decided in one place so the /webhooks raw-body exception cannot be broken by a mount elsewhere. docs/03-ESCROW-FLOW.md §6." \
         "$hits"
  fi
fi

# ── Single money-moving module — docs/03 §5, issue #26 ──────────────────────
SRC="apps/backend/src"
if [ ! -d "$SRC" ]; then
  skip "escrowService.ts is the sole caller of release/refund" "$SRC not present yet"
else
  hits="$(grep -rnE 'escrowpay\.(release|refund)|(release|refund)\s*\(' "$SRC" 2>/dev/null \
          | grep -vE '(services/escrowService\.(js|ts)|lib/escrowpay\.(js|ts))' || true)"
  if [ -z "$hits" ]; then
    pass "escrowService.ts is the sole caller of release/refund"
  else
    fail "escrowService.ts is the sole caller of release/refund" \
         "Only escrowService.ts may instruct a money movement. docs/03-ESCROW-FLOW.md §5." "$hits"
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

# ── Check-in code visibility — docs/02 §5, docs/04 §1, issue #22 ────────────
# The code is the only evidence the two parties were physically together, and
# that rests entirely on the artist being unable to obtain it except from the
# client's hand.
#
# Exactly three modules may name the field. Everything else — a new route, a
# serialiser, a debug log — is a path by which it reaches an artist token. The
# window columns are not the secret and are not restricted.
#
# The test suite sweeps every registered booking route for the code's VALUE.
# This rule catches what the sweep cannot: a module not mounted on that router,
# and the web app, which must never receive the field at all.
CHECKIN_ALLOWED='apps/backend/src/services/checkInService\.ts|apps/backend/src/jobs/checkInCodeJob\.ts|apps/backend/src/types\.d\.ts'
if [ ! -d "apps/backend/src" ]; then
  skip "checkInCode is named only by the check-in service, its delivery job and the types" "apps/backend/src not present yet"
else
  hits="$(grep -rnE 'checkInCode([^VA-Za-z]|$)' apps/backend/src apps/web/src 2>/dev/null \
          | grep -vE "^($CHECKIN_ALLOWED):" \
          | grep -vE '^[^:]*:[0-9]+:[[:space:]]*(//|/\*|\*|#)' || true)"
  if [ -z "$hits" ]; then
    pass "checkInCode is named only by the check-in service, its delivery job and the types"
  else
    fail "checkInCode is named only by the check-in service, its delivery job and the types" \
         "The code must never reach an artist or the browser. Route it through checkInService.ts. docs/02-API-CONTRACT.md §5." "$hits"
  fi
fi

echo
printf 'passed %s   failed %s   skipped %s\n' "$PASS" "$FAIL" "$SKIP"
echo

if [ "$FAIL" -gt 0 ]; then
  echo "Rule violation. These are acceptance criteria, not style preferences."
  exit 1
fi
exit 0
