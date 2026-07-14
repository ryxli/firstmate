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

OPEN=1

OUT="$FM_ROOT/.lavish/fleet.html"
INPUT=""
HOME_OVERRIDE=""
SNAPSHOT="$SCRIPT_DIR/fm-fleet-snapshot.ts"
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

# need_value <flag> <value>: require a value-flag argument. Under set -u a
# missing "$2" would otherwise abort with an unbound-variable error, so callers
# pass "${2:-}" and this exits cleanly with usage when the value is absent.
need_value() {
  [ -n "$2" ] && [ "${2#-}" = "$2" ] || {
    printf 'fm-fleet-view: %s requires a value\n' "$1" >&2
    usage >&2
    exit 2
  }
}

while [ $# -gt 0 ]; do
  case "$1" in
    --output|-o) need_value "$1" "${2:-}"; OUT="$2"; shift 2 ;;
    --input|-i)  need_value "$1" "${2:-}"; INPUT="$2"; shift 2 ;;
    --home)      need_value "$1" "${2:-}"; HOME_OVERRIDE="$2"; shift 2 ;;
    --no-open)   OPEN=0; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) printf 'fm-fleet-view: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

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
  [ -f "$SNAPSHOT" ] || { printf 'fm-fleet-view: collector missing: %s\n' "$SNAPSHOT" >&2; exit 1; }
  set -- "$SNAPSHOT"
  [ -n "$HOME_OVERRIDE" ] && set -- "$@" --home "$HOME_OVERRIDE"
  if ! bun "$@" >"$JSON" 2>"$WORK/err"; then
    printf 'fm-fleet-view: FleetSnapshot collector failed:\n' >&2
    cat "$WORK/err" >&2
    exit 1
  fi
fi

GENERATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$(dirname "$OUT")"

# Embed the JSON into the template as an XSS-safe data island. python3 is a hard
# dependency of the shared FleetSnapshot visual renderer, so it is always available
# here. Embedding in Python avoids every sed/awk quoting trap for arbitrary paths.
python3 - "$TEMPLATE" "$JSON" "$OUT" "$GENERATED" "$SOURCE" <<'PY'
import sys, json

tpl_path, json_path, out_path, generated, source = sys.argv[1:6]

with open(json_path) as fh:
    fleet = json.load(fh)  # also validates the lineage JSON

payload = {"generated": generated, "source": source, "fleet": fleet}
text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
# Make the JSON safe to inline inside <script type="application/json">: neutralize
# any </script>, <!--, and line/paragraph separators. JSON.parse decodes these.
text = (text.replace("&", "\\u0026")
            .replace("<", "\\u003c")
            .replace(">", "\\u003e")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))

with open(tpl_path) as fh:
    tpl = fh.read()

marker = "__FLEET_PAYLOAD__"
if marker not in tpl:
    sys.stderr.write("fm-fleet-view: template missing %s marker\n" % marker)
    sys.exit(1)

with open(out_path, "w") as fh:
    fh.write(tpl.replace(marker, text))
PY

printf 'fm-fleet-view: wrote %s\n' "$OUT" >&2

if [ "$OPEN" -eq 1 ]; then
  exec bunx lavish-axi "$OUT"
fi
