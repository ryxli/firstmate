#!/usr/bin/env bash
# Thin wrapper for the passive crew-metrics harvester: zero-cost, runs no
# agents, and only reads harness side-effect signals (omp stats byFolder,
# state/*.meta, state/*.status, state/.status-internal.log, data/backlog.md).
#
# All real logic lives in benchmarks/eval-runner/crew-metrics.py. See its
# module docstring for the full metric set and honest caveats.
#
#   sbin/fm-crew-metrics.sh --help    # usage
#   sbin/fm-crew-metrics.sh [options] # render the metrics report
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/../benchmarks/eval-runner/crew-metrics.py" "$@"
