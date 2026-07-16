#!/usr/bin/env bash
# fm-fleet-view.sh - read-only visual fleet dashboard for the firstmate crew.
#
# Runs the shared typed FleetSnapshot collector and embeds its topology-rich
# snapshot into a self-contained HTML artifact (default .lavish/fleet.html).
#
# This tool is strictly READ-ONLY. It never mutates herdr, omp, git, data, or
# state. The only data it reads comes from the shared collector or a JSON file
# passed with --input. Its only write is the HTML artifact.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# shellcheck source=sbin/fm-view-lib.sh
. "$SCRIPT_DIR/fm-view-lib.sh"

PROG="fm-fleet-view"
OPEN=1
OUT="$FM_ROOT/.lavish/fleet.html"
INPUT=""
HOME_OVERRIDE=""
FM_AXI="$SCRIPT_DIR/fm-axi"
TEMPLATE="$SCRIPT_DIR/fm-fleet-view.template.html"

usage() {
  cat <<'EOF'
usage: fm-fleet-view.sh [--output <path>] [--input <json>] [--home <path>] [--no-open]
  Read-only visual dashboard rendered from the shared FleetSnapshot collector.

  --output <path>  HTML artifact path (default: <repo>/.lavish/fleet.html).
  --input <json>   Render this FleetSnapshot JSON instead of collecting live data.
                   (offline diagnostics, fixtures, tests). Still read-only.
  --home <path>    Collect a specific firstmate home.
  --no-open        Generate the artifact but do not launch lavish.
  -h, --help       Show this help.
EOF
}

fm_view_parse_args "$@"

[ -f "$TEMPLATE" ] || { printf 'fm-fleet-view: template missing: %s\n' "$TEMPLATE" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fm-fleet.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
JSON="$WORK/fleet.json"

SOURCE="live"
if [ -n "$INPUT" ]; then
  [ -f "$INPUT" ] || { printf 'fm-fleet-view: input not found: %s\n' "$INPUT" >&2; exit 1; }
  cp "$INPUT" "$JSON"
  SOURCE="file:$INPUT"
else
  [ -f "$FM_AXI" ] || { printf 'fm-fleet-view: collector missing: %s\n' "$FM_AXI" >&2; exit 1; }
  fm_view_collect "$JSON"
fi

GENERATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$(dirname "$OUT")"

# Wrap the raw FleetSnapshot in the dashboard payload (json.load also validates
# the lineage JSON), then embed it as an XSS-safe data island via the shared
# helper. python3 is a hard dependency of the shared FleetSnapshot visual
# renderer, so it is always available here.
PAYLOAD="$WORK/payload.json"
python3 - "$JSON" "$PAYLOAD" "$GENERATED" "$SOURCE" <<'PY'
import sys, json

snap_path, out_path, generated, source = sys.argv[1:5]
with open(snap_path) as fh:
    fleet = json.load(fh)  # also validates the lineage JSON
payload = {"generated": generated, "source": source, "fleet": fleet}
with open(out_path, "w") as fh:
    json.dump(payload, fh, separators=(",", ":"), ensure_ascii=False)
PY

fm_view_embed "$TEMPLATE" "$PAYLOAD" "$OUT" __FLEET_PAYLOAD__

printf 'fm-fleet-view: wrote %s\n' "$OUT" >&2

if [ "$OPEN" -eq 1 ]; then
  exec bunx lavish-axi "$OUT"
fi
