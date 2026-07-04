#!/usr/bin/env bash
# Behavior tests for bin/fm-reload.sh.
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
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELOAD="$ROOT/bin/fm-reload.sh"
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
        if [ -f "$RESUMED_FILE" ]; then
          agent="${FM_FAKE_HERDR_POST_AGENT-omp}"
        else
          agent="${FM_FAKE_HERDR_AGENT:-}"
        fi
        printf '{"id":"cli:pane:get","result":{"pane":{"agent":"%s","cwd":"%s"}}}\n' "$agent" "${FM_FAKE_HERDR_CWD:-}"
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
        # Non-slash commands = relaunch; create the resumed marker.
        cmd="${4:-}"
        case "$cmd" in
          /*) ;;
          ?*) touch "$RESUMED_FILE" ;;
        esac
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

# Run fm-reload.sh with PATH mocked to fake herdr; guard skipped via env.
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
  FM_RELOAD_NO_GUARD=1 \
  FM_RELOAD_QUIT_GRACE=0 \
  FM_RELOAD_TIMEOUT=1 \
  FM_RELOAD_PROOF_TIMEOUT=1 \
    PATH="$fakebin:$PATH" \
    "$RELOAD" "$@"
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
