#!/usr/bin/env bash
# Verifies the legacy no-mistakes registry token canonicalizes to direct-PR,
# so mode consumers only ever see direct-PR|local-only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="$ROOT/sbin/fm-project-mode.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-project-mode.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

mkdir -p "$TMP/home/data"
cat > "$TMP/home/data/projects.md" <<'EOF'
- defaulted - Default project (added 2026-07-16)
- pr [direct-PR] - PR project (added 2026-07-16)
- main [direct-main] - Direct main project (added 2026-07-16)
- main-yolo [direct-main +yolo] - Direct main yolo project (added 2026-07-16)
- legacy [no-mistakes] - pipeline-era project (added 2026-06-25)
- legacy-yolo [no-mistakes +yolo] - pipeline-era project with yolo (added 2026-06-25)
- offline [local-only] - purely local project (added 2026-06-25)
- typo [direct-mainn +yolo] - Typo project (added 2026-07-16)
EOF

run_mode() { FM_HOME="$TMP/home" FM_ROOT_OVERRIDE='' FM_DATA_OVERRIDE='' "$MODE" "$1"; }

out=$(run_mode legacy)
[ "$out" = "direct-PR off" ] || fail "[no-mistakes] must resolve to 'direct-PR off', got: $out"
pass "legacy no-mistakes token canonicalizes to direct-PR off"

out=$(run_mode legacy-yolo)
[ "$out" = "direct-PR on" ] || fail "[no-mistakes +yolo] must resolve to 'direct-PR on', got: $out"
pass "yolo flag survives no-mistakes canonicalization"

out=$(run_mode offline)
[ "$out" = "local-only off" ] || fail "[local-only] must stay 'local-only off', got: $out"
pass "local-only resolution is unchanged"

out=$(run_mode defaulted)
[ "$out" = "direct-PR off" ] || fail "missing bracket must default to 'direct-PR off', got: $out"
pass "missing bracket defaults to direct-PR"

out=$(run_mode pr)
[ "$out" = "direct-PR off" ] || fail "explicit direct-PR must parse, got: $out"
pass "direct-PR parses"

out=$(run_mode main)
[ "$out" = "direct-main off" ] || fail "direct-main must parse, got: $out"
pass "direct-main parses"

out=$(run_mode main-yolo)
[ "$out" = "direct-main on" ] || fail "direct-main must keep yolo flag, got: $out"
pass "direct-main keeps yolo flag"

out=$(run_mode typo)
[ "$out" = "direct-PR off" ] || fail "unknown mode must fall back safely, got: $out"
pass "unknown mode falls back safely"

out=$(run_mode missing)
[ "$out" = "direct-PR off" ] || fail "missing project must fall back safely, got: $out"
pass "missing project falls back safely"
