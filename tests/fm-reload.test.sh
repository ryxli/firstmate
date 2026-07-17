#!/usr/bin/env bash
# Behavior tests for sbin/fm-reload.sh.
#
# Covers:
#   (a) explicit pane + session-id captured pre-quit  -> omp --resume <id> + proof passes
#   (b) explicit pane + no session-id, no --allow-fresh -> fail closed BEFORE /quit
#   (c) pane from herdr pane current                  -> auto-detected, resume used
#   (d) --cmd template with {id}                      -> substituted correctly
#   (e) --cmd literal (no {id})                       -> used verbatim
#   (f) --cmd {id} but no session-id found            -> error, non-zero exit (before /quit)
#   (g) no pane determinable                          -> error, non-zero exit
#   (h) --allow-fresh + no session-id                 -> omp -c used (not error)
#   (i) fm-<name> durable target                      -> resolved via state meta, resume used
#   (j) post-reload proof timeout                     -> omp does not restart -> exit 1
#   (k) session id mismatch after reload              -> continuity proof fails -> exit 1
#   (l) scrollback miss                               -> deterministic omp-store lookup
#   (m) self-reload (own pane)                        -> detached worker, exact resume, success logged
#   (n) self-reload, no session id, no --allow-fresh  -> fail closed before handoff
#   (o) self-reload, omp never restarts               -> worker FAILED line observable
#   (p) pane closes with agent (inline)               -> replacement pane, exact resume
#   (q) self-reload + pane closes                     -> detached worker recovers in replacement pane
#   (r) durable fm-<name> target + pane closes        -> meta rebound to replacement pane= and tab=
#   (s) durable fm-<name> target, pane survives       -> meta untouched (no rebind)
#   (t) self-reload durable target + pane closes      -> detached worker rebinds meta
#   (u) stale pane agent after visible exit           -> process-info proves restored shell
#   (v) foreground OMP still running                  -> exit wait times out without relaunch
#   (w) restored shell                                -> exact captured session resumed
#   (x) relaunch                                      -> one command-string argument, no standalone --
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELOAD="$ROOT/sbin/fm-reload.sh"
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

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-reload-tests.XXXXXX")

# ---------------------------------------------------------------------------
# Fake herdr factory.
#
# The fake is file-system stateful: once a non-/quit 'pane run' is recorded
# (the resume command), a "resumed" marker file is created. Subsequent
# 'pane get' calls return FM_FAKE_HERDR_POST_AGENT (default "omp") and
# 'pane read' returns FM_FAKE_HERDR_POST_SESSION (default FM_FAKE_HERDR_SESSION).
#
# Env vars:
#   FM_FAKE_HERDR_LOG          - path where every herdr call is appended
#   FM_FAKE_HERDR_STATE_DIR    - directory for the "resumed" marker file
#   FM_FAKE_HERDR_AGENT        - pane get .agent BEFORE resume (default "omp")
#   FM_FAKE_HERDR_POST_AGENT   - pane get .agent AFTER resume (default "omp")
#   FM_FAKE_HERDR_STATUS       - pane get agent_status BEFORE resume (default "idle")
#   FM_FAKE_HERDR_POST_STATUS  - pane get agent_status AFTER resume (default "idle")
#   FM_FAKE_HERDR_SCREEN       - visible screen state BEFORE resume (default: STATUS)
#   FM_FAKE_HERDR_POST_SCREEN  - visible screen state AFTER resume (default: POST_STATUS)
#   FM_FAKE_HERDR_SCREEN_AFTER - visible state after SCREEN_AFTER_READS reads
#   FM_FAKE_HERDR_SCREEN_AFTER_READS - read count at which SCREEN_AFTER applies
#   FM_FAKE_HERDR_AGENT_SESSION_ID - Herdr agent_session_id BEFORE resume
#   FM_FAKE_HERDR_POST_AGENT_SESSION_ID - agent_session_id AFTER resume
#   FM_FAKE_HERDR_REPLACEMENT_AGENT_SESSION_ID - identity after GET threshold
#   FM_FAKE_HERDR_REPLACE_AFTER_GET - get count at which replacement identity appears
#   FM_FAKE_HERDR_LEGACY_AGENT_SESSION - legacy pane encoding before resume:
#                                1|omp, non-omp, or malformed (default 0)
#   FM_FAKE_HERDR_POST_LEGACY_AGENT_SESSION - legacy pane encoding after resume
#   FM_FAKE_HERDR_SESSION      - session id in pane read BEFORE resume (default "")
#   FM_FAKE_HERDR_POST_SESSION - session id in pane read AFTER resume (default: FM_FAKE_HERDR_SESSION)
#   FM_FAKE_HERDR_CURRENT      - pane_id returned by pane current (empty = failure)
#   FM_FAKE_HERDR_CWD          - cwd in pane get response (default "")
#   FM_FAKE_HERDR_REPLACEMENT_CWD - cwd after replacement GET threshold
#   FM_FAKE_HERDR_SESSION_PATH_PRESENT - include agent_session_path key (0/1)
#   FM_FAKE_HERDR_SESSION_PATH - agent_session_path BEFORE replacement
#   FM_FAKE_HERDR_REPLACEMENT_SESSION_PATH_PRESENT - path-key presence after replacement
#   FM_FAKE_HERDR_REPLACEMENT_SESSION_PATH - agent_session_path AFTER replacement
#   FM_FAKE_HERDR_PANE_CLOSES  - set to 1 to simulate herdr closing the target
#                                pane once /quit was sent: pane get for any
#                                pane except the replacement (wR:p1) errors
#                                with pane_not_found. 'tab create' returns a
#                                replacement root pane wR:p1.
#   FM_FAKE_HERDR_POST_QUIT_PROCESS - foreground process after /quit and before
#                                resume (default "-zsh")
# ---------------------------------------------------------------------------
make_fake_herdr() {
  local dir=$1 fakebin log
  fakebin="$dir/fakebin"
  log="$dir/herdr.log"
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
STATE_DIR="${FM_FAKE_HERDR_STATE_DIR:-/tmp}"
RESUMED_FILE="$STATE_DIR/resumed"
GET_COUNT_FILE="$STATE_DIR/get-count"
READ_COUNT_FILE="$STATE_DIR/read-count"
LOG="${FM_FAKE_HERDR_LOG:-/dev/null}"
printf 'herdr %s\n' "$*" >> "$LOG"
case "${1:-}" in
  pane)
    case "${2:-}" in
      current)
        cur="${FM_FAKE_HERDR_CURRENT:-}"
        if [ -z "$cur" ]; then exit 1; fi
        printf '{"id":"cli:pane:current","result":{"pane":{"pane_id":"%s"}}}\n' "$cur"
        exit 0 ;;
      get)
        pane="${3:-}"
        if [ -n "${FM_FAKE_HERDR_PANE_CLOSES:-}" ] && [ -f "$STATE_DIR/quit" ] && [ "$pane" != "wR:p1" ]; then
          printf '{"error":{"code":"pane_not_found","message":"pane %s not found"},"id":"cli:pane:get"}\n' "$pane"
          exit 0
        fi
        get_count=0
        [ -f "$GET_COUNT_FILE" ] && get_count=$(cat "$GET_COUNT_FILE")
        get_count=$((get_count + 1))
        printf '%s\n' "$get_count" > "$GET_COUNT_FILE"
        cwd="${FM_FAKE_HERDR_CWD:-}"
        session_path_present="${FM_FAKE_HERDR_SESSION_PATH_PRESENT:-0}"
        session_path="${FM_FAKE_HERDR_SESSION_PATH-}"
        if [ -f "$RESUMED_FILE" ]; then
          agent="${FM_FAKE_HERDR_POST_AGENT:-omp}"
          status="${FM_FAKE_HERDR_POST_STATUS:-idle}"
          session_id="${FM_FAKE_HERDR_POST_AGENT_SESSION_ID-${FM_FAKE_HERDR_AGENT_SESSION_ID:-fake-agent-session}}"
        elif [ -f "$STATE_DIR/quit" ]; then
          agent=""
          status="unknown"
          session_id="${FM_FAKE_HERDR_AGENT_SESSION_ID:-fake-agent-session}"
        else
          agent="${FM_FAKE_HERDR_AGENT:-omp}"
          status="${FM_FAKE_HERDR_STATUS:-idle}"
          session_id="${FM_FAKE_HERDR_AGENT_SESSION_ID:-fake-agent-session}"
        fi
        if [ -n "${FM_FAKE_HERDR_REPLACE_AFTER_GET:-}" ] && [ "$get_count" -ge "$FM_FAKE_HERDR_REPLACE_AFTER_GET" ]; then
          session_id="${FM_FAKE_HERDR_REPLACEMENT_AGENT_SESSION_ID:-replacement-agent-session}"
          cwd="${FM_FAKE_HERDR_REPLACEMENT_CWD-$cwd}"
          session_path_present="${FM_FAKE_HERDR_REPLACEMENT_SESSION_PATH_PRESENT-${session_path_present}}"
          session_path="${FM_FAKE_HERDR_REPLACEMENT_SESSION_PATH-${session_path}}"
        fi
        if [ -f "$RESUMED_FILE" ]; then
          legacy_mode="${FM_FAKE_HERDR_POST_LEGACY_AGENT_SESSION:-0}"
        else
          legacy_mode="${FM_FAKE_HERDR_LEGACY_AGENT_SESSION:-0}"
        fi
        case "$legacy_mode" in
          1|omp)
            printf '{"id":"cli:pane:get","result":{"pane":{"agent_status":"%s","cwd":"%s","workspace_id":"w1","label":"fake-mate","agent_session":{"agent":"omp","kind":"id","value":"%s"}}}}\n' "$status" "$cwd" "$session_id"
            exit 0 ;;
          non-omp)
            printf '{"id":"cli:pane:get","result":{"pane":{"agent_status":"%s","cwd":"%s","workspace_id":"w1","label":"fake-mate","agent_session":{"agent":"other","kind":"id","value":"%s"}}}}\n' "$status" "$cwd" "$session_id"
            exit 0 ;;
          malformed)
            printf '{"id":"cli:pane:get","result":{"pane":{"agent_status":"%s","cwd":"%s","workspace_id":"w1","label":"fake-mate","agent_session":[]}}}\n' "$status" "$cwd"
            exit 0 ;;
        esac
        if [ "$session_path_present" = "1" ]; then
          printf '{"id":"cli:pane:get","result":{"pane":{"agent":"%s","agent_status":"%s","cwd":"%s","workspace_id":"w1","label":"fake-mate","agent_session_id":"%s","agent_session_path":"%s"}}}\n' "$agent" "$status" "$cwd" "$session_id" "$session_path"
        else
          printf '{"id":"cli:pane:get","result":{"pane":{"agent":"%s","agent_status":"%s","cwd":"%s","workspace_id":"w1","label":"fake-mate","agent_session_id":"%s"}}}\n' "$agent" "$status" "$cwd" "$session_id"
        fi
        exit 0 ;;
      process-info)
        if [ -f "$STATE_DIR/quit" ] && [ ! -f "$RESUMED_FILE" ]; then
          process="${FM_FAKE_HERDR_POST_QUIT_PROCESS:--zsh}"
        else
          process="bun /opt/omp/scripts/omp.ts"
        fi
        printf '{"result":{"process_info":{"foreground_processes":[{"argv0":"%s","name":"%s","cmdline":"%s"}]}}}\n' "$process" "$process" "$process"
        exit 0 ;;
      read)
        if [ "${4:-}" = "--source" ] && [ "${5:-}" = "visible" ]; then
          read_count=0
          [ -f "$READ_COUNT_FILE" ] && read_count=$(cat "$READ_COUNT_FILE")
          read_count=$((read_count + 1))
          printf '%s\n' "$read_count" > "$READ_COUNT_FILE"
          if [ -f "$RESUMED_FILE" ]; then
            screen_status="${FM_FAKE_HERDR_POST_SCREEN-${FM_FAKE_HERDR_POST_STATUS:-idle}}"
          else
            screen_status="${FM_FAKE_HERDR_SCREEN-${FM_FAKE_HERDR_STATUS:-idle}}"
            if [ -n "${FM_FAKE_HERDR_SCREEN_AFTER_READS:-}" ] && [ "$read_count" -ge "$FM_FAKE_HERDR_SCREEN_AFTER_READS" ]; then
              screen_status="${FM_FAKE_HERDR_SCREEN_AFTER-${screen_status}}"
            fi
          fi
          case "$screen_status" in
            # Exact OMP idle compositor frame: a metadata header followed by
            # the bottom border, with no intermediate interior row.
            idle|done|empty-box) printf '╭── ⬢ OMP · ◔ low ▶ 📁 /repo ──╮\n╰─                          ─╯\n' ;;
            v17-empty-box) printf '╭── ⬢ OMP · ◔ low ▶────╮\n╰─                          ─╯\n' ;;
            # ANSI styling around the exact idle frame must be ignored.
            ansi-empty-box) printf '\033[1;36m╭── ⬢ OMP · ◔ low ▶ 📁 /repo ──╮\033[0m\n╰─                          ─╯\n' ;;
            # A historical spinner is safe only when another nonblank line
            # separates it from the final empty compositor frame.
            stale-spinner) printf '⠁ Working\nprevious output\n╭── ⬢ OMP · ◔ low ▶ 📁 /repo ──╮\n╰─                          ─╯\n' ;;
            # The active spinner is nearest the frame after a blank line.
            working|blocked|spinner-box|esc-box|idle-then-active|idle-then-spinner) printf '⠇ Working ⟦esc⟧\n\n╭── ⬢ OMP · ◔ low ▶ 📁 /repo ──╮\n╰─                          ─╯\n' ;;
            # Non-empty or malformed frame interiors are unsafe.
            tab-box) printf '╭── ⬢ OMP · ◔ low ▶ 📁 /repo ──╮\n╰─\t                          ─╯\n' ;;
            nonascii-space-box) printf '╭── ⬢ OMP · ◔ low ▶ 📁 /repo ──╮\n╰─                         ─╯\n' ;;
            malformed-box) printf '╭── ⬢ OMP · ◔ low ▶ 📁 /repo ──╮\n╰───────────────────────────╯\n' ;;
            nonempty-box) printf '╭── ⬢ OMP · ◔ low ▶ 📁 /repo ──╮\n│ prompt                   │\n╰─                          ─╯\n' ;;
            unknown-box|unknown) printf 'unrecognized visible output\n' ;;
            *) printf '' ;;
          esac
          exit 0
        fi
        if [ -f "$RESUMED_FILE" ]; then
          sid="${FM_FAKE_HERDR_POST_SESSION-${FM_FAKE_HERDR_SESSION:-}}"
        else
          sid="${FM_FAKE_HERDR_SESSION:-}"
        fi
        if [ -n "$sid" ]; then
          printf 'session started\nomp --resume %s\nsome other line\n' "$sid"
        else
          printf 'session started\nsome other line\n'
        fi
        exit 0 ;;
      run)
        # /quit leaves a marker (drives pane-closes simulation);
        # non-slash commands = relaunch; create the resumed marker.
        cmd="${4:-}"
        printf 'pane-run argc=%s pane=<%s> command=<%s>\n' "$#" "${3:-}" "${4:-}" >> "$LOG"
        case "$cmd" in
          /quit) touch "$STATE_DIR/quit" ;;
          /*) ;;
          ?*) touch "$RESUMED_FILE" ;;
        esac
        exit 0 ;;
    esac ;;
  tab)
    case "${2:-}" in
      create)
        printf '{"id":"cli:tab:create","result":{"root_pane":{"pane_id":"wR:p1"},"tab":{"tab_id":"wR:t1"}}}\n'
        exit 0 ;;
    esac ;;
  agent)
    case "${2:-}" in
      get)
        # fm_resolve_live_pane calls this for fm-* targets;
        # return empty so it falls back to the state meta file.
        printf ''
        exit 0 ;;
    esac ;;
esac
exit 0
SH
  chmod +x "$fakebin/herdr"
  : > "$log"
  printf '%s\n' "$fakebin"
}

# Run fm-reload.sh with PATH mocked to fake herdr; guard skipped via env
# by default (set FM_RELOAD_NO_GUARD= empty to exercise the self-reload guard).
# Caller sets FM_FAKE_HERDR_* vars before calling.
# Args: case_dir [fm-reload.sh args...]
run_reload() {
  local dir=$1; shift
  local fakebin="$dir/fakebin"
  local log="$dir/herdr.log"
  local state_dir="$dir/fake-state"
  mkdir -p "$state_dir"
  FM_FAKE_HERDR_LOG="$log" \
  FM_FAKE_HERDR_STATE_DIR="$state_dir" \
  FM_ROOT_OVERRIDE="$ROOT" \
  FM_STATE_OVERRIDE="${FM_STATE_OVERRIDE:-$dir/state}" \
  FM_RELOAD_NO_GUARD="${FM_RELOAD_NO_GUARD-1}" \
  FM_RELOAD_QUIT_GRACE=0 \
  FM_RELOAD_TIMEOUT="${FM_RELOAD_TIMEOUT:-1}" \
  FM_RELOAD_PROOF_TIMEOUT="${FM_RELOAD_PROOF_TIMEOUT:-1}" \
  FM_RELOAD_SELF_TIMEOUT="${FM_RELOAD_SELF_TIMEOUT:-1}" \
    PATH="$fakebin:$PATH" \
    "$RELOAD" "$@"
}

# Wait for the detached self-reload worker's final log line (succeeded/FAILED).
# Args: reload_log [max_wait_seconds]
wait_worker_done() {
  local log=$1 max=${2:-10} i=0
  while [ "$i" -lt $((max * 4)) ]; do
    if grep -q "detached self-reload of pane .* \(succeeded\|FAILED\)" "$log" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
    i=$((i + 1))
  done
  return 1
}

# Read the recorded herdr call log.
herdr_log() {
  local dir=$1
  cat "$dir/herdr.log" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# (a) Explicit pane + session id -> omp --resume <id>; post-reload proof passes
# ---------------------------------------------------------------------------
test_resume_path() {
  local CASE="$TMP_ROOT/case-a"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-000000000001"
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" w1:p1 >/dev/null || fail "(a) fm-reload.sh exited non-zero"

  herdr_log "$CASE" | grep -q "pane run w1:p1 omp --resume $sid" \
    || fail "(a) expected 'pane run w1:p1 omp --resume $sid' in herdr log"

  pass "(a) explicit pane + session id -> omp --resume <id>; proof passed"
}

# ---------------------------------------------------------------------------
# (b) No session id, no --allow-fresh -> fail closed BEFORE /quit
# ---------------------------------------------------------------------------
test_fail_closed_no_session() {
  local CASE="$TMP_ROOT/case-b"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="" \
    run_reload "$CASE" w2:p1 >/dev/null 2>/dev/null \
    && fail "(b) expected non-zero exit when no session id and no --allow-fresh"

  # /quit must NOT have been sent: the pane was left untouched.
  herdr_log "$CASE" | grep -q "pane run w2:p1 /quit" \
    && fail "(b) /quit was sent despite fail-closed; pane should be untouched"

  pass "(b) no session id + no --allow-fresh -> fail closed before /quit"
}

# ---------------------------------------------------------------------------
# (c) No pane arg -> pane detected from herdr pane current
# ---------------------------------------------------------------------------
test_auto_pane_current() {
  local CASE="$TMP_ROOT/case-c"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-000000000003"
  FM_FAKE_HERDR_CURRENT="w3:p1" \
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" >/dev/null || fail "(c) fm-reload.sh exited non-zero"

  herdr_log "$CASE" | grep -q "pane current" \
    || fail "(c) expected pane current call in herdr log"
  herdr_log "$CASE" | grep -q "pane run w3:p1 omp --resume $sid" \
    || fail "(c) expected resume on auto-detected pane w3:p1"

  pass "(c) no pane arg -> auto-detected via pane current, resume used"
}

# ---------------------------------------------------------------------------
# (d) --cmd template with {id} -> id substituted
# ---------------------------------------------------------------------------
test_cmd_template_substitution() {
  local CASE="$TMP_ROOT/case-d"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-000000000004"
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" w4:p1 --cmd "myomp --resume {id} --extra-flag" >/dev/null \
    || fail "(d) fm-reload.sh exited non-zero"

  herdr_log "$CASE" | grep -q "pane run w4:p1 myomp --resume $sid --extra-flag" \
    || fail "(d) expected substituted cmd in herdr log"

  pass "(d) --cmd {id} template -> substituted with session id"
}

# ---------------------------------------------------------------------------
# (e) --cmd literal (no {id}) -> used verbatim
# ---------------------------------------------------------------------------
test_cmd_literal() {
  local CASE="$TMP_ROOT/case-e"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="" \
    run_reload "$CASE" w5:p1 --cmd "omp --fresh-start" >/dev/null \
    || fail "(e) fm-reload.sh exited non-zero"

  herdr_log "$CASE" | grep -q "pane run w5:p1 omp --fresh-start" \
    || fail "(e) expected literal cmd in herdr log"

  pass "(e) --cmd literal -> used verbatim"
}

# ---------------------------------------------------------------------------
# (f) --cmd {id} but no session id found -> error before /quit
# ---------------------------------------------------------------------------
test_cmd_template_no_session_id_errors() {
  local CASE="$TMP_ROOT/case-f"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="" \
    run_reload "$CASE" w6:p1 --cmd "omp --resume {id}" >/dev/null 2>/dev/null \
    && fail "(f) expected non-zero exit when {id} unreplaceable"

  # /quit must NOT have been sent.
  herdr_log "$CASE" | grep -q "pane run w6:p1 /quit" \
    && fail "(f) /quit was sent despite {id} substitution failure"

  pass "(f) --cmd {id} with no session id -> non-zero exit before /quit"
}

# ---------------------------------------------------------------------------
# (g) no pane determinable -> error, non-zero exit
# ---------------------------------------------------------------------------
test_no_pane_determinable_errors() {
  local CASE="$TMP_ROOT/case-g"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  FM_FAKE_HERDR_CURRENT="" \
    run_reload "$CASE" >/dev/null 2>/dev/null \
    && fail "(g) expected non-zero exit when pane is undeterminable"

  pass "(g) no pane determinable -> non-zero exit"
}

# ---------------------------------------------------------------------------
# (h) --allow-fresh + no session id -> omp -c used, not an error
# ---------------------------------------------------------------------------
test_allow_fresh_fallback() {
  local CASE="$TMP_ROOT/case-h"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="" \
    run_reload "$CASE" w7:p1 --allow-fresh >/dev/null \
    || fail "(h) expected zero exit with --allow-fresh"

  herdr_log "$CASE" | grep -q "pane run w7:p1 /quit" \
    || fail "(h) expected /quit in herdr log"
  herdr_log "$CASE" | grep -q "pane run w7:p1 omp -c" \
    || fail "(h) expected 'omp -c' as relaunch command"

  pass "(h) --allow-fresh + no session id -> omp -c used"
}

# ---------------------------------------------------------------------------
# (i) fm-<name> durable target -> resolved via state meta, resume used
# ---------------------------------------------------------------------------
test_fm_name_target() {
  local CASE="$TMP_ROOT/case-i"
  mkdir -p "$CASE/state"
  make_fake_herdr "$CASE" >/dev/null

  # Seed a state meta file for "testmate" pointing to pane w9:p1.
  printf 'pane=w9:p1\n' > "$CASE/state/testmate.meta"

  local sid="abcd1234-0000-0000-0000-000000000009"
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
  FM_STATE_OVERRIDE="$CASE/state" \
    run_reload "$CASE" fm-testmate >/dev/null \
    || fail "(i) fm-reload.sh exited non-zero for fm-<name> target"

  herdr_log "$CASE" | grep -q "pane run w9:p1 omp --resume $sid" \
    || fail "(i) expected resume on pane w9:p1 resolved from fm-testmate"

  pass "(i) fm-<name> target resolved via state meta, resume used"
}

# ---------------------------------------------------------------------------
# (i2) fm-<name> durable secondmate target -> FM_HOME and pinned crew_model
# are restored on the resume command, not just dropped on the floor.
# ---------------------------------------------------------------------------
test_secondmate_pin_restored_on_reload() {
  local CASE="$TMP_ROOT/case-i2"
  mkdir -p "$CASE/state"
  make_fake_herdr "$CASE" >/dev/null

  local home="$CASE/secondmate-home"
  mkdir -p "$home"
  printf 'pane=w10:p1\nkind=secondmate\nhome=%s\ncrew_model=anthropic/opus\n' "$home" \
    > "$CASE/state/pinmate.meta"

  local sid="abcd1234-0000-0000-0000-000000000010"
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
  FM_STATE_OVERRIDE="$CASE/state" \
    run_reload "$CASE" fm-pinmate >/dev/null \
    || fail "(i2) fm-reload.sh exited non-zero for secondmate pin restoration"

  local sq_home
  sq_home=$(. "$ROOT/sbin/fm-spawn-lib.sh" && fm_shell_quote "$home")
  herdr_log "$CASE" | grep -qF "pane run w10:p1 FM_ROOT_OVERRIDE= FM_STATE_OVERRIDE= FM_DATA_OVERRIDE= FM_PROJECTS_OVERRIDE= FM_CONFIG_OVERRIDE= FM_HOME=$sq_home omp --model 'anthropic/opus' --resume $sid" \
    || fail "(i2) expected FM_HOME prefix and --model on the restored resume command"

  pass "(i2) durable secondmate target restores FM_HOME and pinned crew_model on reload"
}

# ---------------------------------------------------------------------------
# (i3) fm-<name> durable non-secondmate (ship/scout) target -> a pinned
# crew_model is still restored, but no FM_HOME prefix is added (that pin only
# ever applied to secondmates).
# ---------------------------------------------------------------------------
test_ship_crew_model_restored_no_fm_home() {
  local CASE="$TMP_ROOT/case-i3"
  mkdir -p "$CASE/state"
  make_fake_herdr "$CASE" >/dev/null

  printf 'pane=w11:p1\nkind=ship\ncrew_model=openai/gpt-5\n' > "$CASE/state/shipmate.meta"

  local sid="abcd1234-0000-0000-0000-000000000011"
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
  FM_STATE_OVERRIDE="$CASE/state" \
    run_reload "$CASE" fm-shipmate >/dev/null \
    || fail "(i3) fm-reload.sh exited non-zero for ship crew_model restoration"

  herdr_log "$CASE" | grep -qF "pane run w11:p1 omp --model 'openai/gpt-5' --resume $sid" \
    || fail "(i3) expected --model restored without an FM_HOME prefix"
  herdr_log "$CASE" | grep -q "FM_HOME=" \
    && fail "(i3) a non-secondmate reload must never add an FM_HOME prefix"

  pass "(i3) durable ship target restores pinned crew_model without an FM_HOME prefix"
}

# ---------------------------------------------------------------------------
# (i4) raw pane id target (no fm-<name>) whose pane happens to match a
# secondmate's recorded meta -> reverse lookup still restores the pin, so
# "reload whatever pane I'm in" is not a second gap.
# ---------------------------------------------------------------------------
test_reverse_lookup_restores_pin_for_raw_pane_target() {
  local CASE="$TMP_ROOT/case-i4"
  mkdir -p "$CASE/state"
  make_fake_herdr "$CASE" >/dev/null

  local home="$CASE/reverse-secondmate-home"
  mkdir -p "$home"
  printf 'pane=w12:p1\nkind=secondmate\nhome=%s\ncrew_model=anthropic/opus\n' "$home" \
    > "$CASE/state/reversemate.meta"

  local sid="abcd1234-0000-0000-0000-000000000012"
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
  FM_STATE_OVERRIDE="$CASE/state" \
    run_reload "$CASE" w12:p1 >/dev/null \
    || fail "(i4) fm-reload.sh exited non-zero for raw-pane reverse lookup"

  local sq_home
  sq_home=$(. "$ROOT/sbin/fm-spawn-lib.sh" && fm_shell_quote "$home")
  herdr_log "$CASE" | grep -qF "pane run w12:p1 FM_ROOT_OVERRIDE= FM_STATE_OVERRIDE= FM_DATA_OVERRIDE= FM_PROJECTS_OVERRIDE= FM_CONFIG_OVERRIDE= FM_HOME=$sq_home omp --model 'anthropic/opus' --resume $sid" \
    || fail "(i4) raw pane target did not restore the pin via reverse meta lookup"

  pass "(i4) raw pane target reverse-matches state meta to restore the pin too"
}

# ---------------------------------------------------------------------------
# (j) post-reload proof timeout: omp does not restart -> exit 1
# ---------------------------------------------------------------------------
test_proof_timeout_fails() {
  local CASE="$TMP_ROOT/case-j"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-00000000000a"
  # FM_FAKE_HERDR_POST_AGENT="shell" means the pane never becomes omp again after relaunch.
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
  FM_FAKE_HERDR_POST_AGENT="shell" \
    run_reload "$CASE" wa:p1 >/dev/null 2>/dev/null \
    && fail "(j) expected non-zero exit when omp does not restart"

  # /quit must have been sent (we got past the pre-quit checks).
  herdr_log "$CASE" | grep -q "pane run wa:p1 /quit" \
    || fail "(j) expected /quit in herdr log before proof timeout"

  pass "(j) post-reload proof timeout: omp does not restart -> exit 1"
}

# ---------------------------------------------------------------------------
# (k) session id mismatch after reload -> continuity proof fails -> exit 1
# ---------------------------------------------------------------------------
test_session_id_mismatch_proof() {
  local CASE="$TMP_ROOT/case-k"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-00000000000b"
  local wrong_sid="ffff0000-0000-0000-0000-000000000000"
  # Pre-quit pane read returns $sid; post-reload pane read returns $wrong_sid.
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
  FM_FAKE_HERDR_POST_SESSION="$wrong_sid" \
    run_reload "$CASE" wb:p1 >/dev/null 2>/dev/null \
    && fail "(k) expected non-zero exit on session id mismatch"

  # The resume command must have targeted the correct (pre-quit) session id.
  herdr_log "$CASE" | grep -q "pane run wb:p1 omp --resume $sid" \
    || fail "(k) expected resume with original session id $sid"

  pass "(k) session id mismatch after reload -> continuity proof exits 1"
}

# ---------------------------------------------------------------------------
# (l) Scrollback empty -> deterministic lookup from omp session store succeeds
# ---------------------------------------------------------------------------
test_deterministic_session_lookup() {
  local CASE="$TMP_ROOT/case-l"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="cccc0000-1111-7000-aaaa-000000000001"
  local fake_home="$CASE/home"
  local cwd="$fake_home/fake/project/alpha"
  local rel="/fake/project/alpha"
  local bucket="${rel//\//-}"
  local store="$CASE/fake-sessions/$bucket"
  mkdir -p "$store"
  # Seed a session file: the stem after the first '_' is the session id omp uses.
  touch "$store/2026-07-04T00-00-00-000Z_${sid}.jsonl"

  # Scrollback returns no session id; cwd points to the right bucket under HOME;
  # store has the file. FM_FAKE_HERDR_POST_SESSION makes the continuity proof pass.
  HOME="$fake_home" \
  FM_OMP_SESSION_STORE="$CASE/fake-sessions" \
  FM_FAKE_HERDR_CWD="$cwd" \
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="" \
  FM_FAKE_HERDR_POST_SESSION="$sid" \
    run_reload "$CASE" wl:p1 2>/dev/null \
    || fail "(l) fm-reload.sh exited non-zero when deterministic lookup available"

  herdr_log "$CASE" | grep -q "pane run wl:p1 omp --resume $sid" \
    || fail "(l) expected 'pane run wl:p1 omp --resume $sid' in herdr log"

  pass "(l) scrollback miss -> deterministic lookup from omp store recovers session id"
}

# ---------------------------------------------------------------------------
# (m) self-reload (auto-detect = own pane) -> handed to detached worker,
#     which quits, resumes the exact session, and logs success
# ---------------------------------------------------------------------------
test_self_reload_detaches() {
  local CASE="$TMP_ROOT/case-m"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-00000000000d"
  local out
  out=$(FM_RELOAD_NO_GUARD='' \
    FM_FAKE_HERDR_CURRENT="wm:p1" \
    FM_FAKE_HERDR_AGENT="" \
    FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE") || fail "(m) expected zero exit from the handoff caller"

  printf '%s' "$out" | grep -q "handed to detached worker" \
    || fail "(m) expected handoff message from caller"

  local rlog="$CASE/state/.reload.wm-p1.log"
  wait_worker_done "$rlog" || fail "(m) detached worker never wrote a final outcome to $rlog"

  grep -q "detached self-reload of pane wm:p1 succeeded" "$rlog" \
    || fail "(m) expected success line in $rlog"
  herdr_log "$CASE" | grep -q "pane run wm:p1 /quit" \
    || fail "(m) expected /quit sent by the detached worker"
  herdr_log "$CASE" | grep -q "pane run wm:p1 omp --resume $sid" \
    || fail "(m) expected exact-session resume by the detached worker"

  pass "(m) self-reload -> detached worker quits, resumes exact session, logs success"
}

# ---------------------------------------------------------------------------
# (n) self-reload with no session id and no --allow-fresh -> fails closed
#     synchronously BEFORE any handoff or /quit
# ---------------------------------------------------------------------------
test_self_reload_fails_closed_before_handoff() {
  local CASE="$TMP_ROOT/case-n"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  FM_RELOAD_NO_GUARD='' \
  FM_FAKE_HERDR_CURRENT="wn:p1" \
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="" \
    run_reload "$CASE" wn:p1 >/dev/null 2>/dev/null \
    && fail "(n) expected non-zero exit when no session id and no --allow-fresh"

  herdr_log "$CASE" | grep -q "pane run wn:p1 /quit" \
    && fail "(n) /quit was sent despite fail-closed"
  [ -e "$CASE/state/.reload.wn-p1.log" ] \
    && fail "(n) a detached worker was spawned despite fail-closed"

  pass "(n) self-reload with no session id -> fails closed before handoff"
}

# ---------------------------------------------------------------------------
# (o) self-reload where omp never restarts -> worker logs FAILED (observable)
# ---------------------------------------------------------------------------
test_self_reload_worker_failure_observable() {
  local CASE="$TMP_ROOT/case-o"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-00000000000e"
  FM_RELOAD_NO_GUARD='' \
  FM_FAKE_HERDR_CURRENT="wo:p1" \
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
  FM_FAKE_HERDR_POST_AGENT="shell" \
    run_reload "$CASE" wo:p1 >/dev/null \
    || fail "(o) expected zero exit from the handoff caller"

  local rlog="$CASE/state/.reload.wo-p1.log"
  wait_worker_done "$rlog" || fail "(o) detached worker never wrote a final outcome to $rlog"

  grep -q "detached self-reload of pane wo:p1 FAILED" "$rlog" \
    || fail "(o) expected FAILED line in $rlog"

  pass "(o) self-reload worker failure -> FAILED recorded in progress log"
}

# ---------------------------------------------------------------------------
# (p) target pane closes with the agent (inline reload) -> replacement pane
#     provisioned, exact session resumed there, continuity proof passes
# ---------------------------------------------------------------------------
test_pane_closes_replacement_pane() {
  local CASE="$TMP_ROOT/case-p"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-00000000000f"
  FM_FAKE_HERDR_PANE_CLOSES=1 \
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" wp:p1 >/dev/null 2>/dev/null \
    || fail "(p) expected zero exit when a replacement pane hosts the resume"

  herdr_log "$CASE" | grep -q "pane run wp:p1 /quit" \
    || fail "(p) expected /quit on the original pane"
  herdr_log "$CASE" | grep -q "tab create" \
    || fail "(p) expected a replacement tab/pane to be created"
  herdr_log "$CASE" | grep -q "pane run wR:p1 omp --resume $sid" \
    || fail "(p) expected exact-session resume in the replacement pane wR:p1"

  pass "(p) pane closes with agent -> replacement pane created, exact resume proven"
}

# ---------------------------------------------------------------------------
# (q) the observed live failure end to end: self-reload AND herdr closes the
#     pane after /quit -> detached worker provisions a replacement pane and
#     proves the exact session resumed there
# ---------------------------------------------------------------------------
test_self_reload_pane_closes_full_recovery() {
  local CASE="$TMP_ROOT/case-q"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-000000000010"
  FM_RELOAD_NO_GUARD='' \
  FM_FAKE_HERDR_CURRENT="wq:p1" \
  FM_FAKE_HERDR_PANE_CLOSES=1 \
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" >/dev/null \
    || fail "(q) expected zero exit from the handoff caller"

  local rlog="$CASE/state/.reload.wq-p1.log"
  wait_worker_done "$rlog" || fail "(q) detached worker never wrote a final outcome to $rlog"

  grep -q "detached self-reload of pane wq:p1 succeeded (session live in pane wR:p1)" "$rlog" \
    || fail "(q) expected success line naming the replacement pane in $rlog"
  herdr_log "$CASE" | grep -q "pane run wq:p1 /quit" \
    || fail "(q) expected /quit on the original pane"
  herdr_log "$CASE" | grep -q "pane run wR:p1 omp --resume $sid" \
    || fail "(q) expected exact-session resume in the replacement pane"

  pass "(q) self-reload + pane closed -> detached worker recovers in replacement pane"
}

# ---------------------------------------------------------------------------
# (r) durable fm-<name> target whose pane closes with the agent -> the state
#     meta is rebound to the replacement pane= and tab= before success
# ---------------------------------------------------------------------------
test_durable_target_meta_rebound() {
  local CASE="$TMP_ROOT/case-r"
  mkdir -p "$CASE/state"
  make_fake_herdr "$CASE" >/dev/null

  # Seed a durable mate meta: pane wr:p1 in tab w1:t9, plus an unrelated key
  # that the rebind must preserve.
  printf 'pane=wr:p1\ntab=w1:t9\nworktree=/wt/rebind-mate\n' > "$CASE/state/rebind-mate.meta"

  local sid="abcd1234-0000-0000-0000-000000000011"
  FM_FAKE_HERDR_PANE_CLOSES=1 \
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
  FM_STATE_OVERRIDE="$CASE/state" \
    run_reload "$CASE" fm-rebind-mate >/dev/null 2>/dev/null \
    || fail "(r) expected zero exit when the replacement pane hosts the resume"

  herdr_log "$CASE" | grep -q "pane run wR:p1 omp --resume $sid" \
    || fail "(r) expected exact-session resume in the replacement pane wR:p1"
  grep -q '^pane=wR:p1$' "$CASE/state/rebind-mate.meta" \
    || fail "(r) expected meta pane= rebound to replacement pane wR:p1"
  grep -q '^tab=wR:t1$' "$CASE/state/rebind-mate.meta" \
    || fail "(r) expected meta tab= rebound to replacement tab wR:t1"
  grep -q '^worktree=/wt/rebind-mate$' "$CASE/state/rebind-mate.meta" \
    || fail "(r) expected unrelated meta keys preserved by the rebind"

  pass "(r) durable target + pane closes -> meta rebound to replacement pane= and tab="
}

# ---------------------------------------------------------------------------
# (s) durable fm-<name> target whose pane survives the quit -> the state
#     meta is left untouched (no replacement pane, nothing to rebind)
# ---------------------------------------------------------------------------
test_durable_target_meta_untouched_when_pane_survives() {
  local CASE="$TMP_ROOT/case-s"
  mkdir -p "$CASE/state"
  make_fake_herdr "$CASE" >/dev/null

  printf 'pane=ws:p1\ntab=w1:t3\n' > "$CASE/state/steady-mate.meta"

  local sid="abcd1234-0000-0000-0000-000000000012"
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
  FM_STATE_OVERRIDE="$CASE/state" \
    run_reload "$CASE" fm-steady-mate >/dev/null \
    || fail "(s) fm-reload.sh exited non-zero for surviving durable target"

  herdr_log "$CASE" | grep -q "pane run ws:p1 omp --resume $sid" \
    || fail "(s) expected resume in the original pane ws:p1"
  printf 'pane=ws:p1\ntab=w1:t3\n' | cmp -s - "$CASE/state/steady-mate.meta" \
    || fail "(s) expected meta untouched when the original pane hosts the resume"

  pass "(s) durable target, pane survives -> meta untouched"
}

# ---------------------------------------------------------------------------
# (t) self-reload of a durable fm-<name> target whose pane closes -> the
#     detached worker rebinds the meta to the replacement pane= and tab=
# ---------------------------------------------------------------------------
test_self_reload_durable_target_meta_rebound() {
  local CASE="$TMP_ROOT/case-t"
  mkdir -p "$CASE/state"
  make_fake_herdr "$CASE" >/dev/null

  printf 'pane=wt:p1\ntab=w1:t7\n' > "$CASE/state/self-mate.meta"

  local sid="abcd1234-0000-0000-0000-000000000013"
  FM_RELOAD_NO_GUARD='' \
  FM_FAKE_HERDR_CURRENT="wt:p1" \
  FM_FAKE_HERDR_PANE_CLOSES=1 \
  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="$sid" \
  FM_STATE_OVERRIDE="$CASE/state" \
    run_reload "$CASE" fm-self-mate >/dev/null \
    || fail "(t) expected zero exit from the handoff caller"

  local rlog="$CASE/state/.reload.wt-p1.log"
  wait_worker_done "$rlog" || fail "(t) detached worker never wrote a final outcome to $rlog"

  grep -q "detached self-reload of pane wt:p1 succeeded (session live in pane wR:p1)" "$rlog" \
    || fail "(t) expected success line naming the replacement pane in $rlog"
  grep -q '^pane=wR:p1$' "$CASE/state/self-mate.meta" \
    || fail "(t) expected meta pane= rebound by the detached worker"
  grep -q '^tab=wR:t1$' "$CASE/state/self-mate.meta" \
    || fail "(t) expected meta tab= rebound by the detached worker"

  pass "(t) self-reload of durable target + pane closes -> detached worker rebinds meta"
}

# ---------------------------------------------------------------------------
# (u) Observed mismatch: pane.agent remains "omp" after /quit even though the
#     foreground process is the restored shell. Process inspection must prove
#     exit promptly instead of trusting stale pane identity until timeout.
# ---------------------------------------------------------------------------
test_stale_agent_shell_detection() {
  local CASE="$TMP_ROOT/case-stale-agent-shell"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-000000000014"
  FM_FAKE_HERDR_AGENT="omp" \
  FM_FAKE_HERDR_POST_QUIT_PROCESS="-zsh" \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" wu:p1 >/dev/null 2>/dev/null \
    || fail "(u) stale pane agent hid the restored shell and prevented reload"

  herdr_log "$CASE" | grep -q "pane process-info --pane wu:p1" \
    || fail "(u) expected foreground process inspection after /quit"

  pass "(u) stale pane agent + shell process -> exit detected promptly"
}

# ---------------------------------------------------------------------------
# (v) A genuinely live OMP foreground process must keep the reload fail-closed:
#     timeout with no relaunch, even if metadata alone could be stale.
# ---------------------------------------------------------------------------
test_live_omp_process_times_out() {
  local CASE="$TMP_ROOT/case-live-omp-process"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-000000000015"
  FM_FAKE_HERDR_AGENT="omp" \
  FM_FAKE_HERDR_POST_QUIT_PROCESS="bun /opt/omp/scripts/omp.ts" \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" wv:p1 >/dev/null 2>/dev/null \
    && fail "(v) expected timeout while OMP remained the foreground process"

  herdr_log "$CASE" | grep -q "pane run wv:p1 omp --resume" \
    && fail "(v) relaunched before the live OMP process exited"

  pass "(v) live OMP foreground process -> timeout without relaunch"
}

# ---------------------------------------------------------------------------
# (w) Shell detection must resume the exact session captured before /quit.
# ---------------------------------------------------------------------------
test_shell_detection_resumes_exact_session() {
  local CASE="$TMP_ROOT/case-shell-resume"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-000000000016"
  FM_FAKE_HERDR_AGENT="omp" \
  FM_FAKE_HERDR_POST_QUIT_PROCESS="-zsh" \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" ww:p1 >/dev/null 2>/dev/null \
    || fail "(w) reload failed after the shell returned"

  herdr_log "$CASE" | grep -q "pane run ww:p1 omp --resume $sid" \
    || fail "(w) expected exact captured session $sid"

  pass "(w) restored shell -> exact captured session resumed"
}

# ---------------------------------------------------------------------------
# (x) herdr pane run accepts the relaunch as one command-string argument.
#     A standalone -- would be forwarded to the target shell as the command.
# ---------------------------------------------------------------------------
test_resume_command_is_single_argument() {
  local CASE="$TMP_ROOT/case-resume-command-argument"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null

  local sid="abcd1234-0000-0000-0000-000000000017"
  FM_FAKE_HERDR_AGENT="omp" \
  FM_FAKE_HERDR_POST_QUIT_PROCESS="-zsh" \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" wx:p1 >/dev/null 2>/dev/null \
    || fail "(x) reload failed after the shell returned"

  herdr_log "$CASE" | grep -Fqx "pane-run argc=4 pane=<wx:p1> command=<omp --resume $sid>" \
    || fail "(x) relaunch was not passed as the single fourth herdr argument"

  pass "(x) relaunch -> one command-string argument with no standalone --"
}
# A stale Herdr idle must not override a visibly working OMP screen. The worker
# waits for the screen to become idle, then proceeds without a false failure.
test_stale_idle_screen_waits_then_reloads() {
  local CASE="$TMP_ROOT/case-stale-idle"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  local sid="abcd1234-0000-0000-0000-000000000017"
  # Two visible-screen reads are intentional; allow worker startup and both reads under load.
  FM_RELOAD_NO_GUARD='' \
  FM_RELOAD_TIMEOUT=3 \
  FM_RELOAD_PROOF_TIMEOUT=3 \
  FM_FAKE_HERDR_CURRENT="w1:p1" \
  FM_FAKE_HERDR_AGENT=omp \
  FM_FAKE_HERDR_STATUS=idle \
  FM_FAKE_HERDR_SCREEN=working \
  FM_FAKE_HERDR_SCREEN_AFTER=idle \
  FM_FAKE_HERDR_SCREEN_AFTER_READS=2 \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" >/dev/null \
    || fail "(x) stale Herdr idle with working screen handoff failed"
  local rlog="$CASE/state/.reload.w1-p1.log"
  wait_worker_done "$rlog" || fail "(x) detached worker never recorded stale-idle completion"
  grep -q "detached self-reload of pane w1:p1 succeeded" "$rlog" \
    || fail "(x) stale-idle detached worker did not complete successfully"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    || fail "(x) expected /quit after visible screen became idle"
  pass "(x) detached worker waits for stale-idle screen, then reloads"
}

# A replacement OMP process can keep the same pane, cwd, label, and lifecycle
# status while changing Herdr's agent_session identity. Refuse /quit in both
# fresh-session and literal-command modes when that identity changes.
test_replacement_session_refuses_quit() {
  local mode CASE
  for mode in allow-fresh literal-cmd; do
    CASE="$TMP_ROOT/case-replacement-$mode"
    mkdir -p "$CASE"
    make_fake_herdr "$CASE" >/dev/null
    if [ "$mode" = "allow-fresh" ]; then
      FM_FAKE_HERDR_AGENT_SESSION_ID=agent-session-original \
      FM_FAKE_HERDR_REPLACEMENT_AGENT_SESSION_ID=agent-session-replacement \
      FM_FAKE_HERDR_REPLACE_AFTER_GET=4 \
      FM_FAKE_HERDR_AGENT=omp \
      FM_FAKE_HERDR_SESSION="" \
        run_reload "$CASE" w1:p1 --allow-fresh >/dev/null 2>/dev/null \
        && fail "(y/$mode) replacement session unexpectedly reloaded"
    else
      FM_FAKE_HERDR_AGENT_SESSION_ID=agent-session-original \
      FM_FAKE_HERDR_REPLACEMENT_AGENT_SESSION_ID=agent-session-replacement \
      FM_FAKE_HERDR_REPLACE_AFTER_GET=3 \
      FM_FAKE_HERDR_AGENT=omp \
      FM_FAKE_HERDR_SESSION="" \
        run_reload "$CASE" w1:p1 --cmd "omp --fresh-start" >/dev/null 2>/dev/null \
        && fail "(y/$mode) replacement session unexpectedly reloaded"
    fi
    herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
      && fail "(y/$mode) replacement session received /quit"
  done
  pass "(y) replacement agent_session refuses /quit for --allow-fresh and literal --cmd"
}

# The self-reload caller must pin identity before forking. If the process is
# replaced before the detached worker's first read, the worker refuses /quit.
test_self_reload_replacement_before_worker_pin() {
  local CASE="$TMP_ROOT/case-self-replacement"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  local sid="abcd1234-0000-0000-0000-000000000019"
  FM_RELOAD_NO_GUARD='' \
  FM_FAKE_HERDR_CURRENT="w1:p1" \
  FM_FAKE_HERDR_AGENT_SESSION_ID=agent-session-original \
  FM_FAKE_HERDR_REPLACEMENT_AGENT_SESSION_ID=agent-session-replacement \
  FM_FAKE_HERDR_REPLACE_AFTER_GET=2 \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" >/dev/null \
    || fail "(z) self-reload handoff unexpectedly failed synchronously"
  local rlog="$CASE/state/.reload.w1-p1.log"
  wait_worker_done "$rlog" || fail "(z) detached worker never recorded replacement refusal"

  grep -q "detached self-reload of pane w1:p1 FAILED" "$rlog" \
    || fail "(z) detached worker did not record replacement refusal"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    && fail "(z) replacement session received /quit during detached handoff"
  pass "(z) detached handoff pins identity before worker revalidation"
}

# Normal-mode reloads must reject a replacement agent_session even when the
# resume id itself is unchanged.
test_resume_id_replacement_refuses_quit() {
  local CASE="$TMP_ROOT/case-resume-replacement"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  local sid="abcd1234-0000-0000-0000-00000000001a"
  FM_RELOAD_NO_GUARD=1 \
  FM_FAKE_HERDR_AGENT=omp \
  FM_FAKE_HERDR_AGENT_SESSION_ID=agent-session-original \
  FM_FAKE_HERDR_REPLACEMENT_AGENT_SESSION_ID=agent-session-replacement \
  FM_FAKE_HERDR_REPLACE_AFTER_GET=2 \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" w1:p1 >/dev/null 2>/dev/null \
    && fail "(aa) replacement agent_session unexpectedly reloaded"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    && fail "(aa) replacement agent_session received /quit"
  pass "(aa) unchanged resume id with replacement agent_session refuses /quit"
}

test_empty_field_replacement_refuses_quit() {
  local CASE="$TMP_ROOT/case-empty-field-replacement"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  local sid="abcd1234-0000-0000-0000-00000000001b"
  FM_RELOAD_NO_GUARD=1 \
  FM_FAKE_HERDR_AGENT=omp \
  FM_FAKE_HERDR_CWD="" \
  FM_FAKE_HERDR_AGENT_SESSION_ID=agent-session-original \
  FM_FAKE_HERDR_REPLACEMENT_AGENT_SESSION_ID=agent-session-original \
  FM_FAKE_HERDR_REPLACEMENT_CWD=/replacement \
  FM_FAKE_HERDR_REPLACE_AFTER_GET=2 \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" w1:p1 >/dev/null 2>/dev/null \
    && fail "(ab) empty cwd replacement unexpectedly reloaded"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    && fail "(ab) empty cwd replacement received /quit"
  pass "(ab) empty pinned cwd rejects replacement"
}

test_detached_path_presence_replacements_refuse_quit() {
  local mode CASE sid rlog
  for mode in absent empty dash; do
    CASE="$TMP_ROOT/case-detached-path-$mode"
    mkdir -p "$CASE"
    make_fake_herdr "$CASE" >/dev/null
    sid="abcd1234-0000-0000-0000-00000000001c"
    if [ "$mode" = "absent" ]; then
      FM_FAKE_HERDR_SESSION_PATH_PRESENT=0 \
      FM_FAKE_HERDR_REPLACEMENT_SESSION_PATH_PRESENT=1 \
      FM_FAKE_HERDR_REPLACEMENT_SESSION_PATH=/replacement \
      FM_RELOAD_NO_GUARD='' FM_FAKE_HERDR_CURRENT=w1:p1 \
      FM_FAKE_HERDR_AGENT_SESSION_ID=agent-session-original FM_FAKE_HERDR_REPLACE_AFTER_GET=2 FM_FAKE_HERDR_SESSION="$sid" \
        run_reload "$CASE" >/dev/null || fail "(ac/$mode) handoff failed synchronously"
    elif [ "$mode" = "empty" ]; then
      FM_FAKE_HERDR_SESSION_PATH_PRESENT=1 FM_FAKE_HERDR_SESSION_PATH="" \
      FM_FAKE_HERDR_REPLACEMENT_SESSION_PATH_PRESENT=1 FM_FAKE_HERDR_REPLACEMENT_SESSION_PATH=/replacement \
      FM_RELOAD_NO_GUARD='' FM_FAKE_HERDR_CURRENT=w1:p1 \
      FM_FAKE_HERDR_AGENT_SESSION_ID=agent-session-original FM_FAKE_HERDR_REPLACE_AFTER_GET=2 FM_FAKE_HERDR_SESSION="$sid" \
        run_reload "$CASE" >/dev/null || fail "(ac/$mode) handoff failed synchronously"
    else
      FM_FAKE_HERDR_SESSION_PATH_PRESENT=1 FM_FAKE_HERDR_SESSION_PATH=- \
      FM_FAKE_HERDR_REPLACEMENT_SESSION_PATH_PRESENT=1 FM_FAKE_HERDR_REPLACEMENT_SESSION_PATH=/replacement \
      FM_RELOAD_NO_GUARD='' FM_FAKE_HERDR_CURRENT=w1:p1 \
      FM_FAKE_HERDR_AGENT_SESSION_ID=agent-session-original FM_FAKE_HERDR_REPLACE_AFTER_GET=2 FM_FAKE_HERDR_SESSION="$sid" \
        run_reload "$CASE" >/dev/null || fail "(ac/$mode) handoff failed synchronously"
    fi
    rlog="$CASE/state/.reload.w1-p1.log"
    wait_worker_done "$rlog" || fail "(ac/$mode) worker did not record path replacement refusal"
    grep -q "detached self-reload of pane w1:p1 FAILED" "$rlog" \
      || fail "(ac/$mode) worker did not refuse changed path presence/value"
    herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
      && fail "(ac/$mode) changed path received /quit"
  done
  pass "(ac) detached absent, empty, and dash agent_session_path replacements refuse /quit"
}

test_busy_refuses_quit() {
  local CASE="$TMP_ROOT/case-u"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  local sid="abcd1234-0000-0000-0000-000000000014"
  FM_FAKE_HERDR_AGENT=omp FM_FAKE_HERDR_STATUS=working FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" w1:p1 >/dev/null 2>/dev/null \
    && fail "(u) working pane unexpectedly reloaded"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    && fail "(u) working pane received /quit"
  pass "(u) working pane waits then refuses /quit"
}

test_unknown_refuses_quit() {
  local CASE="$TMP_ROOT/case-v"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  local sid="abcd1234-0000-0000-0000-000000000015"
  FM_FAKE_HERDR_AGENT=omp FM_FAKE_HERDR_STATUS=unknown FM_FAKE_HERDR_SCREEN=empty-box FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" w1:p1 >/dev/null 2>/dev/null \
    && fail "(v) top-level unknown pane unexpectedly reloaded"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    && fail "(v) top-level unknown pane received /quit"
  pass "(v) top-level unknown pane waits then refuses /quit"
}
test_self_reload_legacy_agent_session_idle_reloads() {
  local CASE="$TMP_ROOT/case-legacy-agent-session"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  local sid="abcd1234-0000-0000-0000-000000000020"
  FM_RELOAD_NO_GUARD='' \
  FM_FAKE_HERDR_CURRENT=w1:p1 \
  FM_FAKE_HERDR_LEGACY_AGENT_SESSION=1 \
  FM_FAKE_HERDR_AGENT_SESSION_ID=legacy-agent-session \
  FM_FAKE_HERDR_STATUS=unknown \
  FM_FAKE_HERDR_SCREEN=stale-spinner \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" >/dev/null \
    || fail "(legacy) self-reload handoff failed"
  local rlog="$CASE/state/.reload.w1-p1.log"
  wait_worker_done "$rlog" || fail "(legacy) self-reload worker never recorded completion"
  grep -q "detached self-reload of pane w1:p1 succeeded" "$rlog" \
    || fail "(legacy) self-reload worker did not succeed"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    || fail "(legacy) idle legacy agent_session target did not receive /quit"
  herdr_log "$CASE" | grep -q "pane run w1:p1 omp --resume $sid" \
    || fail "(legacy) idle legacy agent_session target did not resume exactly"
  pass "(legacy) self-reload accepts exact empty box after historical spinner"
}
test_legacy_agent_session_identity_byte_exact() {
  local CASE="$TMP_ROOT/case-legacy-byte-exact"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  local sid="abcd1234-0000-0000-0000-000000000022"
  local legacy_identity='legacy-agent-session-µ'
  FM_RELOAD_NO_GUARD=1 \
  FM_FAKE_HERDR_LEGACY_AGENT_SESSION=1 \
  FM_FAKE_HERDR_AGENT_SESSION_ID="$legacy_identity" \
  FM_FAKE_HERDR_REPLACEMENT_AGENT_SESSION_ID="$legacy_identity" \
  FM_FAKE_HERDR_REPLACE_AFTER_GET=2 \
  FM_FAKE_HERDR_STATUS=unknown \
  FM_FAKE_HERDR_SCREEN=ansi-empty-box \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" w1:p1 >/dev/null 2>/dev/null \
    || fail "(legacy/identity) unchanged byte-exact identity did not reload"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    || fail "(legacy/identity) unchanged byte-exact identity did not receive /quit"
  pass "(legacy/identity) unchanged byte-exact legacy identity permits /quit"
}

test_legacy_agent_session_v17_idle_frame_reloads() {
  local CASE="$TMP_ROOT/case-legacy-v17-idle-frame"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  local sid="abcd1234-0000-0000-0000-000000000023"
  FM_RELOAD_NO_GUARD=1 \
  FM_FAKE_HERDR_LEGACY_AGENT_SESSION=1 \
  FM_FAKE_HERDR_AGENT_SESSION_ID=legacy-agent-session \
  FM_FAKE_HERDR_STATUS=unknown \
  FM_FAKE_HERDR_SCREEN=v17-empty-box \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" w1:p1 >/dev/null 2>/dev/null \
    || fail "(legacy/v17-idle-frame) unchanged identity did not reload"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    || fail "(legacy/v17-idle-frame) unchanged identity did not receive /quit"
  pass "(legacy/v17-idle-frame) exact OMP v17 empty frame permits /quit"
}

test_legacy_agent_session_compositor_matrix() {
  local CASE fixture sid
  sid="abcd1234-0000-0000-0000-000000000021"

  # Every unsafe visible shape must fail closed before /quit.
  for fixture in spinner-box esc-box tab-box nonascii-space-box idle-then-spinner unknown-box malformed-box nonempty-box; do
    CASE="$TMP_ROOT/case-legacy-$fixture"
    mkdir -p "$CASE"
    make_fake_herdr "$CASE" >/dev/null
    FM_RELOAD_NO_GUARD=1 \
    FM_FAKE_HERDR_LEGACY_AGENT_SESSION=1 \
    FM_FAKE_HERDR_STATUS=unknown \
    FM_FAKE_HERDR_SCREEN="$fixture" \
    FM_FAKE_HERDR_SESSION="$sid" \
      run_reload "$CASE" w1:p1 >/dev/null 2>/dev/null \
      && fail "(legacy/$fixture) unsafe compositor unexpectedly reloaded"
    herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
      && fail "(legacy/$fixture) unsafe compositor received /quit"
  done

  # An ANSI-styled exact empty frame permits an unchanged legacy identity.
  CASE="$TMP_ROOT/case-legacy-ansi-empty"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  FM_RELOAD_NO_GUARD=1 \
  FM_FAKE_HERDR_LEGACY_AGENT_SESSION=1 \
  FM_FAKE_HERDR_AGENT_SESSION_ID=legacy-agent-session \
  FM_FAKE_HERDR_STATUS=unknown \
  FM_FAKE_HERDR_SCREEN=ansi-empty-box \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" w1:p1 >/dev/null 2>/dev/null \
    || fail "(legacy/ansi-empty) unchanged identity did not reload"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    || fail "(legacy/ansi-empty) unchanged identity did not receive /quit"

  # The same safe box must still refuse a replacement legacy identity.
  CASE="$TMP_ROOT/case-legacy-replacement"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  FM_RELOAD_NO_GUARD=1 \
  FM_FAKE_HERDR_LEGACY_AGENT_SESSION=1 \
  FM_FAKE_HERDR_AGENT_SESSION_ID=legacy-agent-session \
  FM_FAKE_HERDR_REPLACEMENT_AGENT_SESSION_ID=legacy-replacement-session \
  FM_FAKE_HERDR_REPLACE_AFTER_GET=2 \
  FM_FAKE_HERDR_STATUS=unknown \
  FM_FAKE_HERDR_SCREEN=empty-box \
  FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" w1:p1 >/dev/null 2>/dev/null \
    && fail "(legacy/replacement) replacement identity unexpectedly reloaded"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    && fail "(legacy/replacement) replacement identity received /quit"

  pass "(legacy) strict compositor matrix preserves identity and refuses unsafe shapes"
}


test_allow_fresh_post_reload_legacy_agent_session_proof() {
  local CASE="$TMP_ROOT/case-legacy-post-proof"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  FM_RELOAD_NO_GUARD=1 \
  FM_FAKE_HERDR_LEGACY_AGENT_SESSION=1 \
  FM_FAKE_HERDR_POST_LEGACY_AGENT_SESSION=1 \
  FM_FAKE_HERDR_STATUS=unknown \
  FM_FAKE_HERDR_SCREEN=empty-box \
  FM_FAKE_HERDR_SESSION="" \
    run_reload "$CASE" w1:p1 --allow-fresh >/dev/null 2>/dev/null \
    || fail "(legacy/proof) fresh legacy agent_session did not prove reload"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    || fail "(legacy/proof) fresh legacy target did not receive /quit"
  herdr_log "$CASE" | grep -q "pane run w1:p1 omp -c" \
    || fail "(legacy/proof) fresh legacy target did not start omp -c"
  pass "(legacy/proof) fresh legacy agent_session proves post-reload OMP"
}

test_post_reload_invalid_legacy_agent_session_refuses_proof() {
  local mode CASE
  for mode in non-omp malformed; do
    CASE="$TMP_ROOT/case-legacy-post-$mode"
    mkdir -p "$CASE"
    make_fake_herdr "$CASE" >/dev/null
    FM_RELOAD_NO_GUARD=1 \
    FM_FAKE_HERDR_LEGACY_AGENT_SESSION=1 \
    FM_FAKE_HERDR_POST_LEGACY_AGENT_SESSION="$mode" \
    FM_FAKE_HERDR_STATUS=unknown \
    FM_FAKE_HERDR_SCREEN=empty-box \
    FM_FAKE_HERDR_SESSION="" \
      run_reload "$CASE" w1:p1 --allow-fresh >/dev/null 2>/dev/null \
      && fail "(legacy/proof/$mode) invalid legacy pane became restart proof"
  done
  pass "(legacy/proof) non-OMP and malformed legacy panes do not prove restart"
}

test_done_allows_quit() {
  local CASE="$TMP_ROOT/case-w"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  local sid="abcd1234-0000-0000-0000-000000000016"
  FM_FAKE_HERDR_AGENT=omp FM_FAKE_HERDR_STATUS=done FM_FAKE_HERDR_SESSION="$sid" \
    run_reload "$CASE" w1:p1 >/dev/null 2>/dev/null \
    || fail "(w) done pane was not permitted to reload"
  herdr_log "$CASE" | grep -q "pane run w1:p1 /quit" \
    || fail "(w) done pane did not receive /quit"
  pass "(w) done pane is treated as quiescent and reloads"
}

# Run all tests.
test_resume_path
test_fail_closed_no_session
test_auto_pane_current
test_cmd_template_substitution
test_cmd_literal
test_cmd_template_no_session_id_errors
test_no_pane_determinable_errors
test_allow_fresh_fallback
test_fm_name_target
test_secondmate_pin_restored_on_reload
test_ship_crew_model_restored_no_fm_home
test_reverse_lookup_restores_pin_for_raw_pane_target
test_proof_timeout_fails
test_session_id_mismatch_proof
test_deterministic_session_lookup
test_self_reload_detaches
test_self_reload_fails_closed_before_handoff
test_self_reload_worker_failure_observable
test_pane_closes_replacement_pane
test_self_reload_pane_closes_full_recovery
test_stale_idle_screen_waits_then_reloads
test_replacement_session_refuses_quit
test_self_reload_replacement_before_worker_pin
test_resume_id_replacement_refuses_quit
test_empty_field_replacement_refuses_quit
test_detached_path_presence_replacements_refuse_quit
test_done_allows_quit
test_durable_target_meta_rebound
test_busy_refuses_quit
test_unknown_refuses_quit
test_self_reload_legacy_agent_session_idle_reloads
test_legacy_agent_session_identity_byte_exact
test_legacy_agent_session_v17_idle_frame_reloads
test_legacy_agent_session_compositor_matrix
test_allow_fresh_post_reload_legacy_agent_session_proof
test_post_reload_invalid_legacy_agent_session_refuses_proof
test_durable_target_meta_untouched_when_pane_survives
test_self_reload_durable_target_meta_rebound
test_stale_agent_shell_detection
test_live_omp_process_times_out
test_shell_detection_resumes_exact_session
test_resume_command_is_single_argument
