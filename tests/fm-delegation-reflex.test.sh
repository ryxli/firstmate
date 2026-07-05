#!/usr/bin/env bash
# Behavior test for the delegation-reflex substrate check.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT/benchmarks/delegation-reflex.check.sh"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

test_delegation_reflex_check_is_structural() {
  [ -x "$CHECK" ] || fail "missing executable check at $CHECK"
  out="$($CHECK)" || fail "delegation-reflex check failed: $out"
  printf '%s\n' "$out" | grep -qF 'task-first supervisor launches' \
    || fail "delegation-reflex check output did not confirm the supervisor launch profile"
  pass "delegation-reflex substrate check is executable and structural"
}

test_delegation_reflex_check_is_structural
