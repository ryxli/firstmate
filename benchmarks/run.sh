#!/usr/bin/env bash
# Run the supervision interface-efficiency benchmark (OLD vs NEW) and write the
# evidence table + raw JSON under benchmarks/results/.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/run.ts" "$@"
