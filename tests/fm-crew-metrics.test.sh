#!/usr/bin/env bash
# tests/fm-crew-metrics.test.sh - smoke tests for the passive crew-metrics
# harvester (benchmarks/eval-runner/crew-metrics.py).
#
# crew-metrics is documented as zero-cost / no agents, but this test only
# exercises --help: a full run needs a live omp installation and a real
# fleet's state/ dir, neither of which belong in the pure behavior suite.
# What matters here is that the wrapper's no-op path is cap-machine-
# agnostic and that its --home default derives from fm_paths rather than a
# hardcoded absolute. Also covers fm_paths.py's own root-derivation contract
# (migrated here from the retired benchmarks/eval-runner/fm-eval-run.py test,
# since fm_paths.py is a shared helper and crew-metrics is now its only
# consumer).
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
  printf 'ok - SKIP fm-crew-metrics (python3 not found)\n'
  exit 0
fi

RUN=("$ROOT/sbin/fm" crew-metrics)
EVAL_DIR="$ROOT/benchmarks/eval-runner"

TMP=
DECOY_HOME=
cleanup() {
  [ -z "$TMP" ] || rm -rf "$TMP"
  [ -z "$DECOY_HOME" ] || rm -rf "$DECOY_HOME"
}
trap cleanup EXIT
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fm-crew-metrics.XXXXXX")"
DECOY_HOME="$(mktemp -d "${TMPDIR:-/tmp}/fm-crew-metrics-decoy-home.XXXXXX")"

# --- wrapper --help, from a neutral cwd, must exit 0 and never touch a
#     cap-specific absolute path ------------------------------------------
before="$(find "$DECOY_HOME" | sort)"
out="$(cd "$TMP" && HOME="$DECOY_HOME" "${RUN[@]}" --help 2>&1)"
rc=$?
[ "$rc" -eq 0 ] || fail "fm crew-metrics --help exited $rc"
after="$(find "$DECOY_HOME" | sort)"
[ "$before" = "$after" ] || fail "fm crew-metrics --help wrote into \$HOME"
assert_contains "$out" "--home" "help text documents --home"
assert_not_contains "$out" "/Users/" "help text must not leak any cap absolute path"
pass "fm crew-metrics --help is a clean no-op from a neutral cwd/HOME"

# --- crew-metrics.py wires --home's default to fm_paths.fm_home(), which
#     honors FM_HOME, instead of a hardcoded cap absolute -----------------
grep -q 'default=str(fm_paths.fm_home())' "$EVAL_DIR/crew-metrics.py" \
  || fail "crew-metrics.py --home default no longer derives from fm_paths.fm_home()"
FAKE_HOME="$TMP/fake-home"
mkdir -p "$FAKE_HOME"
FAKE_HOME="$(cd -P "$FAKE_HOME" && pwd)"  # canonicalize (e.g. macOS /tmp -> /private/var symlink) to match fm_paths' physical resolution
resolved_home="$(cd "$TMP" && EVAL_DIR="$EVAL_DIR" FM_HOME="$FAKE_HOME" python3 -c '
import os, sys
sys.path.insert(0, os.environ["EVAL_DIR"])
import fm_paths
print(fm_paths.fm_home())
')"
[ "$resolved_home" = "$FAKE_HOME" ] || fail "fm_paths.fm_home() = '$resolved_home', want FM_HOME override '$FAKE_HOME'"
pass "crew-metrics --home default honors FM_HOME instead of a hardcoded path"

# --- fm_paths.code_root() derives the repo root from its own on-disk location,
#     regardless of cwd/$HOME/a stale $FM_HOME (migrated from the now-retired
#     benchmarks/eval-runner/fm-eval-run.py test - fm_paths.py is shared, this
#     is the only remaining consumer's test suite) --------------------------
code_root_out="$(cd "$TMP" && EVAL_DIR="$EVAL_DIR" HOME="$DECOY_HOME" FM_HOME="$DECOY_HOME" python3 -c '
import os, sys
sys.path.insert(0, os.environ["EVAL_DIR"])
import fm_paths
print(fm_paths.code_root())
')"
[ "$code_root_out" = "$ROOT" ] || fail "code_root() = '$code_root_out', want repo root '$ROOT'"
pass "fm_paths.code_root() derives the repo root from the script's own location"

# --- python3 syntax check ----------------------------------------------------
python3 -m py_compile "$EVAL_DIR/crew-metrics.py" "$EVAL_DIR/fm_paths.py" || fail "crew-metrics.py / fm_paths.py fail py_compile"
pass "crew-metrics.py and fm_paths.py are syntactically valid"

printf 'PASS fm-crew-metrics\n'
