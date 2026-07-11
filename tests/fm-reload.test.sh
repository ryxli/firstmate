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
#   (t) self-reload of durable target + pane closes   -> detached worker rebinds meta
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
#   FM_FAKE_HERDR_AGENT        - pane get .agent BEFORE resume (default "")
#   FM_FAKE_HERDR_POST_AGENT   - pane get .agent AFTER resume (default "omp")
#   FM_FAKE_HERDR_SESSION      - session id in pane read BEFORE resume (default "")
#   FM_FAKE_HERDR_POST_SESSION - session id in pane read AFTER resume (default: FM_FAKE_HERDR_SESSION)
#   FM_FAKE_HERDR_CURRENT      - pane_id returned by pane current (empty = failure)
#   FM_FAKE_HERDR_CWD          - cwd in pane get response (default "")
#   FM_FAKE_HERDR_PANE_CLOSES  - set to 1 to simulate herdr closing the target
#                                pane once /quit was sent: pane get for any
#                                pane except the replacement (wR:p1) errors
#                                with pane_not_found. 'tab create' returns a
#                                replacement root pane wR:p1.
# ---------------------------------------------------------------------------
make_fake_herdr() {
  local dir=$1 fakebin log
  fakebin="$dir/fakebin"
  log="$dir/herdr.log"
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -u
STATE_DIR="${FM_FAKE_HERDR_STATE_DIR:-/tmp}"
RESUMED_FILE="$STATE_DIR/resumed"
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
        if [ -f "$RESUMED_FILE" ]; then
          agent="${FM_FAKE_HERDR_POST_AGENT-omp}"
        else
          agent="${FM_FAKE_HERDR_AGENT:-}"
        fi
        printf '{"id":"cli:pane:get","result":{"pane":{"agent":"%s","cwd":"%s","workspace_id":"w1","label":"fake-mate"}}}\n' "$agent" "${FM_FAKE_HERDR_CWD:-}"
        exit 0 ;;
      read)
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
  FM_RELOAD_TIMEOUT=1 \
  FM_RELOAD_PROOF_TIMEOUT=1 \
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
test_proof_timeout_fails
test_session_id_mismatch_proof
test_deterministic_session_lookup
test_self_reload_detaches
test_self_reload_fails_closed_before_handoff
test_self_reload_worker_failure_observable
test_pane_closes_replacement_pane
test_self_reload_pane_closes_full_recovery
test_durable_target_meta_rebound
test_durable_target_meta_untouched_when_pane_survives
test_self_reload_durable_target_meta_rebound
