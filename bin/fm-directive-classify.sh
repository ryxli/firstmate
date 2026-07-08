#!/usr/bin/env bash
# fm-directive-classify.sh - deterministic firstmate directive routing slice.
set -eu

usage() {
  cat <<'USAGE'
usage: fm-directive-classify.sh [--field <name>] <directive text...>

Classify a captain directive into a finite supervision action. The output is
stable key=value lines for scripts and receipts:

  disposition=<record|route|scout|implement|review|ask|dispute>
  model_tier=<cheap|standard|strong|human>
  return_contract=<receipt|evidence-scout|build-summary|review-decision|captain-question>
  reason=<short-rule-name>

Rules are ordered for safety: unsafe/destructive requests go to human judgment,
memory/preferences are recorded, evidence gathering stays cheap, scoped builds
use standard execution, and architecture/risk/eval decisions use strong review.

Options:
  --field <name>  Print only one field value.
  -h, --help      Show this help.
USAGE
}

fail_usage() {
  printf 'error: %s\n' "$1" >&2
  usage >&2
  exit 2
}

DIRECTIVE=''
FIELD=''
while [ $# -gt 0 ]; do
  case "$1" in
    --field)
      shift
      FIELD=${1:-}
      [ -n "$FIELD" ] || fail_usage '--field requires a name'
      ;;
    --field=*) FIELD=${1#--field=} ;;
    -h|--help) usage; exit 0 ;;
    -*) fail_usage "unknown flag: $1" ;;
    *)
      if [ -n "$DIRECTIVE" ]; then
        DIRECTIVE="$DIRECTIVE $1"
      else
        DIRECTIVE=$1
      fi
      ;;
  esac
  shift
done

lower_directive() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

contains_any() {
  local text=$1 word
  shift
  for word in "$@"; do
    case "$text" in
      *"$word"*) return 0 ;;
    esac
  done
  return 1
}

has_analysis_only_escape() {
  case "$1" in
    *"analysis only"*|*"investigate"*|*"audit"*|*"review"*|*"what would"*|*"how would"*) return 0 ;;
    *) return 1 ;;
  esac
}

emit() {
  local disposition=$1 model_tier=$2 return_contract=$3 reason=$4
  case "$FIELD" in
    '')
      printf 'disposition=%s\n' "$disposition"
      printf 'model_tier=%s\n' "$model_tier"
      printf 'return_contract=%s\n' "$return_contract"
      printf 'reason=%s\n' "$reason"
      ;;
    disposition) printf '%s\n' "$disposition" ;;
    model_tier) printf '%s\n' "$model_tier" ;;
    return_contract) printf '%s\n' "$return_contract" ;;
    reason) printf '%s\n' "$reason" ;;
    *) fail_usage 'field must be disposition, model_tier, return_contract, or reason' ;;
  esac
}

TEXT=$(lower_directive "$DIRECTIVE")

if [ -z "$TEXT" ]; then
  emit ask human captain-question empty-directive
  exit 0
fi

if contains_any "$TEXT" \
  " merge " " merge it" "delete" "discard" "destroy" "drop database" "wipe" \
  "force push" "reset --hard" "secret" "credential" "private key" "token" \
  "security" "production" "prod" "payment" "money"; then
  if ! has_analysis_only_escape "$TEXT"; then
    emit ask human captain-question safety-gate
    exit 0
  fi
fi

if contains_any "$TEXT" \
  "unsafe" "bad idea" "push back" "do not do" "don't do" "refuse" "dispute"; then
  emit dispute strong review-decision explicit-dispute
  exit 0
fi

if contains_any "$TEXT" \
  "remember" "record" "preference" "i prefer" "captain.md" "memory" "note that" "always " "never "; then
  emit record cheap receipt memory-or-preference
  exit 0
fi

if contains_any "$TEXT" \
  "secondmate" "domain owner" "route to" "send to" "hand off"; then
  emit route standard receipt domain-route
  exit 0
fi

if contains_any "$TEXT" \
  "architecture" "strategy" "tradeoff" "risk" "decide" "evaluate" "eval" \
  "benchmark" "adopt" "reject" "review" "audit" "trading" "p&l" "pnl"; then
  emit review strong review-decision judgment-required
  exit 0
fi

if contains_any "$TEXT" \
  "investigate" "find" "measure" "sample" "grep" "read" "trace" "reproduce" "why" "what's wrong" "whats wrong"; then
  emit scout cheap evidence-scout evidence-gathering
  exit 0
fi

if contains_any "$TEXT" \
  "implement" "fix" "add" "update" "wire" "clean up" "cleanup" "change" "ship" "build" "test"; then
  emit implement standard build-summary scoped-build
  exit 0
fi

emit ask human captain-question no-rule-match
