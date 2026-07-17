#!/usr/bin/env bash
# Verifies `fm toolbelt` lists discovered fm verbs with names and descriptions,
# and specifically that fm spawn appears with a non-empty one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLBELT="$ROOT/sbin/fm"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

[ -x "$TOOLBELT" ] || fail "sbin/fm must exist and be executable"

out="$("$TOOLBELT" toolbelt)"

line=$(printf '%s\n' "$out" | awk -F'\t' '$1 == "spawn"')
[ -n "$line" ] || fail "fm-toolbelt output must include fm spawn"

desc=$(printf '%s' "$line" | cut -f2-)
[ -n "$desc" ] || fail "fm spawn description must be non-empty"

pass "fm-toolbelt lists fm spawn with a non-empty description: $desc"
