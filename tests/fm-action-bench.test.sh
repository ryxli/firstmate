#!/usr/bin/env bash
# tests/fm-action-bench.test.sh - pure-core tests for action-bench
# (benchmarks/action-bench). NO live LLM runs here: every case drives the
# deterministic core - the integrity gates (which police the corpus's fairness),
# the replay aggregation math, and the refuses-without-live guard on the live path.
#
# Requires bun (the bench runtime) and python3 (some scenario graders shell out to
# python3 to run a generated fixture test). A host missing either skips cleanly so
# the rest of the pure-bash suite still runs everywhere.

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

RUN="$ROOT/sbin/fm"

if ! command -v bun >/dev/null 2>&1; then
  printf 'ok - SKIP fm-action-bench (bun not found; CI installs it via setup-bun)\n'
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  printf 'ok - SKIP fm-action-bench (python3 not found; some fixture graders need it)\n'
  exit 0
fi

# Self-managed temp dir (NOT fm_test_tmproot): its EXIT-trap cleanup fires inside
# every $(...) subshell on bash 3.2 and would delete the dir mid-test. We clean up
# explicitly at the end instead; an early fail-exit leaks one dir under TMPDIR (fine).
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fm-action-bench.XXXXXX")"

# --- integrity gates pass on the real corpus --------------------------------
out="$("$RUN" action-bench gates)" || fail "gates exited nonzero on the real corpus"
assert_contains "$out" "integrity gates: ALL PASS" "real corpus passes every integrity gate"
assert_contains "$out" "x 6 gates" "reports the 6-gate suite"
n=$(printf '%s\n' "$out" | sed -n 's/.*(\([0-9]\{1,\}\) scenarios x 6 gates).*/\1/p')
[ -n "$n" ] && [ "$n" -ge 25 ] || fail "corpus has $n scenarios, want >= 25"
pass "integrity gates ALL PASS on the real corpus ($n scenarios)"

# --- gates DETECT a poisoned arm (a leaked solution marker) -----------------
# ref-easy-uppercase declares leakMarker "HELLO WORLD"; an arm carrying it must
# trip no-leak + scaffold-agnostic, so the run aborts. Proves the gate can fail.
printf 'HELLO WORLD\n' > "$TMP/leak-arm.txt"
if "$RUN" action-bench gates --arm-file "$TMP/leak-arm.txt" >/dev/null 2>&1; then
  fail "gates must FAIL when a solution marker leaks into an arm"
fi
pass "gates catch a leaked solution marker in the harness arm"

# --- corpus metrics + sanitize verdict (deterministic, pure) ----------------
cout="$("$RUN" action-bench corpus)" || fail "corpus exited nonzero on the real (clean) corpus"
CORPUS="$cout" bun -e '
const j = JSON.parse(process.env.CORPUS);
const chk = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } };
chk(j.totalScenarios >= 25, "totalScenarios=" + j.totalScenarios);
chk(j.synthetic + j.realHistory === j.totalScenarios, "split does not sum");
chk(j.realHistory >= 5, "realHistory=" + j.realHistory);
// at least one real-history scenario from EACH queued source class
chk(j.bySourceClass["backlog-done"] >= 1, "backlog-done=" + j.bySourceClass["backlog-done"]);
chk(j.bySourceClass["state-status"] >= 1, "state-status=" + j.bySourceClass["state-status"]);
chk(j.bySourceClass["session-history"] >= 1, "session-history=" + j.bySourceClass["session-history"]);
chk(typeof j.byDifficulty.medium === "number", "difficulty distribution missing");
chk(j.sanitization.status === "clean", "sanitization status=" + j.sanitization.status);
chk(j.sanitization.selfTest.passed === true, "sanitizer self-test failed");
chk(j.sanitization.findings.length === 0, "unexpected sanitize findings");
' || fail "corpus metrics wrong"
pass "corpus metrics correct (counts, per-source-class coverage, clean sanitize verdict)"

# --- sanitizer NEGATIVE CONTROL: unsafe real-history content aborts ---------
# FM_ACTION_BENCH_POISON injects a real-history scenario whose fixture leaks an
# absolute home path / secret-like value; the sanitize gate MUST catch it and abort.
# Proves the gate fails on unsafe content, not only that a clean corpus passes.
for kind in abspath secret; do
  if FM_ACTION_BENCH_POISON="$kind" "$RUN" action-bench gates >/dev/null 2>&1; then
    fail "sanitize gate must FAIL on a poisoned real-history scenario ($kind)"
  fi
  pout="$(FM_ACTION_BENCH_POISON="$kind" "$RUN" action-bench gates 2>&1 || true)"
  assert_contains "$pout" "FAIL" "poison ($kind) reports a gate failure"
  assert_contains "$pout" "real-history-safe" "poison ($kind) trips real-history-safe"
  pass "sanitize gate catches a poisoned real-history $kind"
done

# --- replay aggregation math (synthetic runs.json, deterministic) -----------
# 2 arms x easy tier. control: 1 correct + 1 miss. harness: 1 correct + 1 corrupt
# success (goal reached but procedurally dirty) - which must NOT count as correct.
cat > "$TMP/agg.runs.json" <<'JSON'
{
  "runs": [
    { "scenario": "s1", "difficulty": "easy", "arm": "control", "trial": 0, "correct": true,  "goalCorrect": true,  "proceduralClean": true,  "goalProgress": 1, "reasoningTokens": 100, "turns": 3 },
    { "scenario": "s1", "difficulty": "easy", "arm": "control", "trial": 1, "correct": false, "goalCorrect": false, "proceduralClean": true,  "goalProgress": 0, "reasoningTokens": 40,  "turns": 2 },
    { "scenario": "s1", "difficulty": "easy", "arm": "harness", "trial": 0, "correct": true,  "goalCorrect": true,  "proceduralClean": true,  "goalProgress": 1, "reasoningTokens": 50,  "turns": 2 },
    { "scenario": "s1", "difficulty": "easy", "arm": "harness", "trial": 1, "correct": false, "goalCorrect": true,  "proceduralClean": false, "goalProgress": 1, "reasoningTokens": 60,  "turns": 2 }
  ]
}
JSON
"$RUN" action-bench replay "$TMP/agg.runs.json" > "$TMP/agg.out.json" || fail "replay exited nonzero"
AGG="$TMP/agg.out.json" bun -e '
const j = JSON.parse(require("fs").readFileSync(process.env.AGG, "utf8"));
const chk = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } };
const c = j.arms.control.byDifficulty.easy;
const h = j.arms.harness.byDifficulty.easy;
chk(c.correctnessRate === 0.5, "control correctnessRate=" + c.correctnessRate);
chk(c.goalRate === 0.5, "control goalRate=" + c.goalRate);
chk(c.corruptSuccess === 0, "control corruptSuccess=" + c.corruptSuccess);
chk(c.reasoningTokensToPass.median === 100, "control reason-median=" + JSON.stringify(c.reasoningTokensToPass));
chk(h.correctnessRate === 0.5, "harness correctnessRate=" + h.correctnessRate);
chk(h.goalRate === 1, "harness goalRate=" + h.goalRate);
chk(h.corruptSuccess === 1, "harness corruptSuccess (reward-hack) =" + h.corruptSuccess);
chk(h.reasoningTokensToPass.median === 50, "harness reason-median=" + JSON.stringify(h.reasoningTokensToPass));
chk(j.arms.control.overallCorrectness === 0.5, "control overall=" + j.arms.control.overallCorrectness);
chk(j.arms.control.capabilityFrontier === "easy", "control frontier=" + j.arms.control.capabilityFrontier);
' || fail "replay aggregation math wrong"
pass "replay aggregation math correct (rates, corrupt-success guard, cost-of-pass, frontier)"

# --- the live path refuses without --live -----------------------------------
"$RUN" action-bench run >/dev/null 2>&1 && fail "run must refuse the live path without --live"
pass "run refuses to spend tokens without --live"

rm -rf "$TMP"
printf 'PASS fm-action-bench\n'
