#!/usr/bin/env bash
# Composer-pending detection for herdr-based panes.
#
# fm_pane_input_pending in fm-herdr-lib.sh decides whether the supervisor pane
# holds unsubmitted human text. It uses herdr pane read for content and
# herdr agent get for status. These tests pin three guarantees:
#   1. A bordered-empty composer (claude draws │ > … │) reads as NOT pending.
#   2. Real text in the composer reads as pending.
#   3. A busy agent status (working) is NOT pending (fm_pane_is_busy).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/sbin/fm-herdr-lib.sh"

# shellcheck source=sbin/fm-herdr-lib.sh
. "$LIB"

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

# --- fm_pane_is_busy ---------------------------------------------------------

test_working_status_is_busy() {
  local dir fb
  dir="$TMP_ROOT/busy"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  if ! PATH="$fb:$PATH" FM_FAKE_AGENT_STATUS="working" fm_pane_is_busy "w1:p1"; then
    fail "working status should be busy"
  fi
  pass "fm_pane_is_busy: working status is busy"
}

test_idle_status_is_not_busy() {
  local dir fb
  dir="$TMP_ROOT/not-busy"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  if PATH="$fb:$PATH" FM_FAKE_AGENT_STATUS="idle" fm_pane_is_busy "w1:p1"; then
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
  if PATH="$fb:$PATH" fm_pane_input_pending "w1:p1"; then
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
  PATH="$fb:$PATH" fm_pane_input_pending "w1:p1" \
    || fail "real typed text not detected as pending"
  pass "fm_pane_input_pending: real text in composer is pending"
}

test_empty_pane_is_not_pending() {
  local dir fb
  dir="$TMP_ROOT/empty-pane"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  export FM_FAKE_PANE_LINES=""
  export FM_FAKE_AGENT_STATUS="idle"
  if PATH="$fb:$PATH" fm_pane_input_pending "w1:p1"; then
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
  if PATH="$fb:$PATH" fm_pane_input_pending "w1:p1"; then
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
  if PATH="$fb:$PATH" fm_pane_input_pending "w1:p1"; then
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
  if PATH="$fb:$PATH" fm_pane_input_pending "w1:p1"; then
    fail "rounded bottom border falsely read as pending"
  fi
  pass "fm_pane_input_pending: rounded bottom border is NOT pending"
}

test_bypass_permissions_footer_empty_composer_is_not_pending() {
  local dir fb
  dir="$TMP_ROOT/bypass-footer-empty"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  # Reproduces the exact frame from a freshly-launched
  # `claude --permission-mode bypassPermissions` session: token counter above
  # the box, an empty "❯" composer between two borders, and the bypass-
  # permissions mode footer below the box. The old implementation read only
  # the last visible line (the footer) and misread it as a human draft.
  export FM_FAKE_PANE_LINES=$'                                       0 tokens\n────────────────────────────────────────────────────\n❯\n────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) \xc2\xb7 15% context left'
  export FM_FAKE_AGENT_STATUS="idle"
  if PATH="$fb:$PATH" fm_pane_input_pending "w1:p1"; then
    fail "empty composer with bypass-permissions footer falsely read as pending"
  fi
  pass "fm_pane_input_pending: empty composer with bypass-permissions footer is NOT pending"
}

test_bypass_permissions_footer_genuine_draft_is_pending() {
  local dir fb
  dir="$TMP_ROOT/bypass-footer-draft"; mkdir -p "$dir"
  fb=$(make_fake_herdr "$dir")
  # Same chrome (token counter, borders, bypass-permissions footer) but with
  # real human-typed text on the composer's content line. Must still block.
  export FM_FAKE_PANE_LINES=$'                                       12 tokens\n────────────────────────────────────────────────────\n❯ fix findings 1 and 3\n────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) \xc2\xb7 15% context left'
  export FM_FAKE_AGENT_STATUS="idle"
  PATH="$fb:$PATH" fm_pane_input_pending "w1:p1" \
    || fail "genuine draft text with bypass-permissions footer not detected as pending"
  pass "fm_pane_input_pending: genuine draft text with bypass-permissions footer is pending"
}

test_working_status_is_busy
test_idle_status_is_not_busy
test_bordered_empty_composer_is_not_pending
test_real_text_in_composer_is_pending
test_empty_pane_is_not_pending
test_prompt_glyph_only_is_not_pending
test_working_status_not_pending
test_rounded_bottom_border_is_not_pending
test_bypass_permissions_footer_empty_composer_is_not_pending
test_bypass_permissions_footer_genuine_draft_is_pending
