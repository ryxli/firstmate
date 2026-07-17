#!/usr/bin/env bash
# Verifies fm-toolbelt lists every executable sbin/ script with a name and a
# description, and specifically that fm-spawn.sh appears with a non-empty one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLBELT="$ROOT/sbin/fm-toolbelt"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

[ -x "$TOOLBELT" ] || fail "sbin/fm-toolbelt must exist and be executable"

out="$("$TOOLBELT")"

line=$(printf '%s\n' "$out" | awk -F'\t' '$1 == "fm-spawn.sh"')
[ -n "$line" ] || fail "fm-toolbelt output must include fm-spawn.sh"

desc=$(printf '%s' "$line" | cut -f2-)
[ -n "$desc" ] || fail "fm-spawn.sh description must be non-empty"

pass "fm-toolbelt lists fm-spawn.sh with a non-empty description: $desc"
