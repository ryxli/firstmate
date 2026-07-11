#!/usr/bin/env bash
# Thin wrapper for the thinking-efficiency bench: a BASELINE-vs-NEW A/B that
# proves a thinking-discipline change cuts reasoning-token cost and latency
# without regressing output quality, under an adopt-iff rule.
#
# All real logic lives in benchmarks/thinking/run.ts (deterministic pure core +
# flag-gated live path). See benchmarks/thinking/README.md.
#
#   sbin/fm-think-bench.sh check-corpus
#   sbin/fm-think-bench.sh grade <oracle.json> <output-file>
#   sbin/fm-think-bench.sh replay <runs.json> --out DIR
#   sbin/fm-think-bench.sh record --live      # live; costs tokens
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/../benchmarks/thinking/run.ts" "$@"
