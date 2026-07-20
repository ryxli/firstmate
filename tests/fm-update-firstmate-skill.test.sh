#!/usr/bin/env bash
# Contract checks for the tracked fm-update-firstmate skill.
#
# The shared procedure must update the generic firstmate fleet first, then read
# an optional local target list from data/update-targets.md. The list is
# intentionally local and untracked: a missing file means there are no extra
# repositories.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL="$ROOT/.agents/skills/fm-update-firstmate/SKILL.md"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-update-firstmate-skill.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

assert_contains() {
  case "$1" in
    *"$2"*) : ;;
    *) fail "$3 (missing: $2)" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "$3 (unexpected: $2)" ;;
    *) : ;;
  esac
}

read_optional_targets() {
  local targets=$1 line
  [ -f "$targets" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == '- '* ]]; then
      printf '%s\n' "${line#- }"
    fi
  done < "$targets"
}

test_generic_skill_source() {
  local source before_targets
  source=$(<"$SKILL")
  before_targets=${source%%'## Optional local infrastructure'*}

  assert_contains "$before_targets" 'sbin/fm update' \
    "generic fleet update precedes optional local targets"
  assert_contains "$source" 'data/update-targets.md' \
    "skill documents the local update-targets file contract"
  assert_contains "$source" 'missing file means no optional targets' \
    "skill defines the absent-target behavior"
  assert_not_contains "$source" '## Personal infrastructure update set' \
    "skill must not teach the retired cap.md section"
  assert_not_contains "$source" 'data/cap.md' \
    "skill must not read optional targets from data/cap.md"

  local forbidden
  for forbidden in '/Users/' 'chezmoi' 'dotfiles' 'oh-my-pi' 'lavish-axi'; do
    assert_not_contains "$source" "$forbidden" \
      "shared skill contains no personal infrastructure enumeration"
  done
  pass "generic source is fleet-first and free of personal target enumeration"
}

test_configured_local_targets() {
  local targets out expected
  targets="$TMP_ROOT/update-targets.md"
  cat > "$targets" <<'EOF'
# Optional local infrastructure update targets
# Consumed by skill://fm-update-firstmate after fleet update. Not preloaded.

- /tmp/private-tooling-a
- /tmp/private-tooling-b
EOF

  out=$(read_optional_targets "$targets")
  expected=$'/tmp/private-tooling-a\n/tmp/private-tooling-b'
  [ "$out" = "$expected" ] || fail "configured local targets were not read exactly"
  pass "configured local targets are selected from data/update-targets.md"
}

test_absent_local_targets() {
  local out
  out=$(read_optional_targets "$TMP_ROOT/missing-update-targets.md")
  [ -z "$out" ] || fail "missing local target file must select no repositories"
  pass "absent local target file selects no optional repositories"
}

test_generic_skill_source
test_configured_local_targets
test_absent_local_targets

echo "# all fm-update-firstmate skill contract checks passed"
