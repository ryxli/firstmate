#!/usr/bin/env bash
# fm-browser.sh - firstmate-owned wrapper around chrome-devtools-axi.
#
# Usage:
#   fm-browser.sh [--session <name>] [--state-dir <dir>] session
#   fm-browser.sh [--session <name>] [--state-dir <dir>] stop
#   fm-browser.sh [--session <name>] [--state-dir <dir>] <chrome-devtools-axi-command> [args...]
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sbin/fm-browser-lib.sh
. "$SCRIPT_DIR/fm-browser-lib.sh"

usage() {
  printf '%s\n' 'usage: fm-browser.sh [--session <name>] [--state-dir <dir>] session|stop|<chrome-devtools-axi-command> [args...]' >&2
  exit 2
}

SESSION_ARG=
STATE_DIR_ARG=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session)
      SESSION_ARG=${2:-}
      [ -n "$SESSION_ARG" ] || usage
      shift 2
      ;;
    --state-dir)
      STATE_DIR_ARG=${2:-}
      [ -n "$STATE_DIR_ARG" ] || usage
      shift 2
      ;;
    --help|-h)
      usage
      ;;
    --)
      shift
      break
      ;;
    -*)
      printf 'unknown flag: %s\n' "$1" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

[ "$#" -gt 0 ] || usage
COMMAND=$1
shift

# A fixed port bypasses chrome-devtools-axi's named-session isolation.  Refuse
# it unless an operator deliberately opts into the one-command override.
if [ -n "${CHROME_DEVTOOLS_AXI_PORT:-}" ] && [ "${FM_BROWSER_ALLOW_PORT:-0}" != 1 ]; then
  printf '%s\n' 'error: CHROME_DEVTOOLS_AXI_PORT is set; unset it or set FM_BROWSER_ALLOW_PORT=1 for an intentional per-command override' >&2
  exit 2
fi

if [ -n "$SESSION_ARG" ]; then
  SESSION=$(fm_browser_slug "$SESSION_ARG")
elif [ -n "${FM_BROWSER_SESSION:-}" ]; then
  SESSION=$(fm_browser_slug "$FM_BROWSER_SESSION")
else
  SCRIPT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
  HOME_ROOT=${FM_HOME:-${FM_ROOT_OVERRIDE:-$SCRIPT_ROOT}}
  SESSION=$(fm_browser_default_session "$HOME_ROOT" "$(pwd -P)")
fi

STATE_DIR=${STATE_DIR_ARG:-${FM_BROWSER_STATE_DIR:-$(fm_browser_state_dir)}}
MARKER="$STATE_DIR/$SESSION.meta"

case "$COMMAND" in
  session)
    printf '%s\n' "$SESSION"
    exit 0
    ;;
  stop)
    # Never stop an arbitrary named browser.  A marker proves this home opened
    # the session and lets failed stops remain retryable during teardown.
    if [ ! -f "$MARKER" ]; then
      printf 'browser session %s has no local marker; nothing to stop\n' "$SESSION"
      exit 0
    fi

    CHROME_DEVTOOLS_AXI_SESSION="$SESSION" bunx chrome-devtools-axi stop
    rc=$?
    if [ "$rc" -eq 0 ]; then
      rm -f "$MARKER"
    fi
    exit "$rc"
    ;;
esac

mkdir -p "$STATE_DIR"
tmp=$(mktemp "$STATE_DIR/.${SESSION}.meta.XXXXXX") || {
  printf 'error: cannot create browser session marker in %s\n' "$STATE_DIR" >&2
  exit 1
}
cmd=$(printf '%q ' "$COMMAND" "$@")
cmd=${cmd% }
{
  printf 'session=%s\n' "$SESSION"
  printf 'cwd=%s\n' "$(pwd -P)"
  printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'command=%s\n' "$cmd"
} > "$tmp"
mv "$tmp" "$MARKER"

CHROME_DEVTOOLS_AXI_SESSION="$SESSION" bunx chrome-devtools-axi "$COMMAND" "$@"
