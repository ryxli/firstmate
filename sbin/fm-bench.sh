#!/usr/bin/env bash
# Deterministic OLD-vs-NEW supervision replay.  It imports the production
# fm-supervisor.ts pure export and writes no result artifacts.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/../benchmarks/run.ts" "$@"
