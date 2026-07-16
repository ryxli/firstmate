#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

cleanup() {
  if [ -n "${TMP_ROOT:-}" ]; then
    rm -rf "$TMP_ROOT"
  fi
}

trap cleanup EXIT
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-handoff-check-tests.XXXXXX")

seed_valid_fixture() {
  local fixture=$1
  mkdir -p "$fixture/data/handoff"
  cp "$ROOT/data/handoff/current-actions.md" "$fixture/data/handoff/current-actions.md"
  cp "$ROOT/data/handoff/firstmate-readback.md" "$fixture/data/handoff/firstmate-readback.md"
}

test_valid_pair() {
  local fixture="$TMP_ROOT/valid" out
  seed_valid_fixture "$fixture"
  if ! out=$(FM_HOME="$fixture" "$ROOT/sbin/fm-handoff-check.sh"); then
    fail "valid handoff pair failed validation: $out"
  fi
  case "$out" in
    *'PASS: current-actions.md:5 ↔ firstmate-readback.md:5'*) ;;
    *) fail "valid handoff pair missed source line 5: $out" ;;
  esac
  case "$out" in
    *'PASS: current-actions.md:10 ↔ firstmate-readback.md:6'*) ;;
    *) fail "valid handoff pair missed source line 10: $out" ;;
  esac
  case "$out" in
    *'PASS: current-actions.md:11 ↔ firstmate-readback.md:6'*) ;;
    *) fail "valid handoff pair missed active constraint line 11: $out" ;;
  esac
  case "$out" in
    *'PASS: current-actions.md:13 ↔ firstmate-readback.md:7'*) ;;
    *) fail "valid handoff pair missed source line 13: $out" ;;
  esac
  case "$out" in
    *'PASS: current-actions.md:14 ↔ firstmate-readback.md:8'*) ;;
    *) fail "valid handoff pair missed source line 14: $out" ;;
  esac
  pass "handoff check passes the current fixture pair"
}

test_contradictory_readback() {
  local fixture="$TMP_ROOT/contradictory" out
  seed_valid_fixture "$fixture"
  awk 'NR == 7 { print "3. Pursue an unrelated completed request."; next } { print }' \
    "$fixture/data/handoff/firstmate-readback.md" > "$fixture/data/handoff/readback.tmp"
  mv "$fixture/data/handoff/readback.tmp" "$fixture/data/handoff/firstmate-readback.md"
  if out=$(FM_HOME="$fixture" "$ROOT/sbin/fm-handoff-check.sh"); then
    fail "contradictory readback unexpectedly passed: $out"
  fi
  case "$out" in
    *'FAIL: current-actions.md:13'*'firstmate-readback.md:7'*) ;;
    *) fail "contradiction did not cite exact source/readback lines: $out" ;;
  esac
  pass "handoff check reports a contradictory active-readback entry"
}

test_valid_pair
test_contradictory_readback
