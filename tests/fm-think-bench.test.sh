#!/usr/bin/env bash
# tests/fm-think-bench.test.sh - pure-core tests for the thinking-efficiency
# bench (benchmarks/thinking). NO live LLM runs here: every case drives the
# deterministic subcommands (check-corpus, grade, replay) against fixtures and
# asserts the adopt-iff verdict FLIPS on exactly the right signals, plus the
# aggregation math, corpus validation, and deterministic replay.
#
# Requires bun (the bench runtime). CI installs it via setup-bun; a host without
# bun skips cleanly so the rest of the pure-bash suite still runs everywhere.

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
set -u

RUN="$ROOT/bin/fm-think-bench.sh"

if ! command -v bun >/dev/null 2>&1; then
  printf 'ok - SKIP fm-think-bench (bun not found; CI installs it via setup-bun)\n'
  exit 0
fi

TMP="$(fm_test_tmproot fm-think-bench)"

# --- corpus loader: real corpus validates -----------------------------------
out="$("$RUN" check-corpus)" || fail "check-corpus exited nonzero"
assert_contains "$out" "arithmetic-shelf" "real corpus lists its tasks"
count=$(printf '%s\n' "$out" | grep -c '^- ')
[ "$count" -ge 4 ] || fail "corpus has $count tasks, want >= 4"
pass "corpus loader validates the real corpus ($count tasks)"

# malformed oracle -> nonzero
mkdir -p "$TMP/bad-oracle"
printf '{"id":"x","title":"x","prompt":"x","oracle":{"kind":"bogus"}}' > "$TMP/bad-oracle/x.json"
"$RUN" check-corpus "$TMP/bad-oracle" >/dev/null 2>&1 && fail "malformed oracle should fail"
pass "corpus loader rejects a malformed oracle kind"

# missing required field -> nonzero
mkdir -p "$TMP/bad-field"
printf '{"id":"y","title":"y","oracle":{"kind":"numeric","expected":1}}' > "$TMP/bad-field/y.json"
"$RUN" check-corpus "$TMP/bad-field" >/dev/null 2>&1 && fail "missing prompt should fail"
pass "corpus loader rejects a task missing a required field"

# invalid JSON -> nonzero
mkdir -p "$TMP/bad-json"
printf '{not json' > "$TMP/bad-json/z.json"
"$RUN" check-corpus "$TMP/bad-json" >/dev/null 2>&1 && fail "invalid JSON should fail"
pass "corpus loader rejects invalid JSON"

# --- oracle (grade): pass + fail across kinds -------------------------------
printf '42' > "$TMP/out-num-ok.txt"
printf 'the result is 99 today' > "$TMP/out-num-bad.txt"
printf '{"kind":"numeric","expected":42}' > "$TMP/orc-num.json"
[ "$("$RUN" grade "$TMP/orc-num.json" "$TMP/out-num-ok.txt")" = "1" ] || fail "numeric oracle should pass on 42"
[ "$("$RUN" grade "$TMP/orc-num.json" "$TMP/out-num-bad.txt")" = "0" ] || fail "numeric oracle should fail on 99"
printf 'Lee won the gold medal' > "$TMP/out-contains.txt"
printf '{"kind":"contains","needles":["lee"],"ci":true}' > "$TMP/orc-contains.json"
[ "$("$RUN" grade "$TMP/orc-contains.json" "$TMP/out-contains.txt")" = "1" ] || fail "contains oracle should pass"
pass "oracle grades pass/fail deterministically"

# --- decision rule: synthetic fixtures, adopt/reject must flip ---------------
# ADOPT: new thinking median (90) < old (110), quality held (100% vs 100%).
cat > "$TMP/adopt.runs.json" <<'JSON'
{
  "meta": { "stamp": "2026-06-29T00:00:00.000Z", "model": "replay", "thinking": "medium", "baseline": "baseline", "candidate": "decide-once", "corpusSize": 1, "trialsPerCell": 3 },
  "metrics": [
    { "task": "t1", "variant": "baseline", "trial": 0, "thinking_tokens": 100, "output_tokens": 20, "latency_ms": 1000, "quality": 1, "ok": true },
    { "task": "t1", "variant": "baseline", "trial": 1, "thinking_tokens": 110, "output_tokens": 22, "latency_ms": 1100, "quality": 1, "ok": true },
    { "task": "t1", "variant": "baseline", "trial": 2, "thinking_tokens": 120, "output_tokens": 24, "latency_ms": 1200, "quality": 1, "ok": true },
    { "task": "t1", "variant": "decide-once", "trial": 0, "thinking_tokens": 80, "output_tokens": 18, "latency_ms": 900, "quality": 1, "ok": true },
    { "task": "t1", "variant": "decide-once", "trial": 1, "thinking_tokens": 90, "output_tokens": 19, "latency_ms": 950, "quality": 1, "ok": true },
    { "task": "t1", "variant": "decide-once", "trial": 2, "thinking_tokens": 100, "output_tokens": 20, "latency_ms": 1000, "quality": 1, "ok": true }
  ]
}
JSON
out="$("$RUN" replay "$TMP/adopt.runs.json")" || fail "replay adopt exited nonzero"
assert_contains "$out" "VERDICT: ADOPT NEW" "tokens-down + quality-held => ADOPT"

# REJECT (quality): new thinking lower BUT quality regresses (pass-rate drops).
cat > "$TMP/reject-quality.runs.json" <<'JSON'
{
  "meta": { "stamp": "2026-06-29T00:00:00.000Z", "model": "replay", "thinking": "medium", "baseline": "baseline", "candidate": "decide-once", "corpusSize": 1, "trialsPerCell": 3 },
  "metrics": [
    { "task": "t1", "variant": "baseline", "trial": 0, "thinking_tokens": 100, "output_tokens": 20, "latency_ms": 1000, "quality": 1, "ok": true },
    { "task": "t1", "variant": "baseline", "trial": 1, "thinking_tokens": 110, "output_tokens": 22, "latency_ms": 1100, "quality": 1, "ok": true },
    { "task": "t1", "variant": "baseline", "trial": 2, "thinking_tokens": 120, "output_tokens": 24, "latency_ms": 1200, "quality": 1, "ok": true },
    { "task": "t1", "variant": "decide-once", "trial": 0, "thinking_tokens": 80, "output_tokens": 18, "latency_ms": 900, "quality": 1, "ok": true },
    { "task": "t1", "variant": "decide-once", "trial": 1, "thinking_tokens": 90, "output_tokens": 19, "latency_ms": 950, "quality": 0, "ok": true },
    { "task": "t1", "variant": "decide-once", "trial": 2, "thinking_tokens": 100, "output_tokens": 20, "latency_ms": 1000, "quality": 0, "ok": true }
  ]
}
JSON
out="$("$RUN" replay "$TMP/reject-quality.runs.json")" || fail "replay reject-quality exited nonzero"
assert_contains "$out" "DO NOT ADOPT" "quality regression must block adoption"
assert_contains "$out" "quality regressed" "names the quality failing signal"
assert_not_contains "$out" "VERDICT: ADOPT NEW" "no ADOPT when quality regresses"

# REJECT (tokens): quality held BUT new thinking median (110) >= old (90).
cat > "$TMP/reject-tokens.runs.json" <<'JSON'
{
  "meta": { "stamp": "2026-06-29T00:00:00.000Z", "model": "replay", "thinking": "medium", "baseline": "baseline", "candidate": "decide-once", "corpusSize": 1, "trialsPerCell": 3 },
  "metrics": [
    { "task": "t1", "variant": "baseline", "trial": 0, "thinking_tokens": 80, "output_tokens": 20, "latency_ms": 1000, "quality": 1, "ok": true },
    { "task": "t1", "variant": "baseline", "trial": 1, "thinking_tokens": 90, "output_tokens": 22, "latency_ms": 1100, "quality": 1, "ok": true },
    { "task": "t1", "variant": "baseline", "trial": 2, "thinking_tokens": 100, "output_tokens": 24, "latency_ms": 1200, "quality": 1, "ok": true },
    { "task": "t1", "variant": "decide-once", "trial": 0, "thinking_tokens": 100, "output_tokens": 18, "latency_ms": 900, "quality": 1, "ok": true },
    { "task": "t1", "variant": "decide-once", "trial": 1, "thinking_tokens": 110, "output_tokens": 19, "latency_ms": 950, "quality": 1, "ok": true },
    { "task": "t1", "variant": "decide-once", "trial": 2, "thinking_tokens": 120, "output_tokens": 20, "latency_ms": 1000, "quality": 1, "ok": true }
  ]
}
JSON
out="$("$RUN" replay "$TMP/reject-tokens.runs.json")" || fail "replay reject-tokens exited nonzero"
assert_contains "$out" "DO NOT ADOPT" "no token reduction must block adoption"
assert_contains "$out" "thinking-tokens not reduced" "names the token failing signal"
pass "decision rule flips correctly (adopt, reject-on-quality, reject-on-tokens)"

# --- aggregation math (via the emitted verdict JSON) ------------------------
"$RUN" replay "$TMP/adopt.runs.json" --out "$TMP/agg" >/dev/null || fail "replay --out exited nonzero"
VJSON="$TMP/agg/verdict.json" bun -e '
const j = JSON.parse(require("fs").readFileSync(process.env.VJSON, "utf8"));
const b = j.aggregates.find((a) => a.variant === "baseline");
const n = j.aggregates.find((a) => a.variant === "decide-once");
const chk = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } };
chk(b.thinking.median === 110, "baseline thinking median=" + b.thinking.median);
chk(b.thinking.mean === 110, "baseline thinking mean=" + b.thinking.mean);
chk(b.thinking.stddev === 8.16, "baseline thinking stddev=" + b.thinking.stddev);
chk(n.thinking.median === 90, "candidate thinking median=" + n.thinking.median);
chk(b.quality_pass_rate === 1, "baseline pass-rate=" + b.quality_pass_rate);
chk(j.decision.thinkingTokenDelta === 20, "token delta=" + j.decision.thinkingTokenDelta);
chk(j.decision.adopt === true, "adopt=" + j.decision.adopt);
' || fail "aggregation math wrong"
pass "aggregation math (median/mean/stddev/pass-rate/delta) correct"

# --- replay determinism -----------------------------------------------------
"$RUN" replay "$TMP/adopt.runs.json" --out "$TMP/det1" >/dev/null || fail "replay det1 nonzero"
"$RUN" replay "$TMP/adopt.runs.json" --out "$TMP/det2" >/dev/null || fail "replay det2 nonzero"
diff "$TMP/det1/verdict.json" "$TMP/det2/verdict.json" >/dev/null || fail "replay is not deterministic"
pass "replay is byte-deterministic"

# --- record is gated out of CI ----------------------------------------------
"$RUN" record >/dev/null 2>&1 && fail "record must refuse without --live"
pass "record refuses to run the live path without --live"

printf 'PASS fm-think-bench\n'
