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
# Self-reload: when this script is invoked from inside the very pane it
# targets (a child of that pane's agent), sending /quit would kill the agent
# and this script with it before the relaunch step, leaving the pane dead at
# a shell with the session apparently aborted. The script detects that case
# (target pane == 'herdr pane current'), runs every fail-closed check first,
# then hands the quit/relaunch/proof sequence to a detached worker that
# survives the agent's exit. The caller returns immediately with the worker
# pid and a progress log path (state/.reload.<pane>.log); the worker appends
# a final "succeeded"/"FAILED" line there so the outcome stays observable.
#
# Pane survival: herdr closes a pane whose root process is the agent itself.
# When the target pane is gone after the quit, the relaunch provisions a
# replacement pane in the same workspace and cwd and resumes the session
# there; the session-id continuity proof runs against whichever pane hosts
# the resume. This applies to inline reloads as well as detached ones.
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
#   FM_RELOAD_SESSION_ID    Use this session id instead of capturing one from the pane.
#   FM_RELOAD_SELF_TIMEOUT  Minimum quit-wait for the detached self-reload worker
#                           (the agent finishes its turn before honoring /quit). Default: 60.
#   FM_RELOAD_NO_GUARD      Set to 1 to skip self-reload detection and run inline.
#   FM_RELOAD_DETACHED      Internal: set on the detached worker; do not set by hand.
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
      echo
      echo "When invoked from inside the target pane itself, the quit/relaunch/proof"
      echo "sequence is handed to a detached worker that survives the agent's exit;"
      echo "progress and the final outcome land in state/.reload.<pane>.log."
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

# Detached self-reload worker: stdout/stderr already point at the progress
# log; stamp the start and always record the final outcome, because the
# caller that spawned this worker is gone by the time the reload finishes.
if [ -n "${FM_RELOAD_DETACHED:-}" ]; then
  printf '%s fm-reload.sh: detached self-reload worker started (target %s)\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" "${TARGET:-auto}"
  # shellcheck disable=SC2154  # rc/ts are assigned inside the trap itself
  trap 'rc=$?; ts=$(date "+%Y-%m-%dT%H:%M:%S%z");
    if [ "$rc" -eq 0 ]; then
      printf "%s fm-reload.sh: detached self-reload of pane %s succeeded (session live in pane %s)\n" \
        "$ts" "${PANE:-unresolved}" "${RELAUNCH_PANE:-${PANE:-unresolved}}"
    else
      printf "%s fm-reload.sh: detached self-reload of pane %s FAILED (exit %s)\n" "$ts" "${PANE:-unresolved}" "$rc"
    fi' EXIT
fi

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
SESSION_ID="${FM_RELOAD_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="$(herdr pane read "$PANE" --source recent --lines 120 2>/dev/null \
    | python3 -c 'import re,sys; t=sys.stdin.read(); m=re.findall(r"omp --resume ([0-9a-fA-F-]+)", t); print(m[-1] if m else "")' \
    2>/dev/null || true)"
fi

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
    *'{id}'*)
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
# Self-reload guard: this script running inside the pane it targets dies with
# the agent when /quit lands, before the relaunch step (observed live: pane
# left at a bare shell, session apparently aborted). All fail-closed checks
# above already passed synchronously, so hand the quit/relaunch/proof
# sequence to a detached worker (own session, log-backed stdio) that
# survives the agent's exit, and return immediately.
# ---------------------------------------------------------------------------
if [ -z "${FM_RELOAD_DETACHED:-}" ] && [ -z "${FM_RELOAD_NO_GUARD:-}" ]; then
  SELF_PANE="$(herdr pane current 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])' \
    2>/dev/null || true)"
  if [ -n "$SELF_PANE" ] && [ "$SELF_PANE" = "$PANE" ]; then
    mkdir -p "$STATE"
    RELOAD_LOG="$STATE/.reload.$(printf '%s' "$PANE" | tr ':' '-').log"
    # The agent finishes its current turn before honoring /quit, so the
    # worker waits longer for the exit than an inline reload would.
    SELF_TIMEOUT="${FM_RELOAD_SELF_TIMEOUT:-60}"
    if [ "$TIMEOUT" -gt "$SELF_TIMEOUT" ] 2>/dev/null; then
      SELF_TIMEOUT="$TIMEOUT"
    fi
    WORKER_ARGS=("$PANE" --timeout "$SELF_TIMEOUT" --proof-timeout "$PROOF_TIMEOUT")
    if [ -n "$RESUME_CMD" ]; then WORKER_ARGS+=(--cmd "$RESUME_CMD"); fi
    if [ -n "$ALLOW_FRESH" ]; then WORKER_ARGS+=(--allow-fresh); fi
    WORKER_PID="$(FM_RELOAD_DETACHED=1 FM_RELOAD_SESSION_ID="$SESSION_ID" python3 -c '
import os, sys
script, log = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
pid = os.fork()
if pid:
    print(pid)
    sys.exit(0)
os.setsid()
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
null = os.open(os.devnull, os.O_RDONLY)
os.dup2(null, 0)
os.execv(script, [script] + args)
' "$SCRIPT_DIR/fm-reload.sh" "$RELOAD_LOG" "${WORKER_ARGS[@]}")" || {
      echo "fm-reload.sh: failed to start detached self-reload worker for pane $PANE" >&2
      exit 1
    }
    echo "fm-reload.sh: target pane $PANE is this script's own pane; /quit would kill this process before the relaunch"
    echo "fm-reload.sh: reload handed to detached worker (pid $WORKER_PID); progress: $RELOAD_LOG"
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Capture relaunch context BEFORE /quit: herdr closes a pane whose root
# process is the agent itself, so the relaunch may need a replacement pane
# in the same workspace and cwd.
# ---------------------------------------------------------------------------
IFS=$'\t' read -r PANE_WS PANE_CWD PANE_LABEL <<EOF
$(herdr pane get "$PANE" 2>/dev/null \
  | python3 -c 'import json,sys; p=json.load(sys.stdin).get("result",{}).get("pane",{}); print("\t".join([p.get("workspace_id",""),p.get("cwd",""),p.get("label","")]))' \
  2>/dev/null || true)
EOF

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
    *'{id}'*)
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

# ---------------------------------------------------------------------------
# Pick the relaunch pane. Reuse the target pane when it survived the quit
# (agent launched from a persistent shell); when herdr closed it with the
# agent, provision a replacement pane in the same workspace and cwd so the
# session has somewhere usable to resume.
# ---------------------------------------------------------------------------
RELAUNCH_PANE="$PANE"
if ! herdr pane get "$PANE" 2>/dev/null \
  | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("result",{}).get("pane") else 1)' \
  2>/dev/null; then
  echo "fm-reload.sh: pane $PANE closed with the agent; creating a replacement pane" >&2
  TAB_ARGS=(--no-focus --label "${PANE_LABEL:-fm-reload-recovered}")
  if [ -n "${PANE_WS:-}" ]; then TAB_ARGS+=(--workspace "$PANE_WS"); fi
  if [ -n "${PANE_CWD:-}" ]; then TAB_ARGS+=(--cwd "$PANE_CWD"); fi
  RELAUNCH_PANE="$(herdr tab create "${TAB_ARGS[@]}" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("result",{}).get("root_pane",{}).get("pane_id",""))' \
    2>/dev/null || true)"
  if [ -z "$RELAUNCH_PANE" ]; then
    echo "fm-reload.sh: could not create a replacement pane for $PANE; session $SESSION_ID not resumed" >&2
    exit 1
  fi
  echo "fm-reload.sh: replacement pane $RELAUNCH_PANE created; resuming session there" >&2
fi

herdr pane run "$RELAUNCH_PANE" "$EFFECTIVE_CMD" || {
  echo "fm-reload.sh: relaunch command failed in pane $RELAUNCH_PANE" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Post-reload proof: verify omp restarted in the pane.
# ---------------------------------------------------------------------------
PROOF_AGENT=""
PROOF_DEADLINE=$((SECONDS + PROOF_TIMEOUT))
while [ "$SECONDS" -lt "$PROOF_DEADLINE" ]; do
  PROOF_AGENT="$(herdr pane get "$RELAUNCH_PANE" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("result",{}).get("pane",{}).get("agent",""))' \
    2>/dev/null || true)"
  if [ "$PROOF_AGENT" = "omp" ]; then
    break
  fi
  sleep 0.5
done

if [ "$PROOF_AGENT" != "omp" ]; then
  echo "fm-reload.sh: omp did not restart in pane $RELAUNCH_PANE within ${PROOF_TIMEOUT}s" >&2
  exit 1
fi
# Session id continuity: only checked when we auto-generated 'omp --resume <id>'.
# Skipped for --cmd (caller's responsibility) and --allow-fresh (no id to verify).
if [ -n "$SESSION_ID" ] && [ -z "$RESUME_CMD" ] && [ -z "$ALLOW_FRESH" ]; then
  _PROOF_CWD="$(herdr pane get "$RELAUNCH_PANE" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("result",{}).get("pane",{}).get("cwd",""))' \
    2>/dev/null || true)"
  PROOF_SID="$(herdr pane read "$RELAUNCH_PANE" --source recent --lines 60 2>/dev/null \
    | python3 -c 'import re,sys; t=sys.stdin.read(); m=re.findall(r"omp --resume ([0-9a-fA-F-]+)", t); print(m[-1] if m else "")' \
    2>/dev/null || true)"
  if [ -z "$PROOF_SID" ]; then
    PROOF_SID="$(session_id_from_store "$_PROOF_CWD")"
  fi
  if [ "$PROOF_SID" != "$SESSION_ID" ]; then
    echo "fm-reload.sh: session id mismatch after reload (expected $SESSION_ID, saw ${PROOF_SID:-none})" >&2
    exit 1
  fi
fi
