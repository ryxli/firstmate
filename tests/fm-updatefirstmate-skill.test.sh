#!/usr/bin/env bash
# Contract checks for the tracked updatefirstmate skill.
#
# The shared procedure must update the generic firstmate fleet first, then read
# an optional local target list from data/captain.md. The list is intentionally
# local and untracked: a missing section means there are no extra repositories.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL="$ROOT/.agents/skills/updatefirstmate/SKILL.md"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-updatefirstmate-skill.XXXXXX")
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

# Interpret the documented local section shape. Only direct bullets in the
# section name additional checkouts; the next level-two heading ends the set.
read_optional_targets() {
  local captain=$1 line in_set=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = "## Personal infrastructure update set" ]; then
      in_set=1
      continue
    fi
    if [ "$in_set" -eq 1 ] && [[ "$line" == '## '* ]]; then
      break
    fi
    if [ "$in_set" -eq 1 ] && [[ "$line" == '- '* ]]; then
      printf '%s\n' "${line#- }"
    fi
  done < "$captain"
}

test_generic_skill_source() {
  local source before_targets
  source=$(<"$SKILL")
  before_targets=${source%%'## Personal infrastructure update set'*}

  assert_contains "$before_targets" 'sbin/fm-update.sh' \
    "generic fleet update precedes optional local targets"
  # shellcheck disable=SC2016
  assert_contains "$source" 'read the optional `## Personal infrastructure update set` section in local `data/captain.md`' \
    "skill documents the local target contract"
  assert_contains "$source" 'If the section is missing or has no entries, update no optional repositories.' \
    "skill defines the absent-target behavior"

  local forbidden
  for forbidden in '/Users/' 'chezmoi' 'dotfiles' 'oh-my-pi' 'lavish-axi' 'linear-axi'; do
    assert_not_contains "$source" "$forbidden" \
      "shared skill contains no personal infrastructure enumeration"
  done
  pass "generic source is fleet-first and free of personal target enumeration"
}

test_configured_local_targets() {
  local captain out expected
  captain="$TMP_ROOT/configured-captain.md"
  cat > "$captain" <<'EOF'
## Preferences
- Keep updates safe.

## Personal infrastructure update set
- /tmp/private-tooling-a
- /tmp/private-tooling-b

## Communication
- Be concise.
EOF

  out=$(read_optional_targets "$captain")
  expected=$'/tmp/private-tooling-a\n/tmp/private-tooling-b'
  [ "$out" = "$expected" ] || fail "configured local targets were not read exactly"
  pass "configured local targets are selected from the documented section"
}

test_absent_local_targets() {
  local captain out
  captain="$TMP_ROOT/absent-captain.md"
  cat > "$captain" <<'EOF'
## Preferences
- Keep updates safe.
EOF

  out=$(read_optional_targets "$captain")
  [ -z "$out" ] || fail "missing local target section must select no repositories"
  pass "absent local target section selects no optional repositories"
}

test_generic_skill_source
test_configured_local_targets
test_absent_local_targets

echo "# all updatefirstmate skill contract checks passed"
