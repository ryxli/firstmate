#!/usr/bin/env bash
# Run the FULL action-bench across all models at milestone cadence and append one macro datapoint
# to the progress ledger (results/milestones.{jsonl,md}). Not for continuous use - run once per
# milestone to track, at a macro level, how the harness-vs-control effect evolves over time.
#
# Usage: ./milestone.sh <label> [<sha>] [<trials>]
#   label  - milestone name (e.g. "pre-rebase", "post-rebase-v1")
#   sha    - the firstmate SHA under test (label only; default "baseline")
#   trials - trials per scenario/arm/model (default 3)
#
# Test/override knobs (unset = real milestone behavior, unchanged):
#   FM_MILESTONE_MODELS  comma-separated model:thinking specs (default the tri-model set below)
#   FM_MILESTONE_OMP     omp binary to drive (default "omp"); point at a deterministic stub to
#                        smoke-test the whole pipeline with no network/tokens
#   FM_MILESTONE_ONLY    comma-separated scenario ids to restrict the corpus to (default: all).
#                        Must include at least one real-history scenario id, or the
#                        real-history-safe integrity gate fails by design (see gates.ts).
#   FM_MILESTONE_OUT     results dir to write into (default: ./results, this dir's real ledger)
set -euo pipefail
cd "$(dirname "$0")"

LABEL="${1:?usage: ./milestone.sh <label> [sha] [trials]}"
SHA="${2:-baseline}"
TRIALS="${3:-3}"

OMP_BIN="${FM_MILESTONE_OMP:-omp}"
OUT_DIR="${FM_MILESTONE_OUT:-$(pwd)/results}"
ONLY_FLAG=()
if [ -n "${FM_MILESTONE_ONLY:-}" ]; then
  ONLY_FLAG=(--only "$FM_MILESTONE_ONLY")
fi

echo "== integrity gates (abort on any failure) =="
bun bench.ts gates "${ONLY_FLAG[@]}"   # exits 2 if any gate fails -> milestone aborts before spending tokens

IFS=',' read -r -a MODELS <<< "${FM_MILESTONE_MODELS:-gpt-5.4-mini:low,claude-sonnet-4-5:off,claude-haiku-4-5:off}"
runs=()
for spec in "${MODELS[@]}"; do
  model="${spec%%:*}"; think="${spec##*:}"
  echo "== run: $model (thinking=$think), trials=$TRIALS =="
  out="$(bun bench.ts run --live --trials "$TRIALS" --model "$model" --thinking "$think" --jobs 2 --sha "$SHA" --omp "$OMP_BIN" --out "$OUT_DIR" "${ONLY_FLAG[@]}")"
  printf '%s\n' "$out" | tail -n 2
  path="$(printf '%s\n' "$out" | sed -n 's/^wrote \(.*\.runs\.json\).*/\1/p' | tail -n1)"
  [ -n "$path" ] || { echo "ERROR: could not capture runs.json for $model" >&2; exit 1; }
  runs+=("$path")
done

echo "== ledger + cross-model artifacts =="
bun milestone-ledger.ts --out "$OUT_DIR" "$LABEL" "$SHA" "${runs[@]}"
bun compare.ts --out "$OUT_DIR" "${runs[@]}" >/dev/null
bun charts.ts "${runs[@]}" --out "$OUT_DIR/charts.json" >/dev/null
echo "milestone '$LABEL' complete: ledger + cross-model-comparison.md + charts.json refreshed."
