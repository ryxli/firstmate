#!/usr/bin/env bash
set -eu

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/data"

cat > "$TMP/data/projects.md" <<'EOF'
- defaulted - Default project (added 2026-07-16)
- pr [direct-PR] - PR project (added 2026-07-16)
- main [direct-main] - Direct main project (added 2026-07-16)
- main-yolo [direct-main +yolo] - Direct main yolo project (added 2026-07-16)
- local [local-only] - Local project (added 2026-07-16)
- legacy [no-mistakes +yolo] - Legacy project (added 2026-07-16)
- typo [direct-mainn +yolo] - Typo project (added 2026-07-16)
EOF

mode() {
  FM_DATA_OVERRIDE="$TMP/data" "$ROOT/sbin/fm-project-mode.sh" "$1" 2>/dev/null
}

assert_eq() {
  actual=$1
  expected=$2
  label=$3
  if [ "$actual" != "$expected" ]; then
    printf 'FAIL %s: expected <%s>, got <%s>\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_eq "$(mode defaulted)" "direct-PR off" "missing bracket defaults to direct-PR"
assert_eq "$(mode pr)" "direct-PR off" "direct-PR parses"
assert_eq "$(mode main)" "direct-main off" "direct-main parses"
assert_eq "$(mode main-yolo)" "direct-main on" "direct-main keeps yolo flag"
assert_eq "$(mode local)" "local-only off" "local-only unchanged"
assert_eq "$(mode legacy)" "direct-PR on" "legacy no-mistakes remains direct-PR alias"
assert_eq "$(mode typo)" "direct-PR off" "unknown mode falls back safely"
assert_eq "$(mode missing)" "direct-PR off" "missing project falls back safely"

printf 'ok fm-project-mode\n'
