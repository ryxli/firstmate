#!/usr/bin/env bash
# Thin wrapper for action-bench: a live agentic-coding A/B that isolates the effect
# of the HARNESS (control vs the firstmate discipline scaffold) across a difficulty
# ladder, on three axes - correctness incl. procedural, cost-of-pass efficiency, and
# capability - with deterministic integrity gates that abort an unfair run.
#
# All real logic lives in benchmarks/action-bench/bench.ts (deterministic gates +
# replay core, flag-gated live path). See benchmarks/action-bench/README.md.
#
#   bin/fm-action-bench.sh gates                       # integrity gates only (pure; no tokens)
#   bin/fm-action-bench.sh replay <runs.json>          # re-aggregate a recording (pure)
#   bin/fm-action-bench.sh run --live [flags]          # live A/B; costs tokens
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/../benchmarks/action-bench/bench.ts" "$@"
