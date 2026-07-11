#!/usr/bin/env bash
# Focused behavior tests for deterministic directive classification.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLASSIFY="$ROOT/bin/fm-directive-classify.sh"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

assert_class() {
  local directive=$1 disposition=$2 tier=$3 contract=$4 reason=$5 output
  output=$("$CLASSIFY" "$directive") || fail "classifier failed: $directive"
  [[ "$output" == *"disposition=$disposition"* ]] || fail "wrong disposition: $directive"
  [[ "$output" == *"model_tier=$tier"* ]] || fail "wrong model tier: $directive"
  [[ "$output" == *"return_contract=$contract"* ]] || fail "wrong return contract: $directive"
  [[ "$output" == *"reason=$reason"* ]] || fail "wrong reason: $directive"
}

assert_class '' ask human captain-question empty-directive
assert_class 'remember that I prefer terse summaries' record cheap receipt memory-or-preference
assert_class 'route this persistence investigation to the domain owner' route standard receipt domain-route
assert_class 'evaluate the benchmark and decide whether to adopt it' review strong review-decision judgment-required
assert_class 'measure heartbeat cadence and find what is wrong' scout cheap evidence-scout evidence-gathering
assert_class 'implement the config loader fix and add the test' implement standard build-summary scoped-build
assert_class 'fix the deploy by force push and delete the bad branch' ask human captain-question safety-gate
assert_class 'review the production delete path analysis only' review strong review-decision judgment-required
assert_class 'push back if this is a bad idea' dispute strong review-decision explicit-dispute
pass 'directive precedence routes safe, evidence, implementation, and human decisions'

[ "$("$CLASSIFY" --field model_tier 'investigate cache misses')" = cheap ] || fail '--field did not return a stable field value'
set +e
invalid=$("$CLASSIFY" --field unsupported 'anything' 2>&1)
code=$?
set -e
[ "$code" -eq 2 ] || fail 'invalid --field did not return usage error'
[[ "$invalid" == *'field must be disposition'* ]] || fail 'invalid --field did not explain valid fields'
pass 'directive fields expose stable machine-readable output'
