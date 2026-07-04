#!/usr/bin/env bash
# Behavior tests for bin/fm-reload.sh.
#
# Covers:
#   (a) explicit pane + session-id in output   -> omp --resume <id>
#   (b) explicit pane + no session-id          -> omp -c (fallback)
#   (c) pane from herdr pane current           -> auto-detected, resume used
#   (d) --cmd template with {id}              -> substituted correctly
#   (e) --cmd literal (no {id})               -> used verbatim
#   (f) --cmd {id} but no session-id found    -> error, non-zero exit
#   (g) no pane determinable                  -> error, non-zero exit
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
# Behaviours controlled by env vars set before running fm-reload.sh:
#   FM_FAKE_HERDR_LOG     - path where every herdr call is appended
#   FM_FAKE_HERDR_AGENT   - value returned by pane get .result.pane.agent
#                           (default ""; "omp" means still running)
#   FM_FAKE_HERDR_SESSION - omp session id embedded in pane read output
#                           (empty = no session id found)
#   FM_FAKE_HERDR_CURRENT - pane_id returned by pane current
#                           (empty = simulate lookup failure)
# ---------------------------------------------------------------------------
make_fake_herdr() {
  local dir=$1 fakebin log
  fakebin="$dir/fakebin"
  log="$dir/herdr.log"
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -u
printf 'herdr %s\n' "$*" >> "${FM_FAKE_HERDR_LOG:-/dev/null}"
case "${1:-}" in
  pane)
    case "${2:-}" in
      current)
        cur="${FM_FAKE_HERDR_CURRENT:-}"
        if [ -z "$cur" ]; then exit 1; fi
        printf '{"id":"cli:pane:current","result":{"pane":{"pane_id":"%s"}}}\n' "$cur"
        exit 0 ;;
      get)
        agent="${FM_FAKE_HERDR_AGENT:-}"
        printf '{"id":"cli:pane:get","result":{"pane":{"agent":"%s"}}}\n' "$agent"
        exit 0 ;;
      read)
        sid="${FM_FAKE_HERDR_SESSION:-}"
        if [ -n "$sid" ]; then
          printf 'session started\nomp --resume %s\nsome other line\n' "$sid"
        else
          printf 'session started\nsome other line\n'
        fi
        exit 0 ;;
      run)
        # Record the pane and command; always succeed.
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
# Args: case_dir [fm-reload.sh args...]
run_reload() {
  local dir=$1; shift
  local fakebin="$dir/fakebin"
  local log="$dir/herdr.log"
  FM_FAKE_HERDR_LOG="$log" \
  FM_ROOT_OVERRIDE="$ROOT" \
  FM_RELOAD_NO_GUARD=1 \
  FM_RELOAD_QUIT_GRACE=0 \
  FM_RELOAD_TIMEOUT=1 \
    PATH="$fakebin:$PATH" \
    "$RELOAD" "$@"
}

# Read the recorded herdr call log.
herdr_log() {
  local dir=$1
  cat "$dir/herdr.log" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# (a) Explicit pane + session id in recent output -> omp --resume <id>
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

  pass "(a) explicit pane + session id -> omp --resume <id>"
}

# ---------------------------------------------------------------------------
# (b) Explicit pane + no session id -> omp -c fallback
# ---------------------------------------------------------------------------
test_fallback_path() {
  local CASE="$TMP_ROOT/case-b"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  

  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="" \
    run_reload "$CASE" w2:p1 >/dev/null || fail "(b) fm-reload.sh exited non-zero"

  herdr_log "$CASE" | grep -q "pane run w2:p1 omp -c" \
    || fail "(b) expected 'pane run w2:p1 omp -c' in herdr log"

  pass "(b) explicit pane + no session id -> omp -c"
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
# (f) --cmd {id} but no session id found -> error, non-zero exit
# ---------------------------------------------------------------------------
test_cmd_template_no_session_id_errors() {
  local CASE="$TMP_ROOT/case-f"
  mkdir -p "$CASE"
  make_fake_herdr "$CASE" >/dev/null
  

  FM_FAKE_HERDR_AGENT="" \
  FM_FAKE_HERDR_SESSION="" \
    run_reload "$CASE" w6:p1 --cmd "omp --resume {id}" >/dev/null 2>/dev/null \
    && fail "(f) expected non-zero exit when {id} unreplaceable"

  pass "(f) --cmd {id} with no session id -> non-zero exit"
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

# Run all tests.
test_resume_path
test_fallback_path
test_auto_pane_current
test_cmd_template_substitution
test_cmd_literal
test_cmd_template_no_session_id_errors
test_no_pane_determinable_errors
