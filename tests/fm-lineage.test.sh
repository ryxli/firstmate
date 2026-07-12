#!/usr/bin/env bash
# Behavior tests for sbin/fm-lineage.sh, the read-only lineage visualizer.
#
# These exercise the real reconstruction path with a fake `herdr` on PATH that
# records every invocation and emits the documented one-shot JSON shapes
# (result.pane / result.tab / result.workspace with pane_id / tab_id /
# workspace_id / label / agent_status), plus fabricated state/*.meta files in a
# temp FM_HOME.
#
# What is asserted:
#   - the tree groups tasks under their LIVE workspace_id / tab_id / pane_id and
#     shows the herdr display labels + agent_status + the EXACT task id (the
#     random suffix never appears in a label but is recovered from the meta stem);
#   - agent_status falls back to `pane get` when `agent get` reports
#     agent_not_found (the tool tolerates non-agent panes);
#   - the tool is strictly READ-ONLY: the fake herdr log contains ONLY get /
#     list / current verbs, and never a mutating verb such as rename/create/run;
#   - --flat prints one line per task and --json emits the normalized model;
#   - with herdr unreachable the tree degrades to a state-only view that still
#     shows the task ids and recorded pane, and exits 0.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINEAGE="$ROOT/sbin/fm-lineage.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-lineage-test.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# A fake herdr that records invocations and answers the read-only get/current
# verbs the lineage tool uses, keyed by id. `agent get` always reports
# agent_not_found so the pane-get status fallback is exercised.
make_fake_herdr() {
  local dir=$1 fakebin
  fakebin="$dir/fakebin"
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
log="${FM_FAKE_HERDR_LOG:?}"
printf '%s\n' "$*" >> "$log"
case "${1:-} ${2:-}" in
  "pane current")
    curpane="${FM_FAKE_CURRENT_PANE:-w8:p10}"
    printf '{"result":{"pane":{"pane_id":"%s"}}}\n' "$curpane"; exit 0 ;;
  "pane get")
    case "${3:-}" in
      w8:p10) printf '{"result":{"pane":{"pane_id":"w8:p10","workspace_id":"w8","tab_id":"w8:t4","label":"fix-login","agent_status":"working","cwd":"/wt/fix-login-k3","foreground_cwd":"/wt/fix-login-k3"}}}\n' ;;
      w8:p11)
        p11_status="${FM_FAKE_P11_STATUS:-idle}"
        printf '{"result":{"pane":{"pane_id":"w8:p11","workspace_id":"w8","tab_id":"w8:t5","label":"add-cache","agent_status":"%s","cwd":"/wt/add-cache-q7","foreground_cwd":"/wt/add-cache-q7"}}}\n' "$p11_status" ;;
      *) printf '{"error":"pane_not_found"}\n' ;;
    esac; exit 0 ;;
  "tab get")
    case "${3:-}" in
      w8:t4) printf '{"result":{"tab":{"tab_id":"w8:t4","workspace_id":"w8","label":"fix-login","agent_status":"working"}}}\n' ;;
      w8:t5) printf '{"result":{"tab":{"tab_id":"w8:t5","workspace_id":"w8","label":"add-cache","agent_status":"idle"}}}\n' ;;
      *) printf '{"error":"tab_not_found"}\n' ;;
    esac; exit 0 ;;
  "workspace get")
    case "${3:-}" in
      w8) printf '{"result":{"workspace":{"workspace_id":"w8","label":"myproj","agent_status":"working","active_tab_id":"w8:t4"}}}\n' ;;
      *) printf '{"error":"workspace_not_found"}\n' ;;
    esac; exit 0 ;;
  "agent get")
    printf '{"error":"agent_not_found"}\n'; exit 0 ;;
esac
# Any unexpected (possibly mutating) subcommand still logs above; answer benign.
printf '{}\n'
exit 0
SH
  chmod +x "$fakebin/herdr"
  printf '%s\n' "$fakebin"
}

# Build a self-contained firstmate home with Mate identity and two live ship
# tasks placed in the same project workspace. Echoes the home path.
make_home() {
  local name=$1 home
  home="$TMP_ROOT/$name"
  mkdir -p "$home/state" "$home/config" "$home/data"
  printf 'name=Mate\nrole=Main firstmate crew supervisor\nparent=captain\n' > "$home/config/identity"
  {
    printf 'pane=w8:p10\ntab=w8:t4\nworktree=/wt/fix-login-k3\nproject=/proj/myproj\n'
    printf 'harness=omp\nkind=ship\nmode=no-mistakes\nyolo=off\n'
    printf 'domain=myproj\nworkspace=myproj\nworker=fix-login\nagent_identity=omp\n'
  } > "$home/state/fix-login-k3.meta"
  {
    printf 'pane=w8:p11\ntab=w8:t5\nworktree=/wt/add-cache-q7\nproject=/proj/myproj\n'
    printf 'harness=omp\nkind=ship\nmode=direct-PR\nyolo=off\n'
    printf 'domain=myproj\nworkspace=myproj\nworker=add-cache\nagent_identity=omp\n'
  } > "$home/state/add-cache-q7.meta"
  printf '%s\n' "$home"
}

run_lineage() {
  local home=$1 fakebin=$2; shift 2
  # Pin the harness env so the ROOT line is deterministic. fm-lineage.sh detects
  # the root harness LIVE via fm-harness.sh (env markers, then ps ancestry), so
  # without a forced marker the root resolves to `unknown` on a host with no OMP
  # env (e.g. CI), breaking the omp root-line assertions. Mirror
  # fm-harness.test.sh's hermetic style: force OMPCODE=1 and clear its rivals.
  env -u CLAUDECODE -u PI_CODING_AGENT \
    OMPCODE=1 \
    PATH="$fakebin:/usr/bin:/bin" \
    FM_ROOT_OVERRIDE='' FM_STATE_OVERRIDE='' FM_CONFIG_OVERRIDE='' FM_DATA_OVERRIDE='' \
    FM_HOME="$home" \
    FM_FAKE_HERDR_LOG="$home/herdr.log" \
    "$LINEAGE" "$@" 2>&1
}

# Assert every logged herdr invocation used only a read-only verb.
assert_read_only() {
  local log=$1 bad
  bad=$(awk '{print $2}' "$log" | grep -vE '^(get|list|current)$' || true)
  [ -z "$bad" ] || fail "mutating herdr verb(s) invoked: [$bad]; log: $(tr '\n' '|' < "$log")"
  ! grep -qiE '(^| )(rename|create|run|start|close|kill|stop|remove|delete|new|move|split) ' "$log" \
    || fail "mutating herdr subcommand present in log: $(tr '\n' '|' < "$log")"
  ! grep -qi 'agent rename' "$log" || fail "herdr agent rename invoked"
}

test_text_tree_live_lineage() {
  local home fakebin out
  home=$(make_home text)
  fakebin=$(make_fake_herdr "$home")
  out=$(run_lineage "$home" "$fakebin") || fail "lineage failed: $out"

  printf '%s\n' "$out" | grep -qF 'workspace myproj [w8] status=working' \
    || fail "workspace line missing/incorrect: $out"
  [ "$(printf '%s\n' "$out" | grep -cF 'workspace myproj [w8]')" -eq 1 ] \
    || fail "two same-workspace tasks should share one workspace node: $out"

  printf '%s\n' "$out" | grep -qF 'tab fix-login [w8:t4] status=working' \
    || fail "tab A line missing/incorrect: $out"
  printf '%s\n' "$out" | grep -qF 'tab add-cache [w8:t5] status=idle' \
    || fail "tab B line missing/incorrect: $out"

  printf '%s\n' "$out" | grep -qF 'pane fix-login [w8:p10] agent=omp status=working' \
    || fail "pane A line missing label/agent/status: $out"
  printf '%s\n' "$out" | grep -qF 'cwd=/wt/fix-login-k3' \
    || fail "pane A cwd missing: $out"
  printf '%s\n' "$out" | grep -qF 'pane add-cache [w8:p11] agent=omp status=idle' \
    || fail "pane B line missing label/agent/status: $out"

  # The random-suffixed task id is recovered exactly from the meta stem.
  printf '%s\n' "$out" | grep -qE '^ +task fix-login-k3 kind=ship mode=no-mistakes worker=fix-login domain=myproj' \
    || fail "task A line missing exact id/fields: $out"
  printf '%s\n' "$out" | grep -qE '^ +task add-cache-q7 kind=ship mode=direct-PR worker=add-cache domain=myproj' \
    || fail "task B line missing exact id/fields: $out"

  printf '%s\n' "$out" | grep -qF 'omp session firstmate' \
    || fail "root session line missing omp harness/firstmate prefix: $out"
  printf '%s\n' "$out" | grep -qF 'supervisor=Mate parent=captain identity=omp' \
    || fail "root session line missing supervisor/parent/identity: $out"

  assert_read_only "$home/herdr.log"
  pass "text tree groups by live workspace/tab/pane with display labels, status, exact task ids"
}

test_flat_one_line_per_task() {
  local home fakebin out lines
  home=$(make_home flat)
  fakebin=$(make_fake_herdr "$home")
  out=$(run_lineage "$home" "$fakebin" --flat) || fail "flat failed: $out"

  printf '%s\n' "$out" | grep -qF 'task=fix-login-k3 ' || fail "flat missing task A: $out"
  printf '%s\n' "$out" | grep -qF 'task=add-cache-q7 ' || fail "flat missing task B: $out"
  printf '%s\n' "$out" | grep -qF 'pane=w8:p10 status=working' || fail "flat A pane/status wrong: $out"
  lines=$(printf '%s\n' "$out" | grep -c '^task=')
  [ "$lines" -eq 2 ] || fail "expected one flat line per task (2), got $lines: $out"

  assert_read_only "$home/herdr.log"
  pass "--flat prints exactly one scriptable line per task"
}

test_json_normalized_model() {
  local home fakebin out
  home=$(make_home json)
  fakebin=$(make_fake_herdr "$home")
  out=$(run_lineage "$home" "$fakebin" --json) || fail "json failed: $out"

  printf '%s' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d["supervisor"] == "Mate", d.get("supervisor")
ws = d["workspaces"]
assert len(ws) == 1 and ws[0]["id"] == "w8" and ws[0]["label"] == "myproj", ws
tabs = ws[0]["tabs"]
labels = sorted(t["label"] for t in tabs)
assert labels == ["add-cache", "fix-login"], labels
panes = {p["task"]["id"]: p for t in tabs for p in t["panes"]}
a = panes["fix-login-k3"]
assert a["id"] == "w8:p10" and a["agent_identity"] == "omp" and a["agent_status"] == "working", a
assert a["task"]["kind"] == "ship" and a["task"]["worker"] == "fix-login", a["task"]
b = panes["add-cache-q7"]
assert b["agent_status"] == "idle" and b["task"]["mode"] == "direct-PR", b
assert d["fleet_status"] == "working", d.get("fleet_status")
assert d["armed_check_count"] == 0, d.get("armed_check_count")
assert d["session"]["current_pane_status"] == "working", d["session"]
print("json-ok")
' >/dev/null || fail "json model assertions failed: $out"

  assert_read_only "$home/herdr.log"
  pass "--json emits the normalized workspace/tab/pane/task model"
}

test_json_fleet_status_blocked_is_passthrough() {
  local home fakebin out
  home=$(make_home fleet-blocked)
  fakebin=$(make_fake_herdr "$home")
  out=$(FM_FAKE_CURRENT_PANE=w8:p11 FM_FAKE_P11_STATUS=blocked run_lineage "$home" "$fakebin" --json) \
    || fail "blocked run failed: $out"

  printf '%s' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d["session"]["current_pane_status"] == "blocked", d["session"]
assert d["fleet_status"] == "blocked", d.get("fleet_status")
' >/dev/null || fail "blocked supervisor should pass through to fleet_status: $out"

  assert_read_only "$home/herdr.log"
  pass "a blocked supervisor derives fleet_status=blocked"
}

test_json_fleet_status_tending_for_active_task() {
  local home fakebin out
  home=$(make_home fleet-tending-child)
  fakebin=$(make_fake_herdr "$home")
  out=$(FM_FAKE_CURRENT_PANE=w8:p11 run_lineage "$home" "$fakebin" --json) \
    || fail "tending child run failed: $out"

  printf '%s' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d["session"]["current_pane_status"] == "idle", d["session"]
assert d["fleet_status"] == "tending", d.get("fleet_status")
assert d["armed_check_count"] == 0, d.get("armed_check_count")
' >/dev/null || fail "idle home with a working child should be tending: $out"

  assert_read_only "$home/herdr.log"
  pass "an idle home with a working task derives fleet_status=tending"
}

test_json_fleet_status_tending_for_armed_check() {
  local home fakebin out
  home="$TMP_ROOT/fleet-tending-check"
  mkdir -p "$home/state" "$home/config" "$home/data"
  printf 'name=Mate\nrole=Main firstmate crew supervisor\nparent=captain\n' > "$home/config/identity"
  : > "$home/state/pending-a1.check.sh"
  fakebin=$(make_fake_herdr "$home")
  out=$(FM_FAKE_CURRENT_PANE=w8:p11 run_lineage "$home" "$fakebin" --json) \
    || fail "tending check run failed: $out"

  printf '%s' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d["session"]["current_pane_status"] == "idle", d["session"]
assert d["armed_check_count"] == 1, d.get("armed_check_count")
assert d["fleet_status"] == "tending", d.get("fleet_status")
' >/dev/null || fail "idle home with an armed check should be tending: $out"

  assert_read_only "$home/herdr.log"
  pass "an idle home with an armed check derives fleet_status=tending"
}

test_json_fleet_status_free_without_obligations() {
  local home fakebin out
  home="$TMP_ROOT/fleet-free"
  mkdir -p "$home/state" "$home/config" "$home/data"
  printf 'name=Mate\nrole=Main firstmate crew supervisor\nparent=captain\n' > "$home/config/identity"
  fakebin=$(make_fake_herdr "$home")
  out=$(FM_FAKE_CURRENT_PANE=w8:p11 run_lineage "$home" "$fakebin" --json) \
    || fail "free run failed: $out"

  printf '%s' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d["session"]["current_pane_status"] == "idle", d["session"]
assert d["armed_check_count"] == 0, d.get("armed_check_count")
assert d["fleet_status"] == "free", d.get("fleet_status")
' >/dev/null || fail "idle home without obligations should be free: $out"

  assert_read_only "$home/herdr.log"
  pass "an idle home without obligations derives fleet_status=free"
}

test_degraded_when_herdr_unreachable() {
  local home out
  home=$(make_home degraded)
  # No fake herdr: PATH has no `herdr`, so the tool must degrade, not fail.
  out=$(PATH="/usr/bin:/bin" \
    FM_ROOT_OVERRIDE='' FM_STATE_OVERRIDE='' FM_CONFIG_OVERRIDE='' FM_DATA_OVERRIDE='' \
    FM_HOME="$home" "$LINEAGE") \
    || fail "degraded run should still exit 0: $out"

  printf '%s\n' "$out" | grep -qF 'task fix-login-k3 kind=ship' \
    || fail "degraded tree dropped the task: $out"
  printf '%s\n' "$out" | grep -qF 'herdr=unreachable' \
    || fail "degraded tree missing herdr=unreachable marker: $out"
  printf '%s\n' "$out" | grep -qF '[w8:p10]' \
    || fail "degraded tree should still show the recorded pane id: $out"
  pass "herdr unreachable degrades to a state-only tree and exits 0"
}

# --recursive must descend into a secondmate home (meta kind=secondmate, home=)
# and nest that child firstmate's own tasks under the parent task.
test_recursive_nests_secondmate_home() {
  local parent child fakebin out
  parent=$(make_home recursive)
  child="$TMP_ROOT/recursive-child"
  mkdir -p "$child/state" "$child/config"
  printf 'name=Reef\nrole=Secondmate crew supervisor\nparent=Mate\n' > "$child/config/identity"
  {
    printf 'pane=w8:p12\ntab=w8:t6\nworktree=/wt/child-r1\nproject=/proj/myproj\n'
    printf 'harness=omp\nkind=ship\nmode=no-mistakes\nyolo=off\n'
    printf 'domain=childproj\nworkspace=childproj\nworker=child-task\nagent_identity=omp\n'
  } > "$child/state/child-r1.meta"
  # A secondmate task in the parent whose home= points at the child firstmate.
  {
    printf 'pane=w8:p13\ntab=w8:t7\nworktree=/wt/sm-host\nproject=/proj/myproj\n'
    printf 'harness=omp\nkind=secondmate\nmode=charter\nyolo=off\n'
    printf 'domain=myproj\nworkspace=myproj\nworker=home\nagent_identity=omp\n'
    printf 'home=%s\n' "$child"
  } > "$parent/state/sm-reef.meta"
  fakebin=$(make_fake_herdr "$parent")
  out=$(run_lineage "$parent" "$fakebin" --recursive) || fail "recursive failed: $out"

  # The parent secondmate task carries the home= pointer to the child firstmate.
  printf '%s\n' "$out" | grep -qF 'task sm-reef kind=secondmate mode=charter worker=home' \
    || fail "recursive: parent secondmate task missing: $out"
  printf '%s\n' "$out" | grep -qF "home=$child" \
    || fail "recursive: secondmate task missing home= pointer: $out"
  # The child home renders as an INDENTED (nested) session under the parent; the
  # unindented root line cannot match '^ +', so this proves real nesting.
  printf '%s\n' "$out" | grep -qE '^ +omp session firstmate home=' \
    || fail "recursive: child home not nested (no indented session line): $out"
  printf '%s\n' "$out" | grep -qF "session firstmate home=$child supervisor=Reef parent=Mate identity=omp" \
    || fail "recursive: child secondmate home line wrong: $out"
  # ...and the child's own task is reconstructed inside that nested home.
  printf '%s\n' "$out" | grep -qE '^ +task child-r1 kind=ship .*worker=child-task' \
    || fail "recursive: child task not rendered under nested home: $out"

  assert_read_only "$parent/herdr.log"
  pass "--recursive descends into a secondmate home and nests its child task"
}

# A live herdr that no longer knows the recorded pane (pane_not_found) must
# degrade that task to a missing-pane view, still render it, and exit 0.
test_missing_pane_degrades_to_state_view() {
  local home fakebin out
  home="$TMP_ROOT/missing-pane"
  mkdir -p "$home/state" "$home/config"
  printf 'name=Mate\nrole=Main firstmate crew supervisor\nparent=captain\n' > "$home/config/identity"
  # Recorded pane w8:p99 is unknown to the fake herdr, so `pane get` returns
  # pane_not_found while herdr itself stays reachable (HERDR_OK=1 + missing pane).
  {
    printf 'pane=w8:p99\ntab=w8:t4\nworktree=/wt/ghost\nproject=/proj/myproj\n'
    printf 'harness=omp\nkind=ship\nmode=no-mistakes\nyolo=off\n'
    printf 'domain=myproj\nworkspace=myproj\nworker=ghost\nagent_identity=omp\n'
  } > "$home/state/ghost-z9.meta"
  fakebin=$(make_fake_herdr "$home")
  out=$(run_lineage "$home" "$fakebin") || fail "missing-pane run should exit 0: $out"

  printf '%s\n' "$out" | grep -qE '^ +task ghost-z9 kind=ship .*worker=ghost' \
    || fail "missing-pane: task dropped from degraded tree: $out"
  printf '%s\n' "$out" | grep -qF 'pane ghost [w8:p99] agent=omp status=unknown missing-pane' \
    || fail "missing-pane: pane not marked missing-pane: $out"

  assert_read_only "$home/herdr.log"
  pass "a vanished pane (herdr pane_not_found) degrades to missing-pane and exits 0"
}


# Unit tests for fm_json_get (the pure-JSON accessor in sbin/fm-herdr-lib.sh).
# These do NOT use a fake herdr; they source the library directly and call the
# function on controlled input.

FM_HERDR_LIB="$ROOT/sbin/fm-herdr-lib.sh"

test_fm_json_get_basic() {
  # shellcheck source=sbin/fm-herdr-lib.sh
  . "$FM_HERDR_LIB"
  out=$(printf '{"result":{"pane_id":"w8:p3"}}' | fm_json_get result pane_id)
  [ "$out" = "w8:p3" ] || fail "fm_json_get basic: expected w8:p3, got [$out]"
  pass "fm_json_get resolves a nested key path"
}

test_fm_json_get_missing_key() {
  # shellcheck source=sbin/fm-herdr-lib.sh
  . "$FM_HERDR_LIB"
  out=$(printf '{"result":{}}' | fm_json_get result pane_id)
  [ -z "$out" ] || fail "fm_json_get missing key: expected empty, got [$out]"
  pass "fm_json_get returns nothing on a missing key"
}

test_fm_json_get_bad_json() {
  # shellcheck source=sbin/fm-herdr-lib.sh
  . "$FM_HERDR_LIB"
  out=$(printf 'not-json' | fm_json_get result pane_id)
  [ -z "$out" ] || fail "fm_json_get bad JSON: expected empty, got [$out]"
  pass "fm_json_get returns nothing on bad JSON"
}


test_text_tree_live_lineage
test_flat_one_line_per_task
test_json_normalized_model
test_json_fleet_status_blocked_is_passthrough
test_json_fleet_status_tending_for_active_task
test_json_fleet_status_tending_for_armed_check
test_json_fleet_status_free_without_obligations
test_degraded_when_herdr_unreachable
test_recursive_nests_secondmate_home
test_missing_pane_degrades_to_state_view
test_fm_json_get_basic
test_fm_json_get_missing_key
test_fm_json_get_bad_json
