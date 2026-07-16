#!/usr/bin/env bash
# fm-view-lib.sh - shared helpers for the read-only visual dashboards
# (fm-fleet-view.sh, fm-kpi-view.sh). Sourced, never executed directly.
#
# Front-ends set the following globals before calling these helpers:
#   PROG           diagnostic prefix for messages (e.g. fm-fleet-view)
#   OUT            HTML artifact path
#   INPUT          optional JSON input file (offline/fixtures); empty for live
#   HOME_OVERRIDE  optional firstmate home path
#   OPEN           1 to launch lavish after generating, 0 to stop
#   FM_AXI         path to the fm-axi entrypoint (JSON snapshot source)
#   WORK           scratch directory (holds collector stderr)
# and define a usage() function (referenced by the argument parser).

# fm_view_need_value <flag> <value>: require a value-flag argument. Under set -u
# a missing "$2" would otherwise abort with an unbound-variable error, so callers
# pass "${2:-}" and this exits cleanly with usage when the value is absent.
fm_view_need_value() {
  [ -n "$2" ] && [ "${2#-}" = "$2" ] || {
    printf '%s: %s requires a value\n' "$PROG" "$1" >&2
    usage >&2
    exit 2
  }
}

# fm_view_parse_args "$@": shared option loop. Sets OUT/INPUT/HOME_OVERRIDE/OPEN.
fm_view_parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --output|-o) fm_view_need_value "$1" "${2:-}"; OUT="$2"; shift 2 ;;
      --input|-i)  fm_view_need_value "$1" "${2:-}"; INPUT="$2"; shift 2 ;;
      --home)      fm_view_need_value "$1" "${2:-}"; HOME_OVERRIDE="$2"; shift 2 ;;
      --no-open)   OPEN=0; shift ;;
      -h|--help)   usage; exit 0 ;;
      *) printf '%s: unknown argument: %s\n' "$PROG" "$1" >&2; usage >&2; exit 2 ;;
    esac
  done
}

# fm_view_collect <dest-json> [extra fm-axi snapshot args...]: run the shared
# FleetSnapshot collector via `fm-axi fleet snapshot --json` into <dest-json>,
# appending --home when HOME_OVERRIDE is set. Fail-closed with the collector's
# stderr on error.
fm_view_collect() {
  local dest=$1
  shift
  local -a cmd
  cmd=(bun "$FM_AXI" fleet snapshot --json "$@")
  [ -n "$HOME_OVERRIDE" ] && cmd+=(--home "$HOME_OVERRIDE")
  if ! "${cmd[@]}" >"$dest" 2>"$WORK/err"; then
    printf '%s: FleetSnapshot collector failed:\n' "$PROG" >&2
    cat "$WORK/err" >&2
    exit 1
  fi
}

# fm_view_embed <template> <payload-json> <out> <marker>: embed the payload JSON
# into the template's data island, neutralizing it for inline
# <script type="application/json"> (the XSS-safe block is byte-identical between
# the two front-ends). Fails if the template lacks the marker.
fm_view_embed() {
  python3 - "$1" "$2" "$3" "$4" "$PROG" <<'PY'
import sys, json

tpl_path, json_path, out_path, marker, prog = sys.argv[1:6]

with open(json_path) as fh:
    data = json.load(fh)
text = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
# Make the JSON safe to inline inside <script type="application/json">: neutralize
# any </script>, <!--, and line/paragraph separators. JSON.parse decodes these.
text = (text.replace("&", "\\u0026")
            .replace("<", "\\u003c")
            .replace(">", "\\u003e")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))

with open(tpl_path) as fh:
    tpl = fh.read()

if marker not in tpl:
    sys.stderr.write("%s: template missing %s marker\n" % (prog, marker))
    sys.exit(1)

with open(out_path, "w") as fh:
    fh.write(tpl.replace(marker, text))
PY
}
