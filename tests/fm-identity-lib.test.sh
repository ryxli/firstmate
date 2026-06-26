#!/usr/bin/env bash
# Unit tests for fm-identity-lib.sh: supervisor identity resolution, task-slug
# derivation (random suffix stripping), and worker label composition. These are
# pure functions with no herdr/git side effects.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-identity-lib.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

# shellcheck source=bin/fm-identity-lib.sh
. "$ROOT/bin/fm-identity-lib.sh"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

eq() {
  # eq <description> <expected> <actual>
  [ "$2" = "$3" ] || fail "$1: expected [$2], got [$3]"
}

# A config dir with a full identity file.
CFG_KEEL="$TMP_ROOT/keel/config"
mkdir -p "$CFG_KEEL"
printf 'name=Keel\nrole=Main firstmate crew supervisor\nparent=captain\n' > "$CFG_KEEL/identity"

# A config dir with whitespace around values.
CFG_WS="$TMP_ROOT/ws/config"
mkdir -p "$CFG_WS"
printf 'name =  Anchor Bay \n' > "$CFG_WS/identity"

# An empty config dir (no identity file).
CFG_EMPTY="$TMP_ROOT/empty/config"
mkdir -p "$CFG_EMPTY"

test_identity_values() {
  eq "supervisor name" "Keel" "$(fm_supervisor_name "$CFG_KEEL")"
  eq "supervisor role" "Main firstmate crew supervisor" "$(fm_supervisor_role "$CFG_KEEL")"
  eq "supervisor parent" "captain" "$(fm_supervisor_parent "$CFG_KEEL")"
  eq "supervisor slug" "keel" "$(fm_supervisor_slug "$CFG_KEEL")"
  pass "identity values read from config/identity"
}

test_identity_whitespace_trimmed() {
  eq "trimmed name" "Anchor Bay" "$(fm_supervisor_name "$CFG_WS")"
  eq "slug lowercases and hyphenates spaces" "anchor-bay" "$(fm_supervisor_slug "$CFG_WS")"
  pass "identity value whitespace trimmed; slug normalized"
}

test_identity_defaults() {
  eq "default name" "firstmate" "$(fm_supervisor_name "$CFG_EMPTY")"
  eq "default role" "firstmate crew supervisor" "$(fm_supervisor_role "$CFG_EMPTY")"
  eq "default parent" "captain" "$(fm_supervisor_parent "$CFG_EMPTY")"
  eq "default slug preserves fm- shape" "fm" "$(fm_supervisor_slug "$CFG_EMPTY")"
  pass "neutral defaults when no identity file"
}

test_task_slug_strips_random_suffix() {
  eq "letter+digit suffix stripped" "fix-login" "$(fm_task_slug fix-login-k3)"
  eq "another suffix stripped" "teardown-pane-close" "$(fm_task_slug teardown-pane-close-b8)"
  pass "fm_task_slug strips the -<letter><digit> random suffix"
}

test_task_slug_preserves_non_suffix_ids() {
  eq "no random suffix preserved" "fm-spawn-crew-tab" "$(fm_task_slug fm-spawn-crew-tab)"
  eq "trailing word preserved" "add-retries" "$(fm_task_slug add-retries)"
  pass "fm_task_slug leaves ids without the suffix shape intact"
}

test_worker_label_composition() {
  eq "named supervisor label" "keel/fix-login" "$(fm_worker_label "$CFG_KEEL" fix-login-k3)"
  eq "default supervisor label" "fm/fix-login" "$(fm_worker_label "$CFG_EMPTY" fix-login-k3)"
  pass "worker label is <supervisor>/<task-slug>"
}

test_worker_label_explicit_override() {
  eq "explicit label wins" "keel/custom-name" "$(fm_worker_label "$CFG_KEEL" fix-login-k3 keel/custom-name)"
  pass "explicit worker label overrides derivation"
}

test_identity_values
test_identity_whitespace_trimmed
test_identity_defaults
test_task_slug_strips_random_suffix
test_task_slug_preserves_non_suffix_ids
test_worker_label_composition
test_worker_label_explicit_override
