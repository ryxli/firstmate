#!/usr/bin/env bash
# Composer-pending detection for herdr-based panes.
#
# paneInputPending in .omp/extensions/cli/lib/herdr.ts decides whether the
# supervisor pane holds unsubmitted human text. It uses herdr pane read for
# content and herdr agent get for status. These tests pin three guarantees:
#   1. A bordered-empty composer (claude draws │ > … │) reads as NOT pending.
#   2. Real text in the composer reads as pending.
#   3. A busy agent status (working) is NOT pending (paneIsBusy).
#
# Originally this test sourced sbin/fm-herdr-lib.sh directly and called its
# bash functions in-process. That bash lib is dead: runtime code moved to
# .omp/extensions/cli/lib/herdr.ts, which sbin/fm's verbs import. Bun's
# spawnSync (used internally by herdr.ts) resolves its executable and env
# from the process's env at the time the *process* started, not from
# in-process process.env mutations made after startup, so an in-process bun
# test cannot mock `herdr` by mutating process.env before calling paneIsBusy /
# paneInputPending. Each case below therefore shells out to a tiny `bun -e`
# harness that imports the real exported functions and calls them in a fresh
# process, with the fake herdr on PATH and the fixture env vars set for that
# process from the start - the same fixture-injection shape the original
# bash tests used, just retargeted at the TypeScript implementation.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERDR_TS="$ROOT/.omp/extensions/cli/lib/herdr.ts"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-herdr-pane-tests.XXXXXX")
cleanup() { [ -n "${TMP_ROOT:-}" ] && rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# Build a fake herdr binary that returns pre-canned responses.
# FM_FAKE_PANE_LINES: content for `herdr pane read`
# FM_FAKE_AGENT_STATUS: value for agent_status in `herdr agent get`
make_fake_herdr() {
  local dir=$1 fb="$1/fakebin"
  mkdir -p "$fb"
  cat > "$fb/herdr" <<'SH'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  pane)
    case "${2:-}" in
      read)
        printf '%s\n' "${FM_FAKE_PANE_LINES:-}"
        exit 0 ;;
    esac ;;
  agent)
    case "${2:-}" in
      get)
        printf '{"agent_status":"%s"}\n' "${FM_FAKE_AGENT_STATUS:-idle}"
        exit 0 ;;
    esac ;;
esac
exit 1
SH
  chmod +x "$fb/herdr"
  printf '%s\n' "$fb"
}

# ts_pane_is_busy <pane>: rc 0 iff herdr.ts's paneIsBusy(pane) is true.
ts_pane_is_busy() {
  bun -e '
import { paneIsBusy } from "'"$HERDR_TS"'";
process.exit(paneIsBusy(process.argv[process.argv.length - 1]) ? 0 : 1);
' -- "$1"
}

# ts_pane_input_pending <pane>: rc 0 iff herdr.ts's paneInputPending(pane) is true.
ts_pane_input_pending() {
  bun -e '
import { paneInputPending } from "'"$HERDR_TS"'";
process.exit(paneInputPending(process.argv[process.argv.length - 1]) ? 0 : 1);
' -- "$1"
}

# --- fm_pane_is_busy ---------------------------------------------------------

test_working_status_is_busy() {
  local dir fb
  dir="$TMP_ROOT/busy"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  if ! PATH="$fb:$PATH" FM_FAKE_AGENT_STATUS="working" ts_pane_is_busy "w1:p1"; then
    fail "working status should be busy"
  fi
  pass "fm_pane_is_busy: working status is busy"
}

test_idle_status_is_not_busy() {
  local dir fb
  dir="$TMP_ROOT/not-busy"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  if PATH="$fb:$PATH" FM_FAKE_AGENT_STATUS="idle" ts_pane_is_busy "w1:p1"; then
    fail "idle status should not be busy"
  fi
  pass "fm_pane_is_busy: idle status is not busy"
}

# --- fm_pane_input_pending ---------------------------------------------------

test_bordered_empty_composer_is_not_pending() {
  local dir fb
  dir="$TMP_ROOT/bordered-empty"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  # Claude's empty bordered composer: box-drawing characters with no real content.
  export FM_FAKE_PANE_LINES="│ > │"
  export FM_FAKE_AGENT_STATUS="idle"
  if PATH="$fb:$PATH" ts_pane_input_pending "w1:p1"; then
    fail "bordered empty composer falsely read as pending"
  fi
  pass "fm_pane_input_pending: bordered empty composer is NOT pending"
}

test_real_text_in_composer_is_pending() {
  local dir fb
  dir="$TMP_ROOT/real-text"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  export FM_FAKE_PANE_LINES="│ fix findings 1 and 3 │"
  export FM_FAKE_AGENT_STATUS="idle"
  PATH="$fb:$PATH" ts_pane_input_pending "w1:p1" \
    || fail "real typed text not detected as pending"
  pass "fm_pane_input_pending: real text in composer is pending"
}

test_empty_pane_is_not_pending() {
  local dir fb
  dir="$TMP_ROOT/empty-pane"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  export FM_FAKE_PANE_LINES=""
  export FM_FAKE_AGENT_STATUS="idle"
  if PATH="$fb:$PATH" ts_pane_input_pending "w1:p1"; then
    fail "empty pane falsely read as pending"
  fi
  pass "fm_pane_input_pending: empty pane is NOT pending"
}

test_prompt_glyph_only_is_not_pending() {
  local dir fb
  dir="$TMP_ROOT/prompt-only"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  export FM_FAKE_PANE_LINES=">"
  export FM_FAKE_AGENT_STATUS="idle"
  if PATH="$fb:$PATH" ts_pane_input_pending "w1:p1"; then
    fail "bare prompt glyph falsely read as pending"
  fi
  pass "fm_pane_input_pending: bare prompt glyph is NOT pending"
}

test_working_status_not_pending() {
  local dir fb
  dir="$TMP_ROOT/working-status"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  export FM_FAKE_PANE_LINES="some text here"
  export FM_FAKE_AGENT_STATUS="working"
  # When the agent is working the busy-footer match should prevent pending detection.
  if PATH="$fb:$PATH" ts_pane_input_pending "w1:p1"; then
    fail "working-status pane with busy footer falsely read as pending"
  fi
  pass "fm_pane_input_pending: busy-footer text (working status) is NOT pending"
}

test_rounded_bottom_border_is_not_pending() {
  local dir fb
  dir="$TMP_ROOT/rounded-border"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  # Real omp/opus composer is a full box whose LAST visible line is the rounded
  # bottom border. Stripping only the vertical bars left this reading as pending,
  # which froze away-mode escalations on omp. The full box-drawing strip must
  # collapse a border-only line to an empty composer.
  export FM_FAKE_PANE_LINES="╰──────────────────────────────────╯"
  export FM_FAKE_AGENT_STATUS="idle"
  if PATH="$fb:$PATH" ts_pane_input_pending "w1:p1"; then
    fail "rounded bottom border falsely read as pending"
  fi
  pass "fm_pane_input_pending: rounded bottom border is NOT pending"
}

test_current_claude_code_empty_composer_is_not_pending() {
  local dir fb
  dir="$TMP_ROOT/current-ui-empty"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  # Current Claude Code layout: a right-aligned token counter above the
  # composer box, a bare "❯" content line between the two horizontal
  # rules, and a persistent mode-indicator footer below the bottom rule.
  # The footer used to be the last non-blank line read, so it alone (not
  # the actual "❯" content line) decided pending/not-pending and falsely
  # tripped the draft guard on a visibly empty composer.
  export FM_FAKE_PANE_LINES=$'                                                                              350644 tokens\n──────────────────────────────────────── some task title ──\n❯\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent'
  export FM_FAKE_AGENT_STATUS="idle"
  if PATH="$fb:$PATH" ts_pane_input_pending "w1:p1"; then
    fail "current Claude Code empty composer falsely read as pending"
  fi
  pass "fm_pane_input_pending: current Claude Code empty composer is NOT pending"
}

test_current_claude_code_real_draft_is_pending() {
  local dir fb
  dir="$TMP_ROOT/current-ui-draft"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  # Same current-UI chrome (token line, rules, mode footer) as above, but
  # with real human-typed text on the composer's content line. The footer
  # and border noise must not mask a genuine unsent draft.
  export FM_FAKE_PANE_LINES=$'                                                                              350644 tokens\n──────────────────────────────────────── some task title ──\n❯ cap typed a draft\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent'
  export FM_FAKE_AGENT_STATUS="idle"
  PATH="$fb:$PATH" ts_pane_input_pending "w1:p1" \
    || fail "real typed text in current Claude Code UI not detected as pending"
  pass "fm_pane_input_pending: current Claude Code real draft is pending"
}

test_working_status_is_busy
test_idle_status_is_not_busy
test_bordered_empty_composer_is_not_pending
test_real_text_in_composer_is_pending
test_empty_pane_is_not_pending
test_prompt_glyph_only_is_not_pending
test_working_status_not_pending
test_rounded_bottom_border_is_not_pending
test_current_claude_code_empty_composer_is_not_pending
test_current_claude_code_real_draft_is_pending
