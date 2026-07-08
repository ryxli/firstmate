#!/usr/bin/env bash
# Test fm-panes.sh fleet roster helper.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=
BASE_PATH=${FM_TEST_BASE_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}

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

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-panes-tests.XXXXXX")
BIN_DIR="$TMP_ROOT/fakebin"
mkdir -p "$BIN_DIR"

# Create a fake herdr that returns test JSON
cat > "$BIN_DIR/herdr" << 'SH'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  pane)
    case "${2:-}" in
      list)
        cat << 'JSON'
{"id":"cli:pane:list","result":{"panes":[{"agent":"omp","agent_status":"working","display_agent":"Keel","pane_id":"wV:p3H"},{"agent_status":"unknown","pane_id":"wV:p1X","cwd":"/srv/hookless"},{"agent":"omp","agent_status":"idle","display_agent":"Fran","pane_id":"w24:pD"},{"agent":"omp","agent_status":"idle","display_agent":"Atlas","pane_id":"w2C:p9"}],"type":"pane_list"}}
JSON
        exit 0
        ;;
    esac
    ;;
esac
exit 1
SH
chmod +x "$BIN_DIR/herdr"

test_lists_panes_with_agents() {
  local out
  out=$(PATH="$BIN_DIR:$BASE_PATH" "$ROOT/bin/fm-panes.sh") || fail "script exited non-zero"
  
  local line_count
  line_count=$(echo "$out" | wc -l)
  [ "$line_count" -eq 3 ] || fail "expected 3 panes, got $line_count: $out"
  
  echo "$out" | grep -q "^Keel" || fail "Keel not in output"
  echo "$out" | grep -q "^Fran" || fail "Fran not in output"
  echo "$out" | grep -q "^Atlas" || fail "Atlas not in output"
  
  pass "lists all panes with detected agents"
}

test_filters_case_insensitive() {
  local out
  out=$(PATH="$BIN_DIR:$BASE_PATH" "$ROOT/bin/fm-panes.sh" "fran") || fail "script exited non-zero"
  
  [ "$out" = "Fran	idle	w24:pD" ] || fail "filter did not match Fran: $out"
  pass "filters by name case-insensitively"
}

test_filters_uppercase() {
  local out
  out=$(PATH="$BIN_DIR:$BASE_PATH" "$ROOT/bin/fm-panes.sh" "KEEL") || fail "script exited non-zero"
  
  echo "$out" | grep -q "^Keel" || fail "uppercase filter did not match Keel: $out"
  pass "filters by name with uppercase"
}

test_no_match_returns_empty() {
  local out rc
  out=$(PATH="$BIN_DIR:$BASE_PATH" "$ROOT/bin/fm-panes.sh" "nomatch")
  rc=$?
  [ "$rc" -eq 0 ] || fail "script exited non-zero when no match: $rc"
  [ -z "$out" ] || fail "script returned output on no match: $out"
  pass "no match returns empty output and exit 0"
}

test_panes_without_agent_excluded() {
  local out
  out=$(PATH="$BIN_DIR:$BASE_PATH" "$ROOT/bin/fm-panes.sh") || fail "script exited non-zero"
  
  echo "$out" | grep -q "unknown" && fail "pane with no agent was included"
  pass "panes without detected agent are excluded"
}

test_output_format() {
  local out
  out=$(PATH="$BIN_DIR:$BASE_PATH" "$ROOT/bin/fm-panes.sh" "keel") || fail "script exited non-zero"
  
  echo "$out" | grep -qE '^[^[:space:]]+	[^[:space:]]+	[^[:space:]]+$' || fail "output format invalid: $out"
  pass "output has correct tab-separated format"
}

test_herdr_error_exits_nonzero() {
  local rc
  PATH="$BIN_DIR:$BASE_PATH" "$ROOT/bin/fm-panes.sh" 2>/dev/null; rc=$?
  # Override herdr to fail
  cat > "$BIN_DIR/herdr" << 'SH'
#!/usr/bin/env bash
exit 1
SH
  chmod +x "$BIN_DIR/herdr"
  
  PATH="$BIN_DIR:$BASE_PATH" "$ROOT/bin/fm-panes.sh" 2>/dev/null; rc=$?
  [ "$rc" -ne 0 ] || fail "script should exit non-zero on herdr failure"
  pass "exits non-zero when herdr fails"
}

test_all_flag_shows_agentless_pane() {
  local out
  out=$(PATH="$BIN_DIR:$BASE_PATH" "$ROOT/bin/fm-panes.sh" --all) || fail "script exited non-zero with --all"

  # The agentless pane must appear in the output.
  printf '%s\n' "$out" | grep -q '^-' \
    || fail "--all did not include the agentless pane: $out"
  # It must carry the cwd as the 4th field.
  printf '%s\n' "$out" | grep -qF '/srv/hookless' \
    || fail "--all agentless pane missing cwd field: $out"
  pass "--all includes agentless panes with cwd column"
}

test_all_flag_output_format_agentless() {
  local out line
  out=$(PATH="$BIN_DIR:$BASE_PATH" "$ROOT/bin/fm-panes.sh" --all) || fail "script exited non-zero"
  line=$(printf '%s\n' "$out" | grep '^-')
  [ "$line" = "-	unknown	wV:p1X	/srv/hookless" ] \
    || fail "--all agentless line format wrong: '$line'"
  pass "--all agentless pane format is -<TAB>unknown<TAB>pane_id<TAB>cwd"
}

test_all_flag_total_count() {
  local out count
  out=$(PATH="$BIN_DIR:$BASE_PATH" "$ROOT/bin/fm-panes.sh" --all) || fail "script exited non-zero"
  count=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
  [ "$count" -eq 4 ] || fail "--all should return 4 panes (3 agents + 1 agentless), got $count"
  pass "--all returns all panes including agentless"
}

test_default_still_excludes_agentless() {
  local out
  out=$(PATH="$BIN_DIR:$BASE_PATH" "$ROOT/bin/fm-panes.sh") || fail "script exited non-zero"
  printf '%s\n' "$out" | grep -q '^-' \
    && fail "agentless pane appeared in default (no --all) output"
  pass "default mode still excludes agentless panes"
}

test_lists_panes_with_agents
test_filters_case_insensitive
test_filters_uppercase
test_no_match_returns_empty
test_panes_without_agent_excluded
test_output_format
test_all_flag_shows_agentless_pane
test_all_flag_output_format_agentless
test_all_flag_total_count
test_default_still_excludes_agentless
test_herdr_error_exits_nonzero
