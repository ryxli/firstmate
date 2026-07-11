#!/usr/bin/env bash
# Verifies the legacy no-mistakes registry token canonicalizes to direct-PR,
# so mode consumers only ever see direct-PR|local-only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="$ROOT/bin/fm-project-mode.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-project-mode.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

mkdir -p "$TMP/home/data"
cat > "$TMP/home/data/projects.md" <<'EOF'
- legacy [no-mistakes] - pipeline-era project (added 2026-06-25)
- legacy-yolo [no-mistakes +yolo] - pipeline-era project with yolo (added 2026-06-25)
- offline [local-only] - purely local project (added 2026-06-25)
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
