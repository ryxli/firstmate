#!/usr/bin/env bash
# Focused behavior tests for fm-directive-classify.sh.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CLASSIFY="$ROOT/bin/fm-directive-classify.sh"

field() {
  "$CLASSIFY" --field "$1" "$2"
}

assert_class() {
  local directive=$1 disposition=$2 model_tier=$3 return_contract=$4 reason=$5 out
  out=$("$CLASSIFY" "$directive") || fail "classifier exited non-zero for: $directive"
  assert_contains "$out" "disposition=$disposition" "wrong disposition for: $directive"
  assert_contains "$out" "model_tier=$model_tier" "wrong model tier for: $directive"
  assert_contains "$out" "return_contract=$return_contract" "wrong return contract for: $directive"
  assert_contains "$out" "reason=$reason" "wrong reason for: $directive"
}

test_help_documents_output_contract() {
  local out
  out=$("$CLASSIFY" --help) || fail '--help exited non-zero'
  assert_contains "$out" 'usage: fm-directive-classify.sh' 'help missing usage'
  assert_contains "$out" 'disposition=<record|route|scout|implement|review|ask|dispute>' 'help missing disposition enum'
  assert_contains "$out" 'model_tier=<cheap|standard|strong|human>' 'help missing model tier enum'
  pass '--help documents classifier output contract'
}

test_empty_directive_asks_human() {
  assert_class '' ask human captain-question empty-directive
  pass 'empty directive asks for human clarification'
}

test_memory_preference_records_receipt() {
  assert_class 'remember that I prefer terse summaries' record cheap receipt memory-or-preference
  pass 'memory and preference directives record a receipt on cheap tier'
}

test_record_precedence_over_generic_update() {
  assert_class 'record this preference and update memory: never use em dashes' record cheap receipt memory-or-preference
  pass 'record or preference language beats generic update/build language'
}

test_domain_route() {
  assert_class 'route this persistence investigation to the domain owner' route standard receipt domain-route
  pass 'explicit domain owner language routes work'
}

test_strong_review_for_architecture_and_eval() {
  assert_class 'evaluate the benchmark and decide whether to adopt it' review strong review-decision judgment-required
  assert_class 'clean up the trading architecture risk' review strong review-decision judgment-required
  pass 'architecture, trading risk, and eval route to strong review'
}

test_cheap_evidence_scout() {
  assert_class 'measure heartbeat cadence and find what is wrong' scout cheap evidence-scout evidence-gathering
  pass 'evidence-gathering directives use cheap scout contract'
}

test_scoped_implementation() {
  assert_class 'implement the config loader fix and add the test' implement standard build-summary scoped-build
  pass 'scoped implementation uses standard build contract'
}

test_destructive_beats_implementation() {
  assert_class 'fix the deploy by force push and delete the bad branch' ask human captain-question safety-gate
  pass 'destructive language beats scoped implementation'
}

test_analysis_only_destructive_can_review() {
  assert_class 'review the production delete path analysis only' review strong review-decision judgment-required
  pass 'analysis-only destructive wording can be reviewed instead of blocked'
}

test_explicit_dispute() {
  assert_class 'push back if this is a bad idea' dispute strong review-decision explicit-dispute
  pass 'explicit dispute language uses dispute disposition'
}

test_field_output() {
  local out
  out=$(field model_tier 'investigate cache misses') || fail '--field exited non-zero'
  [ "$out" = cheap ] || fail "--field model_tier wrong: $out"
  pass '--field prints one stable value'
}

test_invalid_field_exits_two() {
  local out rc
  set +e
  out=$("$CLASSIFY" --field nope 'anything' 2>&1)
  rc=$?
  set -e
  expect_code 2 "$rc" 'invalid field exit code'
  assert_contains "$out" 'field must be disposition, model_tier, return_contract, or reason' 'invalid field error missing enum'
  pass 'invalid --field exits with usage error'
}

test_help_documents_output_contract
test_empty_directive_asks_human
test_memory_preference_records_receipt
test_record_precedence_over_generic_update
test_domain_route
test_strong_review_for_architecture_and_eval
test_cheap_evidence_scout
test_scoped_implementation
test_destructive_beats_implementation
test_analysis_only_destructive_can_review
test_explicit_dispute
test_field_output
test_invalid_field_exits_two
