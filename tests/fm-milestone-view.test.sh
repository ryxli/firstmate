#!/usr/bin/env bash
# Verify the milestone-view visual consumer renders the longitudinal ledger,
# degrades gracefully on sparse/malformed/heterogeneous rows, stays fully
# self-contained (no external network resources), and rejects flag values
# the same way the other view verbs do.
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- fixture ledger: legacy tri-model rows (matching the real 2 rows in
# milestones.jsonl) + a synthetic fm-milestone/v1 composition row + one
# malformed line, so degradation, heterogeneity, and error-tolerance are all
# exercised in one fixture. ----
cat > "$TMP/ledger.jsonl" <<'JSONL'
{"captured": "2026-07-02T19:21:26.326721+00:00", "milestone": "pre-rebase-baseline", "sha": "50ade91", "corpus_scenarios": 19, "trials": 5, "note": "baseline", "models": [{"model": "gpt-5.4-mini", "thinking": "low", "trials": 5, "scenarios": 19, "control": 0.937, "harness": 0.947, "lift": 0.01, "corrupt": 0}, {"model": "claude-sonnet-4-5", "thinking": "off", "trials": 5, "scenarios": 19, "control": 0.968, "harness": 1.0, "lift": 0.032, "corrupt": 0}]}
not valid json at all
{"captured": "2026-07-05T00:48:42.463937+00:00", "milestone": "post-reconciliation", "sha": "2a59d55", "corpus_scenarios": 28, "trials": 3, "note": "gpt arm dropped", "models": [{"model": "claude-sonnet-4-5", "thinking": "off", "trials": 3, "scenarios": 28, "control": 0.988, "harness": 1.0, "lift": 0.012, "corrupt": 0}]}
{"schema": "fm-milestone/v1", "captured": "2026-07-10T12:00:00.000000+00:00", "milestone": "composition-smoke", "sha": "abc1234", "corpus_scenarios": 28, "trials": null, "note": "", "models": [], "gates": {"action_bench": {"ok": true, "scenarios": 28, "secs": 12.3}, "corpus": {"ok": true, "total": 28, "synthetic": 20, "real_history": 8, "by_source_class": {}, "by_difficulty": {}, "sanitize_status": "clean", "secs": 1.1}, "supervision": {"ok": true, "verdict": "PASS", "tokenizer": "chars/4", "totals": {"old_tokens": 5000, "new_tokens": 2400, "old_false": 2, "new_false": 0, "old_missed": 1, "new_missed": 0}, "reduction_pct": 52.0, "secs": 2.0}, "tests": {"ok": true, "files": 40, "passed": 40, "failed": 0, "failures": [], "assertions": 900, "secs": 30.0}, "repo_invariants": {"ok": true, "claude_md": "AGENTS.md", "claude_skills": "../.agents/skills", "tracked_private": "none", "secs": 0.2}}, "context_weight": {"ok": true, "total_tokens": 8211, "tokenizer": "chars/4", "table_hash": "deadbeef00000000"}, "elapsed_s": 45.6}
{"schema": "fm-milestone/v1", "captured": "2026-07-12T12:00:00.000000+00:00", "milestone": "composition-smoke-2", "sha": "def5678", "corpus_scenarios": 28, "trials": null, "note": "", "models": [], "gates": {"action_bench": {"ok": false, "scenarios": 28, "secs": 12.3}, "corpus": {"ok": true, "total": 28, "synthetic": 20, "real_history": 8, "by_source_class": {}, "by_difficulty": {}, "sanitize_status": "clean", "secs": 1.1}, "supervision": {"ok": true, "verdict": "PASS", "tokenizer": "chars/4", "totals": {"old_tokens": 5000, "new_tokens": 2100, "old_false": 0, "new_false": 0, "old_missed": 0, "new_missed": 0}, "reduction_pct": 58.0, "secs": 2.0}, "tests": {"ok": false, "files": 40, "passed": 39, "failed": 1, "failures": ["fm-x.test.sh"], "assertions": 905, "secs": 30.0}, "repo_invariants": {"ok": true, "claude_md": "AGENTS.md", "claude_skills": "../.agents/skills", "tracked_private": "none", "secs": 0.2}}, "context_weight": {"ok": true, "total_tokens": 7900, "tokenizer": "chars/4", "table_hash": "deadbeef00000001"}, "elapsed_s": 40.1}
JSONL

# ---- flag validation: a following flag must not be swallowed as a value ----
if bun "$ROOT/sbin/fm" milestone-view --output --no-open >/dev/null 2>&1; then
  echo "milestone-view accepted a following flag as --output value" >&2
  exit 1
elif [ "$?" -ne 2 ]; then
  echo "milestone-view returned the wrong missing-value status" >&2
  exit 1
fi

# ---- render the fixture, git-weight backfill disabled for a hermetic run ----
bun "$ROOT/sbin/fm" milestone-view --input "$TMP/ledger.jsonl" --no-open --no-git-weight --output "$TMP/milestone.html" 2>"$TMP/stderr.log"
grep -q "wrote $TMP/milestone.html" "$TMP/stderr.log"

python3 - "$TMP/milestone.html" "$TMP/ledger.jsonl" <<'PY'
import json
import re
import sys

path, ledger_path = sys.argv[1:]
html = open(path).read()

assert html.startswith("<!DOCTYPE html"), "not a valid HTML document"
assert "__MILESTONE_PAYLOAD__" not in html, "template marker was not substituted"

# self-contained: no external network resources are LOADED by the page (a plain
# <a> link-out to the local omp stats dashboard is navigation, not a resource
# fetch, and is intentionally present in the header).
assert not re.search(r'<link\b[^>]*href="https?://', html), "artifact loads an external stylesheet"
assert not re.search(r'<script\b[^>]*src="https?://', html), "artifact loads an external script"
assert not re.search(r'<img\b[^>]*src="https?://', html), "artifact loads an external image"
assert "cdn." not in html, "artifact references a CDN"
for href in re.findall(r'<a\b[^>]*href="(https?://[^"]*)"', html):
    assert href.startswith("http://localhost"), f"unexpected external link-out: {href}"

m = re.search(r'<script type="application/json" id="mv-payload">(.*?)</script>', html, re.S)
assert m, "missing embedded payload script"
payload = json.loads(m.group(1))

assert payload["ledgerPath"] == ledger_path
rows = payload["rows"]
assert len(rows) == 4, f"expected 4 parsed rows (1 malformed line skipped), got {len(rows)}"
assert len(payload["rowErrors"]) == 1, "expected exactly one malformed-line error recorded"
assert payload["rowErrors"][0]["line"] == 2, "malformed line number should be reported"

assert payload["gitWeight"]["available"] is False
assert "no-git-weight" in payload["gitWeight"]["reason"]

# heterogeneous rows preserved verbatim: legacy rows carry no "schema" key,
# the synthetic composition rows do.
schemas = [r.get("schema") for r in rows]
assert schemas.count("fm-milestone/v1") == 2
assert schemas.count(None) == 2

# the raw ledger row content (a value that only appears in the fixture) must
# actually be embedded, not just structurally present.
assert "post-reconciliation" in html
assert "composition-smoke" in html
print("ok - fixture ledger parsed, heterogeneous rows preserved, self-contained")
PY

# ---- degrade gracefully on a single-row (or empty) ledger ----
printf '%s\n' '{"captured": "2026-07-15T00:00:00.000000+00:00", "milestone": "solo", "sha": "abc0000", "corpus_scenarios": 5, "trials": 1, "note": "", "models": []}' > "$TMP/one-row.jsonl"
bun "$ROOT/sbin/fm" milestone-view --input "$TMP/one-row.jsonl" --no-open --no-git-weight --output "$TMP/one-row.html" >/dev/null
python3 -c "
html = open('$TMP/one-row.html').read()
assert html.startswith('<!DOCTYPE html')
assert 'solo' in html
"

: > "$TMP/empty.jsonl"
bun "$ROOT/sbin/fm" milestone-view --input "$TMP/empty.jsonl" --no-open --no-git-weight --output "$TMP/empty.html" >/dev/null
python3 -c "
html = open('$TMP/empty.html').read()
assert html.startswith('<!DOCTYPE html')
"

printf '%s\n' 'ok - milestone view degrades gracefully on sparse, malformed, and empty ledgers and stays self-contained'
