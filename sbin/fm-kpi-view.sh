#!/usr/bin/env bash
# fm-kpi-view.sh - read-only visual KPI dashboard for the firstmate workflow.
#
# Runs `sbin/fm-kpi.sh --json`, embeds the canonical KPI object (schema
# "fm-kpi/1") into a self-contained HTML artifact (default .lavish/kpi.html),
# and opens it for review with `bunx lavish-axi`. The HTML renders the KPI
# object client side: a workspace header, headline efficiency stat cards,
# an outcomes strip with the cost/tokens-per-landed North Star, a cost-by-role
# breakdown that separates productive crew from excluded test scaffolds, a
# per-folder table, a main-vs-subagent split, and a gaps panel that names the
# metrics we do not instrument yet.
#
# This tool is strictly READ-ONLY. It never mutates herdr, omp, git, data, or
# state. The only data it reads comes from fm-kpi.sh (itself read-only) or a
# JSON file you pass with --input. Its only write is the HTML artifact.
#
# bash 3.2 safe (no associative arrays, mapfile, or ${x^^}).
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"

KPI="$SCRIPT_DIR/fm-kpi.sh"
TEMPLATE="$SCRIPT_DIR/fm-kpi-view.template.html"

OUT="$FM_ROOT/.lavish/kpi.html"
INPUT=""
HOME_OVERRIDE=""
OPEN=1

usage() {
  cat <<'EOF'
usage: fm-kpi-view.sh [--output <path>] [--input <json>] [--home <path>]
                      [--no-open]
  Read-only visual KPI dashboard. Renders fm-kpi.sh --json into a
  self-contained HTML artifact and opens it with lavish for review.

  --output <path>  HTML artifact path (default: <repo>/.lavish/kpi.html).
  --input <json>   Render this KPI JSON file instead of running fm-kpi
                   (offline diagnostics, fixtures, tests). Still read-only.
  --home <path>    Pass through to fm-kpi.sh --home.
  --no-open        Generate the artifact but do not launch lavish.
  -h, --help       Show this help.
This tool never mutates herdr, omp, git, data, or state.
EOF
}

# need_value <flag> <value>: require a value-flag argument. Under set -u a
# missing "$2" would otherwise abort with an unbound-variable error, so callers
# pass "${2:-}" and this exits cleanly with usage when the value is absent.
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
  [ -f "$KPI" ] || { printf 'fm-kpi-view: kpi tool missing: %s\n' "$KPI" >&2; exit 1; }
  set -- --json
  [ -n "$HOME_OVERRIDE" ] && set -- "$@" --home "$HOME_OVERRIDE"
  if ! bash "$KPI" "$@" >"$JSON" 2>"$WORK/err"; then
    printf 'fm-kpi-view: fm-kpi.sh failed:\n' >&2
    cat "$WORK/err" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$OUT")"

# Embed the JSON into the template as an XSS-safe data island. python3 is a hard
# dependency of fm-kpi.sh --json, so it is always available here. Embedding in
# Python avoids every sed/awk quoting trap for arbitrary folder labels. The KPI
# object already carries workspace/generated/source/window, so it is injected as
# is, with no shell-side wrapper.
python3 - "$TEMPLATE" "$JSON" "$OUT" <<'PY'
import sys, json

tpl_path, json_path, out_path = sys.argv[1:4]

with open(json_path) as fh:
    kpi = json.load(fh)  # also validates the KPI JSON

text = json.dumps(kpi, separators=(",", ":"), ensure_ascii=False)
# Make the JSON safe to inline inside <script type="application/json">: neutralize
# any </script>, <!--, and line/paragraph separators. JSON.parse decodes these.
text = (text.replace("&", "\\u0026")
            .replace("<", "\\u003c")
            .replace(">", "\\u003e")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))

with open(tpl_path) as fh:
    tpl = fh.read()

marker = "__FM_DATA__"
if marker not in tpl:
    sys.stderr.write("fm-kpi-view: template missing %s marker\n" % marker)
    sys.exit(1)

with open(out_path, "w") as fh:
    fh.write(tpl.replace(marker, text))
PY

printf 'fm-kpi-view: wrote %s\n' "$OUT" >&2

if [ "$OPEN" -eq 1 ]; then
  exec bunx lavish-axi "$OUT"
fi
