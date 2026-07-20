#!/usr/bin/env bash
# Tests for fm-send's atomic, fail-closed text submission.
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

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-send-tests.XXXXXX")

make_fake_herdr() {
  local dir=$1 fb="$1/fakebin"
  mkdir -p "$fb"
  cat > "$fb/herdr" <<'SH'
#!/usr/bin/env bash
set -u
printf 'herdr %s\n' "$*" >> "${FM_FAKE_HERDR_LOG:-/dev/null}"
case "${1:-}" in
  agent)
    case "${2:-}" in
      get)
        printf '{"agent_status":"%s","pane_id":"w1:p1"}\n' "${FM_FAKE_AGENT_STATUS:-idle}"
        exit 0 ;;
    esac ;;
  pane)
    case "${2:-}" in
      read)
        printf '%s\n' "${FM_FAKE_PANE_LINES:-}"
        exit 0 ;;
      run)
        exit "${FM_FAKE_RUN_RC:-0}" ;;
      send-keys)
        exit 0 ;;
    esac ;;
esac
exit 1
SH
  chmod +x "$fb/herdr"
  printf '%s\n' "$fb"
}

make_home() {
  local home=$1 harness=${2:-omp}
  mkdir -p "$home/state"
  cat > "$home/state/task.meta" <<EOF
pane=w1:p1
kind=ship
harness=$harness
EOF
}

assert_no_sendq() {
  local home=$1
  [ ! -e "$home/state/sendq" ] || fail "fm-send created a send queue"
}

test_send_submits_once() {
  local dir home fb count
  dir="$TMP_ROOT/once"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")

  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="unknown" FM_FAKE_PANE_LINES="" \
    "$ROOT/sbin/fm" send fm-task "atomic work" \
    || fail "fm-send rejected a successful atomic submission"

  count=$(grep -cF 'herdr pane run w1:p1 atomic work' "$dir/herdr.log")
  [ "$count" = "1" ] || fail "expected one pane run, got $count"
  assert_no_sendq "$home"
  pass "fm-send submits text exactly once"
}

test_send_blocks_human_draft() {
  local dir home fb rc count
  dir="$TMP_ROOT/draft"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")

  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" FM_FAKE_PANE_LINES="│ cap draft │" \
    "$ROOT/sbin/fm" send fm-task "must not land" >/dev/null 2>"$dir/err" \
    || rc=$?

  [ "$rc" = "75" ] || fail "expected unsent draft to exit 75, got $rc"
  count=$(grep -cF 'herdr pane run ' "$dir/herdr.log" || true)
  [ "$count" = "0" ] || fail "fm-send wrote into a human draft"
  grep -F 'text was not sent' "$dir/err" >/dev/null \
    || fail "fm-send did not report fail-closed draft handling"
  assert_no_sendq "$home"
  pass "fm-send blocks on a human draft without queueing"
}

test_send_proceeds_on_empty_current_claude_code_composer() {
  local dir home fb count
  dir="$TMP_ROOT/empty-current-ui"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")

  # Reproduces the current Claude Code composer layout: a right-aligned
  # token counter above the box, a bare "❯" content line between the two
  # horizontal rules, and a persistent mode-indicator footer below the
  # bottom rule. The footer used to be the last non-blank line read, so it
  # alone decided pending/not-pending and falsely tripped the draft guard
  # on a visibly empty composer.
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" \
    FM_FAKE_PANE_LINES=$'                                                                              350644 tokens\n──────────────────────────────────────── some task title ──\n❯\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent' \
    "$ROOT/sbin/fm" send fm-task "atomic work" \
    || fail "fm-send blocked on a visibly empty current-UI composer"

  count=$(grep -cF 'herdr pane run w1:p1 atomic work' "$dir/herdr.log")
  [ "$count" = "1" ] || fail "expected one pane run, got $count"
  assert_no_sendq "$home"
  pass "fm-send proceeds on an empty current Claude Code composer"
}

test_send_blocks_human_draft_in_current_claude_code_ui() {
  local dir home fb rc count
  dir="$TMP_ROOT/draft-current-ui"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")

  # Same current-UI chrome as above (token line, rules, mode footer), but
  # with real human-typed text on the composer's content line. The footer
  # and border noise must not mask a genuine unsent draft.
  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" \
    FM_FAKE_PANE_LINES=$'                                                                              350644 tokens\n──────────────────────────────────────── some task title ──\n❯ cap typed a draft\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent' \
    "$ROOT/sbin/fm" send fm-task "must not land" >/dev/null 2>"$dir/err" \
    || rc=$?

  [ "$rc" = "75" ] || fail "expected unsent draft to exit 75, got $rc"
  count=$(grep -cF 'herdr pane run ' "$dir/herdr.log" || true)
  [ "$count" = "0" ] || fail "fm-send wrote into a human draft"
  grep -F 'text was not sent' "$dir/err" >/dev/null \
    || fail "fm-send did not report fail-closed draft handling"
  assert_no_sendq "$home"
  pass "fm-send still blocks a human draft in the current Claude Code UI"
}

test_send_proceeds_on_empty_current_omp_composer() {
  local dir home fb count
  dir="$TMP_ROOT/empty-current-omp"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")

  # Current OMP layout: the status row is the composer's rounded top border,
  # and an empty composer has only the rounded bottom border beneath it.
  # Historical output remains in `pane read --source visible`, so neither it
  # nor the decorated status row may be mistaken for an unsent draft.
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" \
    FM_FAKE_PANE_LINES=$'previous agent output\n\n╭──  GPT-5.6-Sol · 󰪣 high   firstmate/fm-send-omp-composer-fix   fm/fm-send-omp-composer-fix ────  42K  $0.36 (sub)   12.9%/272K 󰁨 ──╮\n╰─                                                                 ─╯' \
    "$ROOT/sbin/fm" send fm-task "atomic work" \
    || fail "fm-send blocked on a visibly empty current OMP composer"

  count=$(grep -cF 'herdr pane run w1:p1 atomic work' "$dir/herdr.log")
  [ "$count" = "1" ] || fail "expected one pane run, got $count"
  assert_no_sendq "$home"
  pass "fm-send proceeds exactly once on an empty current OMP composer"
}

test_send_blocks_human_draft_in_current_omp_composer() {
  local dir home fb rc count
  dir="$TMP_ROOT/draft-current-omp"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")

  # Same current OMP status/composer frame, with a real composer content row.
  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" \
    FM_FAKE_PANE_LINES=$'previous agent output\n\n╭──  GPT-5.6-Sol · 󰪣 high   firstmate/fm-send-omp-composer-fix   fm/fm-send-omp-composer-fix ────  42K  $0.36 (sub)   12.9%/272K 󰁨 ──╮\n│ cap typed a draft                                              │\n╰─                                                                 ─╯' \
    "$ROOT/sbin/fm" send fm-task "must not land" >/dev/null 2>"$dir/err" \
    || rc=$?

  [ "$rc" = "75" ] || fail "expected OMP unsent draft to exit 75, got $rc"
  count=$(grep -cF 'herdr pane run ' "$dir/herdr.log" || true)
  [ "$count" = "0" ] || fail "fm-send wrote into an OMP human draft"
  grep -F 'text was not sent' "$dir/err" >/dev/null \
    || fail "fm-send did not report fail-closed OMP draft handling"
  assert_no_sendq "$home"
  pass "fm-send blocks a human draft in the current OMP composer"
}

test_send_failure_is_not_retried() {
  local dir home fb rc count
  dir="$TMP_ROOT/failure"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")

  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" FM_FAKE_PANE_LINES="" FM_FAKE_RUN_RC=1 \
    "$ROOT/sbin/fm" send fm-task "failing work" >/dev/null 2>"$dir/err" \
    || rc=$?

  [ "$rc" = "1" ] || fail "expected failed pane run to exit 1, got $rc"
  count=$(grep -cF 'herdr pane run w1:p1 failing work' "$dir/herdr.log")
  [ "$count" = "1" ] || fail "failed submission was attempted $count times"
  assert_no_sendq "$home"
  pass "fm-send fails after one rejected submission"
}

test_sequential_sends_do_not_amplify() {
  local dir home fb i count
  dir="$TMP_ROOT/sequential"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")

  i=1
  while [ "$i" -le 20 ]; do
    PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
      FM_FAKE_AGENT_STATUS="unknown" FM_FAKE_PANE_LINES="" \
      "$ROOT/sbin/fm" send fm-task "instruction $i" \
      || fail "sequential send $i failed"
    i=$((i + 1))
  done

  count=$(grep -cF 'herdr pane run w1:p1 instruction ' "$dir/herdr.log")
  [ "$count" = "20" ] || fail "20 sends produced $count pane runs"
  assert_no_sendq "$home"
  pass "20 sequential sends produce exactly 20 submissions"
}

test_key_bypasses_composer_guard() {
  local dir home fb
  dir="$TMP_ROOT/key"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  fb=$(make_fake_herdr "$dir")

  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" FM_FAKE_PANE_LINES="│ cap draft │" \
    "$ROOT/sbin/fm" send fm-task --key Escape \
    || fail "control key unexpectedly blocked"
  grep -F 'herdr pane send-keys w1:p1 Escape' "$dir/herdr.log" >/dev/null \
    || fail "control key was not sent"
  pass "fm-send preserves explicit control-key sends"
}

test_missing_home_metadata_uses_cwd_home() {
  local dir home fb rc
  dir="$TMP_ROOT/missing-home-meta"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home"
  printf '# fixture home\n' > "$home/AGENTS.md"
  home=$(cd "$home" && pwd -P)
  fb=$(make_fake_herdr "$dir")

  rc=0
  (
    cd "$home" || exit 1
    env -u FM_HOME PATH="$fb:$PATH" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
      "$ROOT/sbin/fm" send fm-missing "wrong home" >/dev/null 2>"$dir/err"
  ) || rc=$?

  [ "$rc" = "1" ] || fail "missing home metadata returned rc $rc"
  grep -F "no metadata for fm-missing in $home/state" "$dir/err" >/dev/null \
    || fail "fm-send did not explain missing home metadata from cwd home"
  pass "fm-send reports missing metadata against the resolved home"
}

test_sendq_runtime_is_removed() {
  [ ! -e "$ROOT/sbin/fm-sendq-drain.sh" ] \
    || fail "obsolete background send queue still exists"
  pass "background send queue is removed"
}

test_codex_adapter_exit_is_withheld() {
  local dir home fb rc
  dir="$TMP_ROOT/codex-exit"
  home="$dir/home"
  mkdir -p "$dir"
  make_home "$home" codex
  fb=$(make_fake_herdr "$dir")

  rc=0
  PATH="$fb:$PATH" FM_HOME="$home" FM_FAKE_HERDR_LOG="$dir/herdr.log" \
    FM_FAKE_AGENT_STATUS="idle" FM_FAKE_PANE_LINES="" \
    "$ROOT/sbin/fm" send fm-task --exit >/dev/null 2>"$dir/err" || rc=$?

  [ "$rc" = "1" ] || fail "codex --exit returned rc $rc, want 1"
  grep -F "not supported for harness 'codex'" "$dir/err" >/dev/null \
    || fail "codex --exit did not explain withhold: $(cat "$dir/err")"
  if [ -f "$dir/herdr.log" ] && grep -qF 'pane run' "$dir/herdr.log"; then
    fail "codex --exit must not pane-run exit: $(cat "$dir/herdr.log")"
  fi
  pass "fm send --exit withholds Codex until delay is encoded"
}

test_send_submits_once
test_send_blocks_human_draft
test_send_proceeds_on_empty_current_claude_code_composer
test_send_blocks_human_draft_in_current_claude_code_ui
test_send_proceeds_on_empty_current_omp_composer
test_send_blocks_human_draft_in_current_omp_composer
test_send_failure_is_not_retried
test_sequential_sends_do_not_amplify
test_key_bypasses_composer_guard
test_missing_home_metadata_uses_cwd_home
test_sendq_runtime_is_removed
test_codex_adapter_exit_is_withheld
