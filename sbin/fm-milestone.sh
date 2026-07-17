#!/usr/bin/env bash
# One command, one reproducible longitudinal measurement row: composes the action-bench integrity
# gates + corpus metrics, the supervision replay bench, sbin/fm-context-weight, and the tests/*.test.sh
# behavior suite into a single row appended to benchmarks/results/milestones.{jsonl,md}.
#
# All real logic lives in benchmarks/milestone/run.ts (a thin composition over existing, already-
# proven instruments - see its header and README.md in that directory).
#
#   sbin/fm-milestone.sh <label> [sha] [runs.json ...] [--note text] [--out dir] [--captured iso8601] [--jobs n]
#   sbin/fm-milestone.sh --compare <shaA> <shaB> [label]     # auto-A/B: same gates, two isolated SHAs
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/../benchmarks/milestone/run.ts" "$@"
