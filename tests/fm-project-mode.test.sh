#!/usr/bin/env bash
# Verifies delivery modes are trunk|pr only - no legacy aliases.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="$ROOT/sbin/fm"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-project-mode.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

mkdir -p "$TMP/home/data"
cat > "$TMP/home/data/projects.md" <<'EOF'
- defaulted - Default project (added 2026-07-16)
- prproj [pr] - PR project (added 2026-07-16)
- trunkproj [trunk] - Trunk project (added 2026-07-16)
- trunk-yolo [trunk +yolo] - Trunk yolo (added 2026-07-16)
- legacy [no-mistakes] - stale alias (added 2026-06-25)
- oldpr [direct-PR] - stale alias (added 2026-06-25)
- oldtrunk [local-only] - stale alias (added 2026-06-25)
- typo [direct-mainn +yolo] - Typo project (added 2026-07-16)
EOF

run_mode() { FM_HOME="$TMP/home" FM_ROOT_OVERRIDE='' FM_DATA_OVERRIDE='' "$MODE" project-mode "$1" 2>/dev/null; }
run_mode_err() { FM_HOME="$TMP/home" FM_ROOT_OVERRIDE='' FM_DATA_OVERRIDE='' "$MODE" project-mode "$1" 2>&1; }

out=$(run_mode defaulted)
[ "$out" = "pr off" ] || fail "missing bracket must default to 'pr off', got: $out"
pass "missing bracket defaults to pr"

out=$(run_mode prproj)
[ "$out" = "pr off" ] || fail "[pr] must parse, got: $out"
pass "pr parses"

out=$(run_mode trunkproj)
[ "$out" = "trunk off" ] || fail "[trunk] must parse, got: $out"
pass "trunk parses"

out=$(run_mode trunk-yolo)
[ "$out" = "trunk on" ] || fail "[trunk +yolo] must keep yolo, got: $out"
pass "trunk keeps yolo"

err=$(run_mode_err legacy)
echo "$err" | grep -q 'only trunk|pr are valid' || fail "stale no-mistakes must warn about valid modes"
echo "$err" | grep -q '^pr off$' || fail "stale no-mistakes must fall back to pr off"
pass "stale no-mistakes falls back to pr with warn"

err=$(run_mode_err oldpr)
echo "$err" | grep -q 'only trunk|pr are valid' || fail "stale direct-PR must warn"
echo "$err" | grep -q '^pr off$' || fail "stale direct-PR must fall back to pr off"
pass "stale direct-PR falls back to pr with warn"

err=$(run_mode_err oldtrunk)
echo "$err" | grep -q 'only trunk|pr are valid' || fail "stale local-only must warn (not map to trunk)"
echo "$err" | grep -q '^pr off$' || fail "stale local-only must fall back to pr off, not trunk"
pass "stale local-only does not map to trunk"

out=$(run_mode typo)
[ "$out" = "pr off" ] || fail "unknown mode must fall back safely, got: $out"
pass "unknown mode falls back safely"

out=$(run_mode missing)
[ "$out" = "pr off" ] || fail "missing project must fall back safely, got: $out"
pass "missing project falls back safely"
