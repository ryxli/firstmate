#!/usr/bin/env bash
# Fleet stop/clean/check authority, resting gates, and send steering terminals.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

cleanup() {
  if [ -n "${TMP_ROOT:-}" ]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-fleet-lifecycle.XXXXXX")

write_ok_inventory() {
  printf '{"state":"ok","trustworthy":true,"reason":"test-hook","observedAt":"2026-01-01T00:00:00.000Z","activeCount":0}\n' > "$1"
}

make_fake_herdr() {
  local dir=$1 fb="$1/fakebin"
  mkdir -p "$fb"
  cat > "$fb/herdr" <<'SH'
#!/usr/bin/env bash
set -u
printf 'herdr %s\n' "$*" >> "${FM_FAKE_HERDR_LOG:-/dev/null}"
case "${1:-}" in
  wait)
    # Event-backed wait surface used for exit retirement proof.
    exit "${FM_FAKE_WAIT_RC:-0}" ;;
  agent)
    case "${2:-}" in
      get)
        if [ -n "${FM_FAKE_NO_SLOT:-}" ]; then
          printf '{"error":"not found"}\n'
          exit 1
        fi
        # After agent.rename, only the renamed slot binds; fm-<id> is absent.
        if [ -n "${FM_FAKE_ONLY_SLOT:-}" ] && [ "${3:-}" != "${FM_FAKE_ONLY_SLOT}" ]; then
          printf '{"error":"not found"}\n'
          exit 1
        fi
        printf '{"result":{"agent":{"pane_id":"w1:p1","agent_status":"%s"}}}\n' "${FM_FAKE_AGENT_STATUS:-idle}"
        printf '{"agent_status":"%s","pane_id":"w1:p1"}\n' "${FM_FAKE_AGENT_STATUS:-idle}"
        exit 0 ;;
      wait)
        exit "${FM_FAKE_WAIT_RC:-0}" ;;
    esac ;;
  pane)
    case "${2:-}" in
      get)
        if [ -n "${FM_FAKE_NO_SLOT:-}" ]; then
          printf '{"error":{"code":"pane_not_found","message":"pane not found"}}\n'
          exit 1
        fi
        if [ -f "${FM_FAKE_SESSION_FILE:-}" ]; then
          cat "${FM_FAKE_SESSION_FILE}"
          exit 0
        fi
        printf '{"result":{"pane":{"pane_id":"w1:p1","agent_status":"%s","revision":%s,"agent_session":{"agent":"omp","value":"%s"}}}}\n' \
          "${FM_FAKE_AGENT_STATUS:-idle}" "${FM_FAKE_REVISION:-1}" "${FM_FAKE_SESSION:-sess-1}"
        exit 0 ;;
      read)
        printf '%s\n' "${FM_FAKE_PANE_LINES:-}"
        exit 0 ;;
      run)
        if [ -n "${FM_FAKE_ON_RUN:-}" ]; then
          # shellcheck disable=SC1090
          . "${FM_FAKE_ON_RUN}"
        fi
        exit "${FM_FAKE_RUN_RC:-0}" ;;
      send-keys)
        exit 0 ;;
      process-info)
        proc="${FM_FAKE_PROCESS:-agent}"
        if [ -f "${FM_FAKE_PROCESS_FILE:-}" ]; then
          proc=$(cat "${FM_FAKE_PROCESS_FILE}")
        fi
        if [ "$proc" = "err" ]; then
          exit 1
        fi
        if [ "$proc" = "shell" ]; then
          printf '{"result":{"process_info":{"foreground_processes":[{"cmdline":"zsh"}]}}}\n'
        else
          printf '{"result":{"process_info":{"foreground_processes":[{"cmdline":"omp"}]}}}\n'
        fi
        exit 0 ;;
    esac ;;
esac
exit 1
SH
  chmod +x "$fb/herdr"
  printf '%s\n' "$fb"
}

scaffold_controller() {
  local home=$1
  mkdir -p "$home/state" "$home/data" "$home/config" "$home/bin"
  printf 'name=firstmate\nrole=firstmate\nparent=captain\n' > "$home/config/identity"
  cat > "$home/data/backlog.md" <<'EOF'
## In flight

## Queued

## Done
EOF
  : > "$home/data/secondmates.md"
  touch "$home/AGENTS.md"
}

scaffold_secondmate() {
  local controller=$1 id=$2 home=$3
  mkdir -p "$home/state" "$home/data" "$home/config" "$home/bin"
  printf 'secondmate\n' > "$home/.fm-secondmate-home"
  printf 'name=%s\nrole=secondmate\nparent=firstmate\n' "$id" > "$home/config/identity"
  cat > "$home/data/backlog.md" <<'EOF'
## In flight

## Queued

## Done
EOF
  printf -- '- %s - specialist (home: %s)\n' "$id" "$home" >> "$controller/data/secondmates.md"
  cat > "$controller/state/${id}.meta" <<EOF
pane=w1:p1
harness=omp
kind=secondmate
agent_slot=${id}
home=${home}
EOF
}

test_secondmate_stop_refused() {
  local dir ctrl mate fb rc
  dir="$TMP_ROOT/auth-stop"
  ctrl="$dir/ctrl"
  mate="$dir/mate"
  mkdir -p "$dir"
  scaffold_controller "$ctrl"
  scaffold_secondmate "$ctrl" "alice" "$mate"
  fb=$(make_fake_herdr "$dir")

  rc=0
  PATH="$fb:$PATH" FM_HOME="$mate" "$ROOT/sbin/fm" fleet stop --all >"$dir/out" 2>"$dir/err" || rc=$?
  [ "$rc" != "0" ] || fail "secondmate fleet stop should refuse"
  grep -q 'authority' "$dir/err" "$dir/out" || fail "expected authority error"
  pass "secondmate fleet stop refused before mutation"
}

test_secondmate_check_allowed_with_controller_discovery() {
  local dir ctrl mate fb rc
  dir="$TMP_ROOT/auth-check"
  ctrl="$dir/ctrl"
  mate="$dir/mate"
  mkdir -p "$dir"
  scaffold_controller "$ctrl"
  scaffold_secondmate "$ctrl" "alice" "$mate"
  fb=$(make_fake_herdr "$dir")

  # Specialist FM_HOME: read-only check must discover controller (or fail closed honestly).
  # Point FIRSTMATE_HOME at controller so discovery succeeds without treating mate data as fleet.
  write_ok_inventory "$dir/inv.json"
  rc=0
  PATH="$fb:$PATH" FM_HOME="$mate" FIRSTMATE_HOME="$ctrl" \
    FM_ALLOW_TEST_HOOKS=1 FM_OMP_SUBAGENT_INVENTORY_FILE="$dir/inv.json" \
    "$ROOT/sbin/fm" fleet check >"$dir/out" 2>"$dir/err" || rc=$?
  grep -q 'check=omp-subagents' "$dir/out" || fail "check did not run omp-subagents line: $(cat "$dir/out" "$dir/err")"
  pass "secondmate can run read-only fleet check via controller discovery"
}

test_invalid_fm_home_refuses() {
  local dir fb rc
  dir="$TMP_ROOT/bad-home"
  mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  rc=0
  PATH="$fb:$PATH" FM_HOME="$dir/missing" "$ROOT/sbin/fm" fleet stop --all >"$dir/out" 2>"$dir/err" || rc=$?
  [ "$rc" != "0" ] || fail "missing FM_HOME should refuse"
  grep -qi 'FM_HOME\|authority\|does not exist' "$dir/err" "$dir/out" || fail "expected FM_HOME refusal"
  pass "invalid FM_HOME fails closed"
}

test_clean_refuses_active_scope() {
  local dir ctrl mate fb rc
  dir="$TMP_ROOT/active-scope"
  ctrl="$dir/ctrl"
  mate="$dir/mate"
  mkdir -p "$dir"
  scaffold_controller "$ctrl"
  scaffold_secondmate "$ctrl" "alice" "$mate"
  cat > "$ctrl/data/backlog.md" <<'EOF'
## In flight

## Queued
- [ ] t1 - keep me

## Done
EOF
  fb=$(make_fake_herdr "$dir")

  write_ok_inventory "$dir/inv.json"
  rc=0
  PATH="$fb:$PATH" FM_HOME="$ctrl" \
    FM_ALLOW_TEST_HOOKS=1 FM_OMP_SUBAGENT_INVENTORY_FILE="$dir/inv.json" \
    "$ROOT/sbin/fm" fleet clean >"$dir/out" 2>"$dir/err" || rc=$?
  [ "$rc" != "0" ] || fail "clean should refuse active scope"
  grep -q 'blocked-task key=firstmate/t1' "$dir/out" || fail "missing blocking key: $(cat "$dir/out")"
  grep -q 'active-scope' "$dir/out" "$dir/err" || fail "expected active-scope reason"
  # zero mutation: queued line still present
  grep -q 't1 - keep me' "$ctrl/data/backlog.md" || fail "backlog mutated"
  [ ! -e "$ctrl/data/fleet-clean.receipt.json" ] || fail "receipt should not be written on active-scope refuse"
  pass "clean refuses active scope with zero mutation"
}

test_clean_refuses_unknown_subagents() {
  local dir ctrl mate fb rc
  dir="$TMP_ROOT/subagents-unknown"
  ctrl="$dir/ctrl"
  mate="$dir/mate"
  mkdir -p "$dir"
  scaffold_controller "$ctrl"
  scaffold_secondmate "$ctrl" "alice" "$mate"
  fb=$(make_fake_herdr "$dir")

  # Production path: no test hook → inventory is unknown (env override must not mint trust).
  rc=0
  PATH="$fb:$PATH" FM_HOME="$ctrl" FM_OMP_SUBAGENT_INVENTORY=ok \
    "$ROOT/sbin/fm" fleet clean >"$dir/out" 2>"$dir/err" || rc=$?
  [ "$rc" != "0" ] || fail "clean should refuse unknown subagent inventory"
  grep -q 'omp-subagents' "$dir/out" "$dir/err" || fail "expected omp-subagents refusal"
  pass "clean refuses unknown omp-subagents inventory (env override ignored)"
}

test_stop_already_stopped() {
  local dir ctrl mate fb rc
  dir="$TMP_ROOT/stop-absent"
  ctrl="$dir/ctrl"
  mate="$dir/mate"
  mkdir -p "$dir"
  scaffold_controller "$ctrl"
  scaffold_secondmate "$ctrl" "alice" "$mate"
  fb=$(make_fake_herdr "$dir")

  rc=0
  PATH="$fb:$PATH" FM_HOME="$ctrl" FM_FAKE_NO_SLOT=1 \
    "$ROOT/sbin/fm" fleet stop alice >"$dir/out" 2>"$dir/err" || rc=$?
  grep -q 'state=already-stopped mate=alice' "$dir/out" || fail "expected already-stopped: $(cat "$dir/out" "$dir/err")"
  pass "stop classifies unbound mate as already-stopped"
}

test_exit_consumed_on_session_retirement() {
  local dir home fb rc sess
  dir="$TMP_ROOT/exit-retire"
  home="$dir/home"
  mkdir -p "$home/state" "$dir"
  cat > "$home/state/task.meta" <<'EOF'
pane=w1:p1
harness=omp
agent_slot=task
EOF
  sess="$dir/session.json"
  procf="$dir/process"
  printf '{"result":{"pane":{"pane_id":"w1:p1","agent_status":"idle","revision":1,"agent_session":{"agent":"omp","value":"sess-1"}}}}\n' > "$sess"
  printf 'agent\n' > "$procf"
  cat > "$dir/on-run.sh" <<EOF
printf '{"result":{"pane":{"pane_id":"w1:p1","agent_status":"unknown","revision":2}}}\n' > "$sess"
printf 'shell\n' > "$procf"
EOF
  fb=$(make_fake_herdr "$dir")

  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_SESSION_FILE="$sess" FM_FAKE_PROCESS_FILE="$procf" \
    FM_FAKE_ON_RUN="$dir/on-run.sh" FM_EXIT_RETIRE_TIMEOUT_MS=2000 \
    "$ROOT/sbin/fm" send fm-task --exit >"$dir/out" 2>"$dir/err" || rc=$?
  [ "$rc" = "0" ] || fail "exit should consume on session retirement rc=$rc $(cat "$dir/out" "$dir/err")"
  grep -q 'state=consumed' "$dir/out" || fail "expected state=consumed: $(cat "$dir/out")"
  pass "exit consumed when targeted session retires"
}

test_exit_renamed_slot_without_fm_alias() {
  local dir home fb rc sess
  dir="$TMP_ROOT/exit-renamed"
  home="$dir/home"
  mkdir -p "$home/state" "$dir"
  # Real secondmate shape after agent.rename("fran"): meta agent_slot=fran, fm-fran absent.
  cat > "$home/state/fran.meta" <<'EOF'
pane=w1:p1
harness=omp
agent_slot=fran
EOF
  sess="$dir/session.json"
  printf '{"result":{"pane":{"pane_id":"w1:p1","agent_status":"idle","revision":1,"agent_session":{"agent":"omp","value":"sess-fran"}}}}\n' > "$sess"
  cat > "$dir/on-run.sh" <<EOF
printf '{"result":{"pane":{"pane_id":"w1:p1","agent_status":"unknown","revision":2}}}\n' > "$sess"
EOF
  fb=$(make_fake_herdr "$dir")

  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_SESSION_FILE="$sess" FM_FAKE_ONLY_SLOT=fran \
    FM_FAKE_ON_RUN="$dir/on-run.sh" FM_EXIT_RETIRE_TIMEOUT_MS=2000 \
    "$ROOT/sbin/fm" send fm-fran --exit >"$dir/out" 2>"$dir/err" || rc=$?
  [ "$rc" = "0" ] || fail "renamed slot exit should consume rc=$rc $(cat "$dir/out" "$dir/err")"
  grep -q 'state=consumed' "$dir/out" || fail "expected consumed for renamed slot: $(cat "$dir/out")"
  pass "exit uses agent_slot only; absent fm-<id> alias is fine"
}

test_exit_refuses_missing_session_identity() {
  local dir home fb rc sess
  dir="$TMP_ROOT/exit-no-session"
  home="$dir/home"
  mkdir -p "$home/state" "$dir"
  cat > "$home/state/task.meta" <<'EOF'
pane=w1:p1
harness=omp
agent_slot=task
EOF
  sess="$dir/session.json"
  # Present pane, but no agent_session.value — cannot correlate.
  printf '{"result":{"pane":{"pane_id":"w1:p1","agent_status":"idle","revision":1}}}\n' > "$sess"
  fb=$(make_fake_herdr "$dir")

  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_SESSION_FILE="$sess" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    "$ROOT/sbin/fm" send fm-task --exit >"$dir/out" 2>"$dir/err" || rc=$?
  [ "$rc" != "0" ] || fail "empty session identity must not exit successfully"
  grep -q 'state=failed' "$dir/out" || fail "expected state=failed: $(cat "$dir/out")"
  if grep -q 'state=consumed' "$dir/out"; then fail "must not consume without pre-session id"; fi
  if grep -q 'pane run' "$dir/herdr.log"; then
    fail "must not deliver /quit without session identity"
  fi
  pass "exit refuses missing agent_session.value before delivery"
}

test_send_unknown_status_fails() {
  local dir home fb rc
  dir="$TMP_ROOT/send-unknown"
  home="$dir/home"
  mkdir -p "$home/state" "$dir"
  cat > "$home/state/task.meta" <<'EOF'
pane=w1:p1
harness=omp
EOF
  fb=$(make_fake_herdr "$dir")

  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_AGENT_STATUS=unknown FM_FAKE_PANE_LINES="" \
    "$ROOT/sbin/fm" send fm-task "steer please" >"$dir/out" 2>"$dir/err" || rc=$?
  [ "$rc" = "1" ] || fail "expected failed=1 for unknown status got $rc $(cat "$dir/out" "$dir/err")"
  grep -q 'state=failed' "$dir/out" || fail "expected state=failed"
  if grep -q 'state=delivered' "$dir/out"; then fail "unknown must not be delivered"; fi
  pass "text send with unknown status returns failed"
}

test_send_queued_when_working() {
  local dir home fb rc
  dir="$TMP_ROOT/send-queued"
  home="$dir/home"
  mkdir -p "$home/state" "$dir"
  cat > "$home/state/task.meta" <<'EOF'
pane=w1:p1
harness=omp
EOF
  fb=$(make_fake_herdr "$dir")

  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_AGENT_STATUS=working FM_FAKE_PANE_LINES="" \
    "$ROOT/sbin/fm" send fm-task "steer please" >"$dir/out" 2>"$dir/err" || rc=$?
  [ "$rc" = "76" ] || fail "expected queued=76 got $rc $(cat "$dir/out" "$dir/err")"
  grep -q 'state=queued' "$dir/out" || fail "expected state=queued"
  pass "text send while working returns queued=76"
}

test_send_delivered_when_idle() {
  local dir home fb rc
  dir="$TMP_ROOT/send-delivered"
  home="$dir/home"
  mkdir -p "$home/state" "$dir"
  cat > "$home/state/task.meta" <<'EOF'
pane=w1:p1
harness=omp
EOF
  fb=$(make_fake_herdr "$dir")

  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_AGENT_STATUS=idle FM_FAKE_PANE_LINES="" \
    "$ROOT/sbin/fm" send fm-task "steer please" >"$dir/out" 2>"$dir/err" || rc=$?
  [ "$rc" = "0" ] || fail "expected delivered=0 got $rc"
  grep -q 'state=delivered' "$dir/out" || fail "expected state=delivered"
  grep -qv 'state=consumed' "$dir/out" || fail "text must not claim consumed"
  pass "text send while idle returns delivered=0"
}

test_clean_archives_done_only() {
  local dir ctrl mate fb
  dir="$TMP_ROOT/archive-done"
  ctrl="$dir/ctrl"
  mate="$dir/mate"
  mkdir -p "$dir"
  scaffold_controller "$ctrl"
  scaffold_secondmate "$ctrl" "alice" "$mate"
  mkdir -p "$ctrl/data/artifacts" "$ctrl/data/reports" "$ctrl/data/home-skills" "$mate/config" "$mate/.omp/skills"
  : > "$ctrl/data/home-skills/alice"
  printf '{"taskId":"old","reviewState":"abandoned","updatedAt":"2026-01-01T00:00:00.000Z"}\n' \
    > "$ctrl/data/artifacts/old.json"
  printf 'keep-me\n' > "$ctrl/data/reports/note.md"
  cat > "$ctrl/data/backlog.md" <<'EOF'
## In flight

## Queued

## Done
- [x] d1 - finished work - proof (2026-01-02)
EOF
  fb=$(make_fake_herdr "$dir")

  write_ok_inventory "$dir/inv.json"
  PATH="$fb:$PATH" FM_HOME="$ctrl" FM_CODE_ROOT_OVERRIDE="$ROOT" FM_HOME_SKILLS_SMOKE=0 \
    FM_ALLOW_TEST_HOOKS=1 FM_OMP_SUBAGENT_INVENTORY_FILE="$dir/inv.json" FM_FAKE_NO_SLOT=1 \
    "$ROOT/sbin/fm" fleet clean >"$dir/out" 2>"$dir/err" || true
  grep -q 'fm-archive-id: firstmate/d1/' "$ctrl/data/done-archive.md" || fail "done not archived: $(ls -la "$ctrl/data"; cat "$dir/out" "$dir/err")"
  grep -q 'd1 - finished work' "$ctrl/data/done-archive.md" || fail "archive missing body"
  if grep -q 'd1' "$ctrl/data/backlog.md"; then fail "done still in backlog"; fi
  [ -f "$ctrl/data/artifacts/old.json" ] || fail "artifact was moved/deleted"
  [ -f "$ctrl/data/reports/note.md" ] || fail "report was deleted"
  PATH="$fb:$PATH" FM_HOME="$ctrl" FM_CODE_ROOT_OVERRIDE="$ROOT" FM_HOME_SKILLS_SMOKE=0 \
    FM_ALLOW_TEST_HOOKS=1 FM_OMP_SUBAGENT_INVENTORY_FILE="$dir/inv.json" FM_FAKE_NO_SLOT=1 \
    "$ROOT/sbin/fm" fleet clean >"$dir/out2" 2>"$dir/err2" || true
  count=$(grep -c 'fm-archive-id: firstmate/d1/' "$ctrl/data/done-archive.md")
  [ "$count" = "1" ] || fail "duplicate archive entries count=$count"
  pass "clean archives Done only; artifacts untouched; rerun dedupes"
}

test_exit_rejects_process_info_err_as_retirement() {
  local dir home fb rc sess
  dir="$TMP_ROOT/exit-proc-err"
  home="$dir/home"
  mkdir -p "$home/state" "$dir"
  cat > "$home/state/task.meta" <<'EOF'
pane=w1:p1
harness=omp
agent_slot=task
EOF
  sess="$dir/session.json"
  procf="$dir/process"
  printf '{"result":{"pane":{"pane_id":"w1:p1","agent_status":"idle","revision":1,"agent_session":{"agent":"omp","value":"sess-1"}}}}\n' > "$sess"
  printf 'agent\n' > "$procf"
  # Keep the original session value; flip process-info to err. Wait may return,
  # but correlated pane get must not treat process-info=err as retirement.
  cat > "$dir/on-run.sh" <<EOF
printf '{"result":{"pane":{"pane_id":"w1:p1","agent_status":"unknown","revision":2,"agent_session":{"agent":"omp","value":"sess-1"}}}}\n' > "$sess"
printf 'err\n' > "$procf"
EOF
  fb=$(make_fake_herdr "$dir")

  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_SESSION_FILE="$sess" FM_FAKE_PROCESS_FILE="$procf" \
    FM_FAKE_ON_RUN="$dir/on-run.sh" FM_EXIT_RETIRE_TIMEOUT_MS=500 FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    "$ROOT/sbin/fm" send fm-task --exit >"$dir/out" 2>"$dir/err" || rc=$?
  [ "$rc" != "0" ] || fail "process-info=err must not prove retirement"
  grep -q 'state=failed' "$dir/out" || fail "expected state=failed: $(cat "$dir/out")"
  if grep -q 'state=consumed' "$dir/out"; then fail "must not claim consumed on process-info=err"; fi
  pass "exit rejects process-info=err as retirement"
}

test_unmarked_home_not_controller() {
  local dir fb rc
  dir="$TMP_ROOT/unmarked"
  mkdir -p "$dir/home/state" "$dir/home/data" "$dir/home/config"
  # Existing directory with no firstmate identity/marker evidence.
  fb=$(make_fake_herdr "$dir")
  rc=0
  PATH="$fb:$PATH" FM_HOME="$dir/home" \
    "$ROOT/sbin/fm" fleet stop --all >"$dir/out" 2>"$dir/err" || rc=$?
  [ "$rc" != "0" ] || fail "unmarked home must not get mutation authority"
  grep -qi 'evidence\|authority\|firstmate\|controller' "$dir/err" "$dir/out" || fail "expected evidence refusal: $(cat "$dir/err" "$dir/out")"
  pass "unmarked directory does not default to controller authority"
}

test_secondmate_stop_refused
test_secondmate_check_allowed_with_controller_discovery
test_invalid_fm_home_refuses
test_unmarked_home_not_controller
test_clean_refuses_active_scope
test_clean_refuses_unknown_subagents
test_stop_already_stopped
test_exit_consumed_on_session_retirement
test_exit_renamed_slot_without_fm_alias
test_exit_refuses_missing_session_identity
test_exit_rejects_process_info_err_as_retirement
test_send_unknown_status_fails
test_send_queued_when_working
test_send_delivered_when_idle
test_clean_archives_done_only

printf 'all fleet lifecycle tests passed\n'
