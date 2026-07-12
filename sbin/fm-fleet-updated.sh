#!/usr/bin/env bash
# fm-fleet-updated.sh - read-only load-once freshness check for live OMP panes.
#
# Extensions and AGENTS.md are loaded when an OMP session starts. This command
# compares each live agent session file's mtime with the newest commit touching
# those load-once sources. It only reads herdr, git, and the filesystem.
#
# Exit 1 means at least one live agent session predates the newest load-once
# source commit. Unknown data is reported but does not make the command fail.
set -u

usage() {
  printf '%s\n' 'usage: fm-fleet-updated.sh [--json]' >&2
  printf '%s\n' '  Report whether live agent sessions loaded the latest extensions and AGENTS.md.' >&2
  printf '%s\n' '  This command is strictly read-only: it only runs herdr pane list, git, and filesystem reads.' >&2
}

OUTPUT_MODE=text
case "${1:-}" in
  '') ;;
  --json) OUTPUT_MODE=json ;;
  -h|--help) usage; exit 0 ;;
  *)
    printf 'error: unknown argument: %s\n' "$1" >&2
    usage
    exit 2
    ;;
esac
[ "$#" -le 1 ] || {
  printf 'error: expected at most one argument\n' >&2
  usage
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# FM_HOME intentionally does not select the checked source tree. A persistent
# secondmate home may be a symlinked consumer of this shared script; FM_ROOT
# identifies the repository whose load-once sources are being checked.
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"

set -- AGENTS.md
for load_once in "$FM_ROOT"/.omp/extensions/*.ts; do
  [ -f "$load_once" ] || continue
  set -- "$@" "${load_once#"$FM_ROOT"/}"
done

LATEST_EPOCH=
if command -v git >/dev/null 2>&1; then
  LATEST_EPOCH=$(git -C "$FM_ROOT" log -1 --format=%ct -- "$@" 2>/dev/null || true)
fi

HERDR_STATE=unknown
PANES_JSON=
if command -v herdr >/dev/null 2>&1; then
  PANES_JSON=$(herdr pane list 2>/dev/null || true)
  [ -n "$PANES_JSON" ] && HERDR_STATE=ok
fi

# Python handles both herdr's structured response and portable session mtimes.
# Its error paths intentionally emit a valid unknown summary rather than failing
# this read-only diagnostic when herdr, git, or a session file is unavailable.
printf '%s' "$PANES_JSON" | python3 -c '
import datetime
import json
import os
import sys

mode, raw_epoch, herdr_state = sys.argv[1:4]
paths = sys.argv[4:]

def iso(epoch):
    if epoch is None:
        return "unknown"
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).isoformat().replace("+00:00", "Z")

def integer_epoch(value):
    try:
        epoch = int(value)
        return epoch if epoch >= 0 else None
    except (TypeError, ValueError):
        return None

latest_epoch = integer_epoch(raw_epoch)
try:
    payload = json.load(sys.stdin)
    panes = payload.get("result", {}).get("panes", [])
    if not isinstance(panes, list):
        panes = []
        herdr_state = "unknown"
except Exception:
    panes = []
    herdr_state = "unknown"

mates = []
for pane in panes:
    if not isinstance(pane, dict):
        continue
    agent_session = pane.get("agent_session")
    if not isinstance(agent_session, dict) or not agent_session.get("value"):
        continue

    session_path = str(agent_session["value"])
    session_epoch = None
    try:
        session_epoch = os.path.getmtime(session_path)
    except OSError:
        pass

    if session_epoch is None or latest_epoch is None:
        freshness = "unknown"
    elif session_epoch >= latest_epoch:
        freshness = "LATEST"
    else:
        freshness = "STALE"

    mates.append({
        "pane": str(pane.get("pane_id") or "unknown"),
        "name": str(pane.get("display_agent") or pane.get("label") or pane.get("agent") or "unknown"),
        "status": str(pane.get("agent_status") or "unknown"),
        "session": session_path,
        "session_start_epoch": session_epoch,
        "session_start_iso": iso(session_epoch),
        "freshness": freshness,
    })

summary = {
    "total": len(mates),
    "latest": sum(m["freshness"] == "LATEST" for m in mates),
    "stale": sum(m["freshness"] == "STALE" for m in mates),
    "unknown": sum(m["freshness"] == "unknown" for m in mates),
}
result = {
    "latest_load_once": {
        "epoch": latest_epoch,
        "iso": iso(latest_epoch),
        "paths": paths,
    },
    "herdr": herdr_state,
    "mates": mates,
    "summary": summary,
}

if mode == "json":
    print(json.dumps(result, sort_keys=True))
else:
    for mate in mates:
        print("%s %s %s session~%s -> %s" % (
            mate["pane"], mate["name"], mate["status"],
            mate["session_start_iso"], mate["freshness"],
        ))
    print("summary total=%d latest=%d stale=%d unknown=%d herdr=%s latest-load-once~%s" % (
        summary["total"], summary["latest"], summary["stale"], summary["unknown"],
        herdr_state, iso(latest_epoch),
    ))

sys.exit(1 if summary["stale"] else 0)
' "$OUTPUT_MODE" "$LATEST_EPOCH" "$HERDR_STATE" "$@"
