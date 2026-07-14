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
SNAPSHOT="$SCRIPT_DIR/fm-fleet-snapshot.ts"
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

need_value() {
  [ -n "$2" ] || { printf 'fm-kpi-view: %s requires a value\n' "$1" >&2; usage >&2; exit 2; }
}

while [ $# -gt 0 ]; do
  case "$1" in
    --output|-o) need_value "$1" "${2:-}"; OUT="$2"; shift 2 ;;
    --input|-i)  need_value "$1" "${2:-}"; INPUT="$2"; shift 2 ;;
    --home)      need_value "$1" "${2:-}"; HOME_OVERRIDE="$2"; shift 2 ;;
    --no-open)   OPEN=0; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) printf 'fm-kpi-view: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -f "$TEMPLATE" ] || { printf 'fm-kpi-view: template missing: %s\n' "$TEMPLATE" >&2; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fm-kpi.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
JSON="$WORK/kpi.json"

if [ -n "$INPUT" ]; then
  [ -f "$INPUT" ] || { printf 'fm-kpi-view: input not found: %s\n' "$INPUT" >&2; exit 1; }
  cp "$INPUT" "$JSON"
else
  [ -f "$SNAPSHOT" ] || { printf 'fm-kpi-view: collector missing: %s\n' "$SNAPSHOT" >&2; exit 1; }
  set -- "$SNAPSHOT" --metrics
  [ -n "$HOME_OVERRIDE" ] && set -- "$@" --home "$HOME_OVERRIDE"
  if ! bun "$@" >"$WORK/snapshot.json" 2>"$WORK/err"; then
    printf 'fm-kpi-view: FleetSnapshot collector failed:\n' >&2
    cat "$WORK/err" >&2
    exit 1
  fi
  python3 - "$WORK/snapshot.json" "$JSON" <<'PY'
import json, sys
with open(sys.argv[1]) as fh:
    snapshot = json.load(fh)
metrics = snapshot.get("metrics")
if not isinstance(metrics, dict):
    raise SystemExit("fm-kpi-view: collector returned no metrics")
with open(sys.argv[2], "w") as fh:
    json.dump(metrics, fh)
PY
fi

mkdir -p "$(dirname "$OUT")"
python3 - "$TEMPLATE" "$JSON" "$OUT" <<'PY'
import json, sys

tpl_path, json_path, out_path = sys.argv[1:4]
with open(json_path) as fh:
    data = json.load(fh)
if isinstance(data, dict) and isinstance(data.get("metrics"), dict):
    data = data["metrics"]
if not isinstance(data, dict) or data.get("schema") != "fm-kpi/1":
    raise SystemExit("fm-kpi-view: input is not fm-kpi/1 metrics JSON")
text = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
text = (text.replace("&", "\\u0026").replace("<", "\\u003c")
            .replace(">", "\\u003e").replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))
with open(tpl_path) as fh:
    tpl = fh.read()
marker = "__FM_DATA__"
if marker not in tpl:
    raise SystemExit("fm-kpi-view: template missing %s marker" % marker)
with open(out_path, "w") as fh:
    fh.write(tpl.replace(marker, text))
PY

printf 'fm-kpi-view: wrote %s\n' "$OUT" >&2
if [ "$OPEN" -eq 1 ]; then
  exec bunx lavish-axi "$OUT"
fi
