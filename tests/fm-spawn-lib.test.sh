#!/usr/bin/env bash
# Unit tests for fm-spawn-lib.sh: shell quoting (fm_shell_quote) and
# launch-command first-word extraction (fm_first_command_word). Both are pure
# functions with no herdr/git side effects.
set -u

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../bin" && pwd)"
# shellcheck source=bin/fm-spawn-lib.sh
. "$LIB_DIR/fm-spawn-lib.sh"

FAILED=0
eq() {
  local label=$1 want=$2 got=$3
  if [ "$want" = "$got" ]; then
    printf 'ok - %s\n' "$label"
  else
    printf 'not ok - %s (want [%s] got [%s])\n' "$label" "$want" "$got"
    FAILED=1
  fi
}
ok() { printf 'ok - %s\n' "$1"; }
bad() { printf 'not ok - %s\n' "$1"; FAILED=1; }

# fm_shell_quote wraps in single quotes and has no trailing newline.
eq "quote plain" "'abc'" "$(fm_shell_quote abc)"
eq "quote with spaces" "'a b'" "$(fm_shell_quote 'a b')"
eq "quote empty" "''" "$(fm_shell_quote '')"

# The real contract: a quoted value evals back to the exact original, however
# nasty (single quotes, double quotes, dollar signs, spaces).
roundtrip() {
  local v=$1 q out
  q=$(fm_shell_quote "$v")
  eval "out=$q"
  [ "$out" = "$v" ]
}
if roundtrip "it's a \"weird\" \$value with 'quotes'"; then
  ok "quote round-trips through eval"
else
  bad "quote round-trip"
fi

# fm_first_command_word: skip VAR=val env assignments, basename the first word.
eq "plain command" "omp" "$(fm_first_command_word 'omp --auto-approve x')"
eq "skips env assignments" "codex" "$(fm_first_command_word 'FOO=1 BAR=2 codex run')"
eq "basename of a path" "claude" "$(fm_first_command_word '/usr/local/bin/claude --flag')"
if fm_first_command_word 'FOO=1 BAR=2' >/dev/null 2>&1; then
  bad "only-assignments should return rc 1"
else
  ok "only-assignments returns rc 1"
fi

if [ "$FAILED" = 0 ]; then
  printf 'PASS fm-spawn-lib\n'
else
  printf 'FAIL fm-spawn-lib\n'
  exit 1
fi
