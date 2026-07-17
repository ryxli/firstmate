#!/usr/bin/env bash
# Guard: no script may invoke `herdr agent rename`. Renaming a herdr agent
# detaches the omp status binding (agent_status pins to unknown); display
# labels change via `herdr pane rename` only. Comment lines are allowed so
# scripts can warn about the trap.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

violations=$(grep -n 'herdr agent rename' "$ROOT"/sbin/*.sh 2>/dev/null | grep -v ':[[:space:]]*#') || true
if [ -n "$violations" ]; then
  fail "herdr agent rename invoked in sbin scripts (breaks status binding): $violations"
fi
pass "no sbin script invokes herdr agent rename"
