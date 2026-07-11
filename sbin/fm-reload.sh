#!/usr/bin/env bash
# Quit an omp pane, wait for the shell to return, then resume the exact prior session.
# Usage: fm-reload.sh [target] [--cmd '<template>'] [--allow-fresh] [--timeout <sec>] [--proof-timeout <sec>]
#
# <target> may be:
#   w1:p3      explicit herdr pane id
#   fm-riggs   durable firstmate mate name (resolved via state/<id>.meta)
#   (none)     auto-detect via 'herdr pane current'
#
# The prior session id is captured BEFORE sending /quit so it is never
# lost to output scroll. After relaunch the script waits for omp to
# reappear in the pane and verifies the session id matches, then exits.
# It exits non-zero without touching the pane when:
#   - no session id is found and --allow-fresh is not set
# It exits non-zero after the quit when:
#   - omp does not exit within <timeout> seconds
#   - omp does not restart within <proof-timeout> seconds
#   - the resumed session id does not match the captured prior id
#
# Options:
#   --cmd <template>       Custom relaunch command. '{id}' is replaced with the
#                          captured session id (error if unavailable).
#   --allow-fresh          Permit 'omp -c' (fresh session) when no session id
#                          was found. Skips session-id continuity proof.
#   --timeout <sec>        Seconds to wait for omp to exit. Default: 8.
#   --proof-timeout <sec>  Seconds to wait for post-reload proof. Default: 30.
#
# Env overrides:
#   FM_RELOAD_CMD           Default value for --cmd.
#   FM_RELOAD_TIMEOUT       Default value for --timeout.
#   FM_RELOAD_PROOF_TIMEOUT Default value for --proof-timeout.
#   FM_RELOAD_QUIT_GRACE    Seconds to sleep after /quit before polling. Default: 1.
#   FM_RELOAD_ALLOW_FRESH   Set to 1 to allow fresh session (same as --allow-fresh).
#   FM_OMP_SESSION_STORE    Base path for omp session store. Default: $HOME/.omp/agent/sessions.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

# shellcheck source=sbin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"

TARGET=""
RESUME_CMD="${FM_RELOAD_CMD:-}"
TIMEOUT="${FM_RELOAD_TIMEOUT:-8}"
QUIT_GRACE="${FM_RELOAD_QUIT_GRACE:-1}"
PROOF_TIMEOUT="${FM_RELOAD_PROOF_TIMEOUT:-30}"
ALLOW_FRESH="${FM_RELOAD_ALLOW_FRESH:-}"
OMP_SESSION_STORE="${FM_OMP_SESSION_STORE:-${HOME}/.omp/agent/sessions}"


session_id_from_store() {
  _cwd="${1:-}"
  [ -n "$_cwd" ] || return 0
  _rel_cwd="$_cwd"
  case "$_rel_cwd" in
    "$HOME"/*) _rel_cwd="${_rel_cwd#"$HOME"}" ;;
    "$HOME") _rel_cwd="/" ;;
  esac
  _bucket="${_rel_cwd//\//-}"
  _store_path="$OMP_SESSION_STORE/$_bucket"
  [ -d "$_store_path" ] || return 0
  python3 -c '
import os, sys
store = sys.argv[1]
try:
    files = [f for f in os.listdir(store) if f.endswith(".jsonl")]
    if files:
        newest = max(files, key=lambda f: os.path.getmtime(os.path.join(store, f)))
        stem = newest[:-6]
        sid = stem.split("_", 1)[1] if "_" in stem else stem
        print(sid)
except Exception:
    pass
' "$_store_path" 2>/dev/null || true
}
_usage() {
  echo "usage: fm-reload.sh [target] [--cmd '<template>'] [--allow-fresh] [--timeout <sec>] [--proof-timeout <sec>]" >&2
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
    --proof-timeout)
      if [ -z "${2:-}" ]; then _usage; exit 1; fi
      PROOF_TIMEOUT="$2"
      shift 2
      ;;
    --allow-fresh)
      ALLOW_FRESH=1
      shift
      ;;
    -h|--help)
      echo "usage: fm-reload.sh [target] [--cmd '<template>'] [--allow-fresh] [--timeout <sec>] [--proof-timeout <sec>]"
      echo
      echo "Quit an omp pane, wait for the shell to return, then resume the exact prior session."
      echo
      echo "Targets:"
      echo "  w1:p3      explicit herdr pane id"
      echo "  fm-riggs   durable firstmate mate name (resolved via state/<id>.meta)"
      echo "  (none)     auto-detect via 'herdr pane current'"
      echo
      echo "Options:"
      echo "  --cmd <template>      Relaunch with this command; '{id}' substituted with session id."
      echo "  --allow-fresh         Fall back to 'omp -c' when no session id is found."
      echo "  --timeout <sec>       Seconds to wait for omp to exit. Default: 8."
      echo "  --proof-timeout <sec> Seconds to wait for omp to restart. Default: 30."
      echo
      echo "Fails before sending /quit when no session id is found and --allow-fresh is not set."
      exit 0
      ;;
    -*)
      echo "fm-reload.sh: unknown option '$1'" >&2
      exit 1
      ;;
    *)
      if [ -n "$TARGET" ]; then
        echo "fm-reload.sh: unexpected extra argument '$1'" >&2
        exit 1
      fi
      TARGET="$1"
      shift
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Resolve target to a concrete herdr pane id.
# Supports: w1:p3 (raw), fm-<name> (durable identity), or auto-detect.
# ---------------------------------------------------------------------------
PANE=""
if [ -n "$TARGET" ]; then
  if ! PANE=$(fm_resolve_live_pane "$TARGET" "$STATE"); then
    exit 1
  fi
else
  PANE="$(herdr pane current 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])' \
    2>/dev/null || true)"
fi
if [ -z "$PANE" ]; then
  echo "fm-reload.sh: could not determine target pane" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Capture the session id BEFORE sending /quit.
# The startup banner ("omp --resume <id>") is in the scrollback now; after
# quit the output is overwritten by the shell prompt sequence.
# ---------------------------------------------------------------------------
SESSION_ID="$(herdr pane read "$PANE" --source recent --lines 120 2>/dev/null \
  | python3 -c 'import re,sys; t=sys.stdin.read(); m=re.search(r"omp --resume ([0-9a-fA-F-]+)", t); print(m.group(1) if m else "")' \
  2>/dev/null || true)"

# Deterministic fallback: when scrollback did not expose the session id, derive it
# from the omp session store. The pane cwd maps to a per-project bucket relative
# to $HOME (e.g. /Users/ryan/code/mates/riggs -> -code-mates-riggs), so we never
if [ -z "$SESSION_ID" ]; then
  _PANE_CWD="$(herdr pane get "$PANE" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("result",{}).get("pane",{}).get("cwd",""))' \
    2>/dev/null || true)"
  SESSION_ID="$(session_id_from_store "$_PANE_CWD")"
fi

# Validate --cmd template before doing anything destructive.
if [ -n "$RESUME_CMD" ]; then
  case "$RESUME_CMD" in
    *"{id}"*)
      if [ -z "$SESSION_ID" ]; then
        echo "fm-reload.sh: --cmd contains '{id}' but no session id found in pane $PANE output" >&2
        exit 1
      fi
      ;;
  esac
fi

# Fail closed: no session id and no explicit opt-out means we refuse to reload.
# This check runs BEFORE /quit so the pane is left untouched on failure.
if [ -z "$SESSION_ID" ] && [ -z "$RESUME_CMD" ] && [ -z "$ALLOW_FRESH" ]; then
  echo "fm-reload.sh: no session id found in pane $PANE; pass --allow-fresh to permit 'omp -c', or --cmd to specify the relaunch command" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Quit and wait for omp to exit.
# ---------------------------------------------------------------------------
herdr pane run "$PANE" "/quit" || exit 1
sleep "$QUIT_GRACE"

AGENT=""
DEADLINE=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  AGENT="$(herdr pane get "$PANE" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("result",{}).get("pane",{}).get("agent",""))' \
    2>/dev/null || true)"
  if [ "$AGENT" != "omp" ]; then
    break
  fi
  sleep 0.25
done

if [ "$AGENT" = "omp" ]; then
  echo "fm-reload.sh: pane $PANE still running omp after ${TIMEOUT}s; reload aborted" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Build the relaunch command.
# ---------------------------------------------------------------------------
EFFECTIVE_CMD=""
if [ -n "$RESUME_CMD" ]; then
  case "$RESUME_CMD" in
    *"{id}"*)
      # Already validated above that SESSION_ID is set.
      EFFECTIVE_CMD="${RESUME_CMD//\{id\}/$SESSION_ID}"
      ;;
    *)
      EFFECTIVE_CMD="$RESUME_CMD"
      ;;
  esac
elif [ -n "$SESSION_ID" ]; then
  EFFECTIVE_CMD="omp --resume $SESSION_ID"
elif [ -n "$ALLOW_FRESH" ]; then
  EFFECTIVE_CMD="omp -c"
else
  # Defensive: caught before /quit, but guard against logic drift.
  echo "fm-reload.sh: no session id found and --allow-fresh not set" >&2
  exit 1
fi

herdr pane run "$PANE" "$EFFECTIVE_CMD" || exit 1

# ---------------------------------------------------------------------------
# Post-reload proof: verify omp restarted in the pane.
# ---------------------------------------------------------------------------
PROOF_AGENT=""
PROOF_DEADLINE=$((SECONDS + PROOF_TIMEOUT))
while [ "$SECONDS" -lt "$PROOF_DEADLINE" ]; do
  PROOF_AGENT="$(herdr pane get "$PANE" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("result",{}).get("pane",{}).get("agent",""))' \
    2>/dev/null || true)"
  if [ "$PROOF_AGENT" = "omp" ]; then
    break
  fi
  sleep 0.5
done

if [ "$PROOF_AGENT" != "omp" ]; then
  echo "fm-reload.sh: omp did not restart in pane $PANE within ${PROOF_TIMEOUT}s" >&2
  exit 1
fi
# Session id continuity: only checked when we auto-generated 'omp --resume <id>'.
# Skipped for --cmd (caller's responsibility) and --allow-fresh (no id to verify).
if [ -n "$SESSION_ID" ] && [ -z "$RESUME_CMD" ] && [ -z "$ALLOW_FRESH" ]; then
  _PROOF_CWD="$(herdr pane get "$PANE" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("result",{}).get("pane",{}).get("cwd",""))' \
    2>/dev/null || true)"
  PROOF_SID="$(herdr pane read "$PANE" --source recent --lines 60 2>/dev/null \
    | python3 -c 'import re,sys; t=sys.stdin.read(); m=re.search(r"omp --resume ([0-9a-fA-F-]+)", t); print(m.group(1) if m else "")' \
    2>/dev/null || true)"
  if [ -z "$PROOF_SID" ]; then
    PROOF_SID="$(session_id_from_store "$_PROOF_CWD")"
  fi
  if [ "$PROOF_SID" != "$SESSION_ID" ]; then
    echo "fm-reload.sh: session id mismatch after reload (expected $SESSION_ID, saw ${PROOF_SID:-none})" >&2
    exit 1
  fi
fi
