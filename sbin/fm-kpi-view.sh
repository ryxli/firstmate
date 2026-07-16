#!/usr/bin/env bash
# fm-kpi-view.sh - read-only visual KPI dashboard for the firstmate workflow.
#
# Runs the shared typed FleetSnapshot collector with metrics enabled, extracts
# its canonical "fm-kpi/1" object, and opens a self-contained HTML artifact.
#
# This tool is strictly READ-ONLY. It never mutates herdr, omp, git, data, or
# state. The only data it reads comes from the shared collector or a JSON file
# passed with --input. Its only write is the HTML artifact.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# shellcheck source=sbin/fm-view-lib.sh
. "$SCRIPT_DIR/fm-view-lib.sh"

PROG="fm-kpi-view"
FM_AXI="$SCRIPT_DIR/fm-axi"
TEMPLATE="$SCRIPT_DIR/fm-kpi-view.template.html"
OUT="$FM_ROOT/.lavish/kpi.html"
INPUT=""
HOME_OVERRIDE=""
OPEN=1

usage() {
  cat <<'EOF'
usage: fm-kpi-view.sh [--output <path>] [--input <json>] [--home <path>]
                      [--no-open]
  Read-only visual KPI dashboard rendered from FleetSnapshot metrics.

  --output <path>  HTML artifact path (default: <repo>/.lavish/kpi.html).
  --input <json>   Render this KPI or FleetSnapshot JSON file instead of collecting live data.
                   (offline diagnostics, fixtures, tests). Still read-only.
  --home <path>    Collect a specific firstmate home.
  --no-open        Generate the artifact but do not launch lavish.
  -h, --help       Show this help.
This tool never mutates herdr, omp, git, data, or state.
EOF
}

fm_view_parse_args "$@"

[ -f "$TEMPLATE" ] || { printf 'fm-kpi-view: template missing: %s\n' "$TEMPLATE" >&2; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fm-kpi.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
JSON="$WORK/kpi.json"

if [ -n "$INPUT" ]; then
  [ -f "$INPUT" ] || { printf 'fm-kpi-view: input not found: %s\n' "$INPUT" >&2; exit 1; }
  cp "$INPUT" "$WORK/raw.json"
else
  [ -f "$FM_AXI" ] || { printf 'fm-kpi-view: collector missing: %s\n' "$FM_AXI" >&2; exit 1; }
  fm_view_collect "$WORK/raw.json" --metrics
fi

# Extract and validate the canonical fm-kpi/1 metrics object, unwrapping a full
# FleetSnapshot when the input carries a nested metrics record.
python3 - "$WORK/raw.json" "$JSON" <<'PY'
import json, sys
with open(sys.argv[1]) as fh:
    data = json.load(fh)
if isinstance(data, dict) and isinstance(data.get("metrics"), dict):
    data = data["metrics"]
if not isinstance(data, dict) or data.get("schema") != "fm-kpi/1":
    raise SystemExit("fm-kpi-view: input is not fm-kpi/1 metrics JSON")
with open(sys.argv[2], "w") as fh:
    json.dump(data, fh)
PY

mkdir -p "$(dirname "$OUT")"
fm_view_embed "$TEMPLATE" "$JSON" "$OUT" __FM_DATA__

printf 'fm-kpi-view: wrote %s\n' "$OUT" >&2
if [ "$OPEN" -eq 1 ]; then
  exec bunx lavish-axi "$OUT"
fi
