#!/usr/bin/env bash
# Hermetic tests for fm-kpi.sh: folder-role classification, productive-vs-excluded
# aggregation, supervisor overhead, backlog outcome counts, the JSON contract,
# the workspace tag, snapshot append, and history read. Uses a canned omp-stats
# JSON via --stats-file and a temp FM_HOME, so no real omp/herdr is touched.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KPI="$ROOT/sbin/fm-kpi.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

HOME_DIR="$TMP/home"
SM_HOME="$TMP/fm-sm-foo"
mkdir -p "$HOME_DIR/data" "$HOME_DIR/config" "$HOME_DIR/state"

printf 'testbox\n' > "$HOME_DIR/config/workspace"
printf -- '- foo - eval (home: %s; scope: x; projects: (none); added 2026-01-01)\n' "$SM_HOME" \
  > "$HOME_DIR/data/secondmates.md"
cat > "$HOME_DIR/data/backlog.md" <<'EOF'
## In flight
- [ ] task-a - doing (repo: x, since 2026-01-01)
## Queued
- [ ] task-b - later (repo: x)
- [ ] task-c - later (repo: x)
- [ ] task-d - later (repo: x)
## Done
- [x] task-e - done - url (merged 2026-01-01)
- [x] task-f - done - url (merged 2026-01-01)
EOF

# Build a canned omp-stats JSON whose folder names match fm-kpi's own transform
# (strip $HOME prefix, replace / with -) for supervisor/secondmate/crew, plus an
# ephemeral fm-bench folder and an unrelated "other" folder that must be excluded.
python3 - "$HOME_DIR" "$SM_HOME" "$TMP/stats.json" <<'PY'
import sys, os, json
home = os.environ["HOME"]
fm_home, sm_home, out = sys.argv[1], sys.argv[2], sys.argv[3]
def fo(p):
    if home and p.startswith(home): p = p[len(home):]
    return p.replace("/", "-")
folders = [
    (fo(fm_home), 100.0),                 # supervisor
    (fo(sm_home), 20.0),                   # secondmate
    (fo(fm_home + "/worktrees/task1"), 50.0),  # crew
    ("-tmp-fm-bench.zzz-home-worktrees-c1", 99.0),  # ephemeral (excluded)
    ("-private-tmp", 77.0),               # other (excluded)
]
bf = [{"folder": f, "totalCost": c, "totalInputTokens": 10, "totalOutputTokens": 20,
       "totalCacheReadTokens": 900, "totalCacheWriteTokens": 90, "cacheRate": 0.9,
       "errorRate": 0.0, "totalRequests": 5, "successfulRequests": 5, "failedRequests": 0}
      for f, c in folders]
json.dump({"overall": {}, "byFolder": bf, "byAgentType": [
    {"agentType": "main", "totalCost": 120.0, "totalInputTokens": 5, "totalOutputTokens": 10},
    {"agentType": "subagent", "totalCost": 50.0, "totalInputTokens": 5, "totalOutputTokens": 10}]},
    open(out, "w"))
PY

FAILED=0
fail() { printf 'not ok - %s\n' "$1"; FAILED=1; }
pass() { printf 'ok - %s\n' "$1"; }

# --- JSON contract + classification + outcomes ---
out="$("$KPI" --json --home "$HOME_DIR" --stats-file "$TMP/stats.json")"
if printf '%s' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d["schema"] == "fm-kpi/1", d["schema"]
assert d["workspace"] == "testbox", d["workspace"]
br = d["by_role"]
assert br["supervisor"] == 100.0, br
assert br["secondmate"] == 20.0, br
assert br["crew"] == 50.0, br
assert br["ephemeral"] == 99.0, br
assert br["other"] == 77.0, br
assert d["cost_usd_productive"] == 170.0, d["cost_usd_productive"]
assert abs(d["supervisor_overhead_cost"] - 100.0/170.0) < 1e-3, d["supervisor_overhead_cost"]
assert d["tasks_landed"] == 2 and d["tasks_in_flight"] == 1 and d["tasks_queued"] == 3, d
assert abs(d["cost_per_landed_usd"] - 85.0) < 1e-6, d["cost_per_landed_usd"]
roles = sorted(set(f["role"] for f in d["by_folder"]))
assert roles == ["crew", "ephemeral", "other", "secondmate", "supervisor"], roles
'; then pass "json contract: classification, productive aggregation, overhead, outcomes"
else fail "json contract assertions"; fi

# --- ephemeral/other excluded from productive ---
if printf '%s' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
# productive = supervisor+secondmate+crew = 170; ephemeral(99)+other(77) excluded
assert d["cost_usd_productive"] == 170.0, d["cost_usd_productive"]
'; then pass "ephemeral and other folders excluded from productive cost"
else fail "exclusion of ephemeral/other"; fi

# --- workspace falls back to hostname when no config/workspace ---
rm -f "$HOME_DIR/config/workspace"
ws="$("$KPI" --json --home "$HOME_DIR" --stats-file "$TMP/stats.json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["workspace"])')"
if [ -n "$ws" ] && [ "$ws" != "testbox" ]; then pass "workspace falls back to hostname ($ws)"; else fail "workspace fallback (got '$ws')"; fi
printf 'testbox\n' > "$HOME_DIR/config/workspace"

# --- snapshot appends one valid JSONL record ---
"$KPI" --snapshot --home "$HOME_DIR" --stats-file "$TMP/stats.json" >/dev/null
hist="$HOME_DIR/data/kpi-history.jsonl"
if [ -f "$hist" ] && [ "$(wc -l < "$hist" | tr -d ' ')" = "1" ] && \
   python3 -c 'import json,sys; r=json.loads(open(sys.argv[1]).readline()); assert r["workspace"]=="testbox"; assert r["tasks_landed"]==2' "$hist" 2>/dev/null
then pass "snapshot appends one workspace-tagged JSONL record"
else fail "snapshot append"; fi

# --- second snapshot grows the log; history reads it ---
"$KPI" --snapshot --home "$HOME_DIR" --stats-file "$TMP/stats.json" >/dev/null
if [ "$(wc -l < "$hist" | tr -d ' ')" = "2" ]; then pass "second snapshot grows the trend log"; else fail "snapshot grow"; fi
histout="$("$KPI" --history --home "$HOME_DIR")"
if printf '%s' "$histout" | grep -q testbox; then pass "history summarizes the trend log"; else fail "history read"; fi

# --- terminal surface renders headline lines ---
txt="$("$KPI" --home "$HOME_DIR" --stats-file "$TMP/stats.json")"
if printf '%s' "$txt" | grep -q "firstmate KPIs" \
  && printf '%s' "$txt" | grep -q "supervisor overhead" \
  && printf '%s' "$txt" | grep -q "GAPS"; then pass "terminal surface renders headline + gaps"
else fail "terminal surface"; fi

if [ "$FAILED" = 0 ]; then printf 'PASS fm-kpi\n'; exit 0; else printf 'FAIL fm-kpi\n'; exit 1; fi
