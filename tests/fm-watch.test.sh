#!/usr/bin/env bash
# Regression test for watcher stale detection.
# Shadow/self metas must not be polled as ordinary panes, or the supervisor
# pane trips false stale alarms.
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

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-watch-tests.XXXXXX")
HOME_DIR="$TMP_ROOT/home"
STATE_DIR="$HOME_DIR/state"
BIN_DIR="$TMP_ROOT/fakebin"
mkdir -p "$STATE_DIR" "$BIN_DIR"

cat > "$BIN_DIR/herdr" <<'SH'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  agent)
    case "${2:-}" in
      get)
        printf '{"id":"cli:agent:get","result":{"pane":{"pane_id":"w0:p0","agent_status":"idle"}}}\n'
        exit 0 ;;
    esac ;;
  pane)
    case "${2:-}" in
      get|current)
        printf '{"id":"cli:pane:get","result":{"pane":{"pane_id":"w0:p0"}}}\n'
        exit 0 ;;
    esac ;;
esac
exit 0
SH
chmod +x "$BIN_DIR/herdr"

cat > "$STATE_DIR/keel-shadow.meta" <<EOF
pane=w0:p0
kind=ship
mode=shadow
project=firstmate
worktree=$ROOT
harness=omp
EOF

out=$(FM_HOME="$HOME_DIR" FM_STATE_OVERRIDE="$STATE_DIR" FM_POLL=1 FM_HEARTBEAT=1 FM_STALE_POLLS=1 PATH="$BIN_DIR:$PATH" \
  "$ROOT/bin/fm-watch.sh") || fail "watcher exited non-zero"

case "$out" in
  stale:*) fail "shadow self meta produced stale wake: $out" ;;
  heartbeat*) pass "shadow self meta is ignored by stale polling" ;;
  *) fail "unexpected watcher output: $out" ;;
esac
