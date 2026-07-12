#!/usr/bin/env bash
# Behavior tests for the read-only fleet load-once freshness check.
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
  [ -z "${TMP_ROOT:-}" ] || rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-fleet-updated-tests.XXXXXX")

make_fixture_repo() {
  local repo=$1
  mkdir -p "$repo/.omp/extensions"
  printf '# Firstmate\n' > "$repo/AGENTS.md"
  git -C "$repo" init -q
  git -C "$repo" add AGENTS.md
  GIT_AUTHOR_DATE='2024-01-01T00:00:00Z' GIT_COMMITTER_DATE='2024-01-01T00:00:00Z' \
    git -C "$repo" -c user.name='Firstmate Tests' -c user.email='tests@example.invalid' commit -qm initial
  printf 'export default {}\n' > "$repo/.omp/extensions/fm-supervisor.ts"
  git -C "$repo" add .omp/extensions/fm-supervisor.ts
  GIT_AUTHOR_DATE='2024-01-02T00:00:00Z' GIT_COMMITTER_DATE='2024-01-02T00:00:00Z' \
    git -C "$repo" -c user.name='Firstmate Tests' -c user.email='tests@example.invalid' commit -qm load-once-update
}

make_fake_herdr() {
  local fakebin=$1
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -u
case "${1:-} ${2:-}" in
  'pane list')
    printf 'pane list\n' >> "${FM_FAKE_HERDR_LOG:?}"
    cat "${FM_FAKE_HERDR_JSON:?}"
    ;;
  *)
    printf 'unexpected herdr command: %s\n' "$*" >> "${FM_FAKE_HERDR_LOG:?}"
    exit 2
    ;;
esac
SH
  chmod +x "$fakebin/herdr"
}

set_mtime() {
  python3 - "$1" "$2" <<'PY'
import os
import sys
path, epoch = sys.argv[1], float(sys.argv[2])
os.utime(path, (epoch, epoch))
PY
}

write_panes() {
  local path=$1
  shift
  python3 - "$path" "$@" <<'PY'
import json
import sys

out, newest, oldest, missing = sys.argv[1:5]
panes = [
    {
        "pane_id": "w1:p1",
        "display_agent": "Firstmate",
        "agent_status": "working",
        "agent_session": {"value": newest},
    },
    {
        "pane_id": "w1:p2",
        "label": "Secondmate",
        "agent_status": "idle",
        "agent_session": {"value": oldest},
    },
    {
        "pane_id": "w1:p3",
        "label": "Plain terminal",
        "agent_status": "unknown",
    },
    {
        "pane_id": "w1:p4",
        "display_agent": "Missing session",
        "agent_status": "idle",
        "agent_session": {"value": missing},
    },
]
with open(out, "w") as f:
    json.dump({"result": {"panes": panes}}, f)
PY
}

run_check() {
  local repo=$1 fakebin=$2 panes=$3 log=$4
  PATH="$fakebin:$PATH" FM_ROOT_OVERRIDE="$repo" FM_FAKE_HERDR_JSON="$panes" \
    FM_FAKE_HERDR_LOG="$log" "$ROOT/sbin/fm-fleet-updated.sh"
}

test_fresh_stale_skipped_and_missing_sessions() {
  local repo fakebin newest oldest missing panes log out
  repo="$TMP_ROOT/repo"
  fakebin="$TMP_ROOT/fakebin"
  newest="$TMP_ROOT/newest.jsonl"
  oldest="$TMP_ROOT/oldest.jsonl"
  missing="$TMP_ROOT/missing.jsonl"
  panes="$TMP_ROOT/panes.json"
  log="$TMP_ROOT/herdr.log"

  make_fixture_repo "$repo"
  make_fake_herdr "$fakebin"
  : > "$newest"
  : > "$oldest"
  set_mtime "$newest" 1704153601
  set_mtime "$oldest" 1704153599
  write_panes "$panes" "$newest" "$oldest" "$missing"
  : > "$log"

  if out=$(run_check "$repo" "$fakebin" "$panes" "$log"); then
    fail "stale session did not make the command fail"
  fi
  printf '%s\n' "$out" | grep -F 'w1:p1 Firstmate working session~2024-01-02T00:00:01Z -> LATEST' >/dev/null \
    || fail "newer session was not LATEST"
  printf '%s\n' "$out" | grep -F 'w1:p2 Secondmate idle session~2024-01-01T23:59:59Z -> STALE' >/dev/null \
    || fail "older session was not STALE"
  printf '%s\n' "$out" | grep -F 'w1:p4 Missing session idle session~unknown -> unknown' >/dev/null \
    || fail "missing session did not degrade to unknown"
  printf '%s\n' "$out" | grep -F 'Plain terminal' >/dev/null \
    && fail "pane without agent_session was not skipped"
  printf '%s\n' "$out" | grep -F 'summary total=3 latest=1 stale=1 unknown=1' >/dev/null \
    || fail "summary did not count live agent sessions correctly"
  [ "$(cat "$log")" = 'pane list' ] || fail "check mutated or queried herdr beyond pane list"
  pass "fresh, stale, skipped, and missing sessions are classified correctly"
}

test_json_output_is_parseable() {
  local repo fakebin newest oldest missing panes log json
  repo="$TMP_ROOT/json-repo"
  fakebin="$TMP_ROOT/json-fakebin"
  newest="$TMP_ROOT/json-newest.jsonl"
  oldest="$TMP_ROOT/json-oldest.jsonl"
  missing="$TMP_ROOT/json-missing.jsonl"
  panes="$TMP_ROOT/json-panes.json"
  log="$TMP_ROOT/json-herdr.log"

  make_fixture_repo "$repo"
  make_fake_herdr "$fakebin"
  : > "$newest"
  : > "$oldest"
  set_mtime "$newest" 1704153601
  set_mtime "$oldest" 1704153601
  write_panes "$panes" "$newest" "$oldest" "$missing"
  : > "$log"

  json=$(PATH="$fakebin:$PATH" FM_HOME="$repo" FM_ROOT_OVERRIDE="$repo" \
    FM_FAKE_HERDR_JSON="$panes" FM_FAKE_HERDR_LOG="$log" \
    "$ROOT/sbin/fm-fleet-updated.sh" --json) || fail "JSON invocation failed"
  printf '%s' "$json" | python3 -c '
import json
import sys
result = json.load(sys.stdin)
assert result["summary"] == {"total": 3, "latest": 2, "stale": 0, "unknown": 1}
assert result["mates"][0]["freshness"] == "LATEST"
assert result["mates"][2]["freshness"] == "unknown"
assert result["latest_load_once"]["epoch"] == 1704153600
' || fail "--json did not emit the expected structured result"
  pass "--json emits parseable structured output"
}

test_fresh_stale_skipped_and_missing_sessions
test_json_output_is_parseable
