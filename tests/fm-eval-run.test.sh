#!/usr/bin/env bash
# tests/fm-eval-run.test.sh - smoke + root-derivation tests for the
# deterministic-substrate eval runner (benchmarks/eval-runner/fm-eval-run.py).
#
# No live gates are exercised here (those need git/bun/shellcheck against a
# real checkout and cost real time): this only proves the --help no-op path
# is captain-machine-agnostic and that fm_paths.py derives the code root from
# the script's own on-disk location rather than any hardcoded absolute path.
#
# Requires python3. A host without it skips cleanly so the rest of the pure-
# bash suite still runs everywhere.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -u

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

assert_contains() {
  case "$1" in
    *"$2"*) : ;;
    *) fail "$3 (missing: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "$3 (unexpected: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
    *) : ;;
  esac
}

if ! command -v python3 >/dev/null 2>&1; then
  printf 'ok - SKIP fm-eval-run (python3 not found)\n'
  exit 0
fi

RUN="$ROOT/sbin/fm-eval-run.sh"
EVAL_DIR="$ROOT/benchmarks/eval-runner"

TMP=
DECOY_HOME=
cleanup() {
  [ -z "$TMP" ] || rm -rf "$TMP"
  [ -z "$DECOY_HOME" ] || rm -rf "$DECOY_HOME"
}
trap cleanup EXIT
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fm-eval-run.XXXXXX")"
DECOY_HOME="$(mktemp -d "${TMPDIR:-/tmp}/fm-eval-run-decoy-home.XXXXXX")"

# --- wrapper --help, from a neutral cwd, must exit 0 and never touch a
#     captain-specific absolute path ------------------------------------------
before="$(find "$DECOY_HOME" | sort)"
out="$(cd "$TMP" && HOME="$DECOY_HOME" "$RUN" --help 2>&1)"
rc=$?
[ "$rc" -eq 0 ] || fail "fm-eval-run.sh --help exited $rc"
after="$(find "$DECOY_HOME" | sort)"
[ "$before" = "$after" ] || fail "fm-eval-run.sh --help wrote into \$HOME"
assert_contains "$out" "targets" "help text documents the TARGET argument"
assert_not_contains "$out" "/Users/" "help text must not leak any captain absolute path"
pass "fm-eval-run.sh --help is a clean no-op from a neutral cwd/HOME"

# --- root derivation: fm_paths.code_root() resolves to this repo, from any
#     cwd, regardless of $HOME or a stale $FM_HOME ---------------------------
out2="$(cd "$TMP" && EVAL_DIR="$EVAL_DIR" HOME="$DECOY_HOME" FM_HOME="$DECOY_HOME" python3 -c '
import os, sys
sys.path.insert(0, os.environ["EVAL_DIR"])
import fm_paths
print(fm_paths.code_root())
')"
[ "$out2" = "$ROOT" ] || fail "code_root() = '$out2', want repo root '$ROOT'"
pass "fm_paths.code_root() derives the repo root from the script's own location"

# --- fm_home() honors FM_HOME override, independent of code_root() ----------
FAKE_HOME="$TMP/fake-home"
mkdir -p "$FAKE_HOME"
FAKE_HOME="$(cd -P "$FAKE_HOME" && pwd)"  # canonicalize (e.g. macOS /tmp -> /private/var symlink) to match fm_paths' physical resolution
out3="$(cd "$TMP" && EVAL_DIR="$EVAL_DIR" FM_HOME="$FAKE_HOME" python3 -c '
import os, sys
sys.path.insert(0, os.environ["EVAL_DIR"])
import fm_paths
print(fm_paths.fm_home())
print(fm_paths.code_root())
')"
home_line="$(printf '%s\n' "$out3" | sed -n 1p)"
root_line="$(printf '%s\n' "$out3" | sed -n 2p)"
[ "$home_line" = "$FAKE_HOME" ] || fail "fm_home() = '$home_line', want FM_HOME override '$FAKE_HOME'"
[ "$root_line" = "$ROOT" ] || fail "code_root() changed under FM_HOME override: '$root_line'"
pass "fm_paths.fm_home() honors FM_HOME while code_root() stays repo-derived"

# --- python3 syntax check ----------------------------------------------------
python3 -m py_compile "$EVAL_DIR/fm-eval-run.py" "$EVAL_DIR/fm_paths.py" || fail "fm-eval-run.py / fm_paths.py fail py_compile"
pass "fm-eval-run.py and fm_paths.py are syntactically valid"

printf 'PASS fm-eval-run\n'
