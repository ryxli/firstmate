#!/usr/bin/env bash
# Thin wrapper for the deterministic-substrate eval runner: given one or more
# target commits, runs the eval gates (supervision bench, behavior suite,
# lint, repo invariants, thinking-efficiency) in isolated checkouts and
# emits a JSON+md artifact per candidate, deltaed against a baseline.
#
# All real logic lives in benchmarks/eval-runner/fm-eval-run.py. See its
# module docstring for the full gate list and flags.
#
#   sbin/fm-eval-run.sh --help                 # usage
#   sbin/fm-eval-run.sh [TARGET ...] [options]  # run one or more candidates
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/../benchmarks/eval-runner/fm-eval-run.py" "$@"
