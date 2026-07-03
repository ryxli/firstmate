#!/usr/bin/env bash
# Run the FULL action-bench across all models at milestone cadence and append one macro datapoint
# to the progress ledger (results/milestones.{jsonl,md}). Not for continuous use - run once per
# milestone to track, at a macro level, how the harness-vs-control effect evolves over time.
#
# Usage: ./milestone.sh <label> [<sha>] [<trials>]
#   label  - milestone name (e.g. "pre-rebase", "post-rebase-v1")
#   sha    - the firstmate SHA under test (label only; default "baseline")
#   trials - trials per scenario/arm/model (default 3)
set -euo pipefail
cd "$(dirname "$0")"

LABEL="${1:?usage: ./milestone.sh <label> [sha] [trials]}"
SHA="${2:-baseline}"
TRIALS="${3:-3}"

echo "== integrity gates (abort on any failure) =="
bun bench.ts gates   # exits 2 if any gate fails -> milestone aborts before spending tokens

MODELS=("gpt-5.4-mini:low" "claude-sonnet-4-5:off" "claude-haiku-4-5:off")
runs=()
for spec in "${MODELS[@]}"; do
  model="${spec%%:*}"; think="${spec##*:}"
  echo "== run: $model (thinking=$think), trials=$TRIALS =="
  out="$(bun bench.ts run --live --trials "$TRIALS" --model "$model" --thinking "$think" --jobs 2 --sha "$SHA")"
  printf '%s\n' "$out" | tail -n 2
  path="$(printf '%s\n' "$out" | sed -n 's/^wrote \(.*\.runs\.json\).*/\1/p' | tail -n1)"
  [ -n "$path" ] || { echo "ERROR: could not capture runs.json for $model" >&2; exit 1; }
  runs+=("$path")
done

echo "== ledger + cross-model artifacts =="
bun milestone-ledger.ts "$LABEL" "$SHA" "${runs[@]}"
bun compare.ts "${runs[@]}" >/dev/null
bun charts.ts "${runs[@]}" >/dev/null
echo "milestone '$LABEL' complete: ledger + cross-model-comparison.md + charts.json refreshed."
