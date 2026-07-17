#!/usr/bin/env bash
# tests/fm-milestone.test.sh - smoke + determinism tests for sbin/fm-milestone.sh
# (benchmarks/milestone/run.ts), the thin longitudinal composition layer over
# action-bench gates/corpus, the supervision replay bench, fm-context-weight,
# and the tests/*.test.sh behavior suite.
#
# Restricted to a single fast tests/*.test.sh file via FM_MILESTONE_TESTS_ONLY so
# this stays quick; a real milestone run measures the full suite by default. The
# tool's own test file is always excluded from that stage regardless (it would
# otherwise invoke sbin/fm-milestone.sh from inside its own measurement).
#
# Requires bun (the bench/context-weight runtime), python3 (JSON diffing here),
# and git (the --compare snapshot path). A host missing bun or python3 skips
# cleanly so the rest of the pure-bash suite still runs everywhere.

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

RUN="$ROOT/sbin/fm-milestone.sh"

if ! command -v bun >/dev/null 2>&1; then
  printf 'ok - SKIP fm-milestone (bun not found; CI installs it via setup-bun)\n'
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  printf 'ok - SKIP fm-milestone (python3 not found)\n'
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fm-milestone.XXXXXX")"
export FM_MILESTONE_TESTS_ONLY='^fm-action-bench\.test\.sh$'

# --- one run produces one valid row + a matching markdown section ----------
out="$("$RUN" smoke --out "$TMP/out1" --captured 2026-01-01T00:00:00.000000+00:00 --jobs 4 2>&1)" \
  || fail "fm-milestone.sh exited nonzero on a live run"$'\n'"$out"
assert_contains "$out" "milestone 'smoke' appended" "reports the appended milestone"
[ -f "$TMP/out1/milestones.jsonl" ] || fail "milestones.jsonl was not written"
[ -f "$TMP/out1/milestones.md" ] || fail "milestones.md was not written"
[ "$(wc -l < "$TMP/out1/milestones.jsonl" | tr -d ' ')" = "1" ] || fail "expected exactly one jsonl row"
assert_contains "$(cat "$TMP/out1/milestones.md")" "## smoke" "markdown section for the milestone"

ROW="$TMP/out1/milestones.jsonl" python3 -c '
import json, os
row = json.loads(open(os.environ["ROW"]).read().splitlines()[0])
required = ["schema", "captured", "milestone", "sha", "corpus_scenarios", "trials", "note", "models", "gates", "context_weight", "elapsed_s"]
missing = [k for k in required if k not in row]
assert not missing, f"row missing top-level keys: {missing}"
g = row["gates"]
for k in ("action_bench", "corpus", "supervision", "tests"):
    assert k in g, f"gates missing {k}"
assert row["gates"]["action_bench"]["ok"] is True, "action-bench gates did not pass on the real corpus"
assert row["gates"]["corpus"]["sanitize_status"] == "clean", "corpus sanitize status not clean"
assert row["gates"]["tests"]["files"] == 1, "tests stage did not restrict to the FM_MILESTONE_TESTS_ONLY file"
assert row["context_weight"]["total_tokens"] > 0, "context-weight total_tokens must be positive"
assert len(row["context_weight"]["table_hash"]) == 16, "table_hash must be a 16-char hex digest"
assert row["models"] == [], "models must be empty when no --runs are supplied"
' || fail "milestone row schema check failed"
pass "one run produces one valid superset row (schema, gates, context-weight, empty models)"

# --- re-running with identical inputs reproduces an identical row ----------
# except captured (pinned identical here anyway) and per-stage wall-clock
# "secs"/"elapsed_s" fields, which measure real subprocess wall time and can
# never be bit-identical across two separate invocations.
out2="$("$RUN" smoke --out "$TMP/out2" --captured 2026-01-01T00:00:00.000000+00:00 --jobs 4 2>&1)" \
  || fail "fm-milestone.sh exited nonzero on the repeat run"$'\n'"$out2"

A="$TMP/out1/milestones.jsonl" B="$TMP/out2/milestones.jsonl" python3 -c '
import json, os

def strip_volatile(obj):
    if isinstance(obj, dict):
        return {k: strip_volatile(v) for k, v in obj.items() if k not in ("secs", "elapsed_s")}
    if isinstance(obj, list):
        return [strip_volatile(v) for v in obj]
    return obj

a = strip_volatile(json.loads(open(os.environ["A"]).read().splitlines()[0]))
b = strip_volatile(json.loads(open(os.environ["B"]).read().splitlines()[0]))
assert a == b, f"rows differ beyond timestamp/wall-clock fields:\nA={json.dumps(a, indent=2, sort_keys=True)}\nB={json.dumps(b, indent=2, sort_keys=True)}"
' || fail "re-run was not deterministic modulo timestamp/wall-clock"
pass "re-running with identical inputs reproduces an identical row (modulo timestamp + wall-clock)"

# --- FM_MILESTONE_NOTE / --note flows into the row and the markdown --------
out3="$(FM_MILESTONE_NOTE='env note' "$RUN" noted --out "$TMP/out3" --jobs 4 2>&1)" \
  || fail "fm-milestone.sh exited nonzero with FM_MILESTONE_NOTE set"$'\n'"$out3"
assert_contains "$(cat "$TMP/out3/milestones.md")" "_env note_" "note renders in the markdown section"

rm -rf "$TMP"
printf 'PASS fm-milestone\n'
