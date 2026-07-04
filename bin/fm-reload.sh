#!/usr/bin/env bash
# Cleanly quit an omp pane, wait for the shell to return, then resume.
# Usage: fm-reload.sh [pane_id] [--cmd '<resume command or template>'] [--timeout <seconds>]
#
# Without a pane_id, targets the current herdr pane.
# Sends /quit, waits for omp to exit, captures 'omp --resume <id>' from recent
# pane output, then relaunches with that command (or falls back to 'omp -c').
#
# Options:
#   --cmd <template>   Custom relaunch command. '{id}' is replaced with the
#                      captured session id (error if the id is unavailable).
#   --timeout <sec>    Seconds to wait for omp to exit. Default: 8.
#
# Env overrides:
#   FM_RELOAD_CMD          Default value for --cmd.
#   FM_RELOAD_TIMEOUT      Default value for --timeout.
#   FM_RELOAD_QUIT_GRACE   Seconds to sleep after /quit before polling. Default: 1.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"

[ -n "${FM_RELOAD_NO_GUARD:-}" ] || "$SCRIPT_DIR/fm-guard.sh" || true

PANE=""
RESUME_CMD="${FM_RELOAD_CMD:-}"
TIMEOUT="${FM_RELOAD_TIMEOUT:-8}"
QUIT_GRACE="${FM_RELOAD_QUIT_GRACE:-1}"

_usage() {
  echo "usage: fm-reload.sh [pane_id] [--cmd '<resume command or template>'] [--timeout <seconds>]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --cmd)
      if [ -z "${2:-}" ]; then _usage; exit 1; fi
      RESUME_CMD="$2"
      shift 2
      ;;
    --timeout)
      if [ -z "${2:-}" ]; then _usage; exit 1; fi
      TIMEOUT="$2"
      shift 2
      ;;
    -h|--help)
      echo "usage: fm-reload.sh [pane_id] [--cmd '<resume command or template>'] [--timeout <seconds>]"
      echo
      echo "Cleanly quit an omp pane, wait for the pane to return to a shell,"
      echo "then resume the same conversation in the same pane/cwd."
      echo
      echo "Defaults:"
      echo "  pane_id     current herdr pane"
      echo "  --cmd       'omp --resume <id>' when available, else 'omp -c'"
      echo "              if provided, '{id}' is replaced with the captured session id"
      echo "  --timeout   8 seconds"
      exit 0
      ;;
    -*)
      echo "fm-reload.sh: unknown option '$1'" >&2
      exit 1
      ;;
    *)
      if [ -n "$PANE" ]; then
        echo "fm-reload.sh: unexpected extra argument '$1'" >&2
        exit 1
      fi
      PANE="$1"
      shift
      ;;
  esac
done

if [ -z "$PANE" ]; then
  PANE="$(herdr pane current 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])' \
    2>/dev/null || true)"
fi
if [ -z "$PANE" ]; then
  echo "fm-reload.sh: could not determine target pane" >&2
  exit 1
fi

herdr pane run "$PANE" "/quit" || exit 1
sleep "$QUIT_GRACE"

AGENT=""
SESSION_ID=""
DEADLINE=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  AGENT="$(herdr pane get "$PANE" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("result",{}).get("pane",{}).get("agent",""))' \
    2>/dev/null || true)"
  SESSION_ID="$(herdr pane read "$PANE" --source recent --lines 120 2>/dev/null \
    | python3 -c 'import re,sys; t=sys.stdin.read(); m=re.search(r"omp --resume ([0-9a-fA-F-]+)", t); print(m.group(1) if m else "")' \
    2>/dev/null || true)"
  if [ "$AGENT" != "omp" ]; then
    break
  fi
  sleep 0.25
done

if [ "$AGENT" = "omp" ]; then
  echo "fm-reload.sh: pane $PANE still looks like omp after ${TIMEOUT}s" >&2
  exit 1
fi

EFFECTIVE_CMD=""
if [ -n "$RESUME_CMD" ]; then
  case "$RESUME_CMD" in
    *{id}*)
      if [ -z "$SESSION_ID" ]; then
        echo "fm-reload.sh: could not capture a session id for '{id}' substitution" >&2
        exit 1
      fi
      EFFECTIVE_CMD="${RESUME_CMD//\{id\}/$SESSION_ID}"
      ;;
    *)
      EFFECTIVE_CMD="$RESUME_CMD"
      ;;
  esac
elif [ -n "$SESSION_ID" ]; then
  EFFECTIVE_CMD="omp --resume $SESSION_ID"
else
  EFFECTIVE_CMD="omp -c"
fi

herdr pane run "$PANE" "$EFFECTIVE_CMD"
