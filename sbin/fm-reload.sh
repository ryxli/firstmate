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
# When the target was a durable fm-<id> and the resume landed in a
# replacement pane, the target's state/<id>.meta is rebound (pane= and tab=)
# before success is reported, so supervision and later recovery follow the
# resumed session instead of the closed pane.
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
#   FM_RELOAD_META          Internal: durable target's meta file, carried to the
#                           detached worker so it can rebind pane=/tab= after a
#                           replacement-pane recovery; do not set by hand.
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

pane_snapshot() {
  _pane="$1"
  herdr pane get "$_pane" 2>/dev/null \
    | python3 -c '
import json,sys
try:
    p=json.load(sys.stdin).get("result",{}).get("pane")
except Exception:
    p=None
if not isinstance(p,dict):
    print("absent\t\tunknown\t0")
else:
    legacy=p.get("agent_session")
    legacy_omp=("agent" not in p and isinstance(legacy,dict) and legacy.get("agent") == "omp")
    agent="omp" if legacy_omp else p.get("agent","")
    print("present\t%s\t%s\t%s" % (agent, p.get("agent_status","unknown"), "1" if legacy_omp else "0"))
' 2>/dev/null || printf 'absent\t\tunknown\t0\n'
}

pane_details() {
  _pane="$1"
  herdr pane get "$_pane" 2>/dev/null \
    | python3 -c '
import json,sys
try:
    p=json.load(sys.stdin).get("result",{}).get("pane")
except Exception:
    p=None
if not isinstance(p,dict):
    print("\t".join(["N"] * 8))
else:
    agent=p.get("agent")
    agent_present="agent" in p and agent is not None
    path=p.get("agent_session_path")
    sid=p.get("agent_session_id")
    path_present="agent_session_path" in p and path is not None
    sid_present="agent_session_id" in p and sid is not None
    legacy=p.get("agent_session")
    legacy_omp="agent" not in p and isinstance(legacy,dict) and legacy.get("agent") == "omp"
    if legacy_omp:
        agent="omp"
        agent_present=True
    if isinstance(legacy,dict):
        value=legacy.get("value")
        kind=legacy.get("kind")
        if isinstance(value,str) and value:
            if kind in ("id","session_id") and not sid_present:
                sid=value
                sid_present=True
            elif kind in ("path","session_path","file") and not path_present:
                path=value
                path_present=True
            elif not kind and value.startswith("/") and not path_present:
                path=value
                path_present=True
    import base64
    def field(value, present):
        if not present:
            return "N"
        raw="" if value is None else str(value)
        return "Y" + base64.b64encode(raw.encode()).decode()
    print("\t".join([
        field(agent, agent_present),
        *[
            field(p.get(k), k in p and p.get(k) is not None)
            for k in ("agent_status","workspace_id","cwd","label")
        ],
        field(path,path_present),
        field(sid,sid_present),
        field("1", legacy_omp),
    ]))
' 2>/dev/null || printf '%s\n' 'N	N	N	N	N	N	N	N'
}

detail_decode() {
  case "$1" in
    N) DETAIL_PRESENT=0; DETAIL_VALUE="" ;;
    Y*) DETAIL_PRESENT=1; DETAIL_VALUE="$(python3 -c 'import base64,sys; print(base64.b64decode(sys.argv[1][1:]).decode(),end="")' "$1")" ;;
    *) return 1 ;;
  esac
}

revalidate_target() {
  _pane="$1"
  IFS=$'\t' read -r _agent _status _ws _cwd _label _session_path _session_id _legacy_omp <<EOF
$(pane_details "$_pane")
EOF
_session_path_token="$_session_path"
_session_id_token="$_session_id"
detail_decode "$_agent" || return 1; _agent="$DETAIL_VALUE"; _agent_present="$DETAIL_PRESENT"
detail_decode "$_status" || return 1; _status="$DETAIL_VALUE"; _status_present="$DETAIL_PRESENT"
detail_decode "$_ws" || return 1; _ws="$DETAIL_VALUE"; _ws_present="$DETAIL_PRESENT"
detail_decode "$_cwd" || return 1; _cwd="$DETAIL_VALUE"; _cwd_present="$DETAIL_PRESENT"
detail_decode "$_label" || return 1; _label="$DETAIL_VALUE"; _label_present="$DETAIL_PRESENT"
detail_decode "$_session_path" || return 1; _session_path="$DETAIL_VALUE"; _session_path_present="$DETAIL_PRESENT"
detail_decode "$_session_id" || return 1; _session_id="$DETAIL_VALUE"; _session_id_present="$DETAIL_PRESENT"
detail_decode "$_legacy_omp" || return 1; _legacy_omp="$DETAIL_VALUE"; _legacy_omp_present="$DETAIL_PRESENT"
  [ "$_agent" = "omp" ] || return 1
  if [ "$_status" = "idle" ] || [ "$_status" = "done" ]; then
    :
  elif [ "$_status" = "unknown" ] && [ "$_legacy_omp_present" = 1 ] && [ "$_legacy_omp" = 1 ] && [ "$(screen_state "$_pane")" = "idle" ]; then
    :
  else
    return 1
  fi
  [ "$_ws_present" = "$PANE_WS_PRESENT" ] && [ "$_cwd_present" = "$PANE_CWD_PRESENT" ] && [ "$_label_present" = "$PANE_LABEL_PRESENT" ] || return 1
  [ "$_ws" = "$PANE_WS" ] && [ "$_cwd" = "$PANE_CWD" ] && [ "$_label" = "$PANE_LABEL" ] || return 1
  [ -n "$PIN_AGENT_SESSION_PATH" ] || [ -n "$PIN_AGENT_SESSION_ID" ] || return 1
  [ "$_session_path_present" = "$PIN_AGENT_SESSION_PATH_PRESENT" ] && [ "$_session_id_present" = "$PIN_AGENT_SESSION_ID_PRESENT" ] || return 1
  [ "$_session_path_token" = "$PIN_AGENT_SESSION_PATH_TOKEN" ] && [ "$_session_id_token" = "$PIN_AGENT_SESSION_ID_TOKEN" ] || return 1
  [ "$_session_path" = "$PIN_AGENT_SESSION_PATH" ] && [ "$_session_id" = "$PIN_AGENT_SESSION_ID" ] || return 1
  if [ -n "$SESSION_ID" ]; then
    _current_sid="$(herdr pane read "$_pane" --source recent --lines 120 2>/dev/null \
      | python3 -c 'import re,sys; m=re.findall(r"omp --resume ([0-9a-fA-F-]+)",sys.stdin.read()); print(m[-1] if m else "")' \
      2>/dev/null || true)"
    if [ -z "$_current_sid" ]; then
      _current_sid="$(session_id_from_store "$PANE_CWD")"
    fi
    [ -n "$_current_sid" ] || return 1
    [ "$_current_sid" = "$SESSION_ID" ] || return 1
  fi
  return 0
}

screen_state() {
  # `pane read visible` retains scrollback. Only the final visible compositor
  # can establish idle; historical output before it is intentionally ignored.
  herdr pane read "$1" --source visible --lines 120 2>/dev/null \
    | python3 -c '
import re,sys

ansi = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])")
lines = [ansi.sub("", line) for line in sys.stdin.read().splitlines()]
while lines and lines[-1] == "":
    lines.pop()
if len(lines) < 2:
    print("unknown")
    raise SystemExit
header, bottom = lines[-2:]
header_match = re.fullmatch(r"╭── .+ ──╮", header)
bottom_match = re.fullmatch(r"╰─( +)─╯", bottom)
prior = len(lines) - 3
while prior >= 0 and not lines[prior].strip():
    prior -= 1
if prior >= 0 and re.search(r"[⠁-⣿]|⟦esc⟧", lines[prior]):
    print("unknown")
elif header_match and bottom_match:
    print("idle")
else:
    print("unknown")
' 2>/dev/null || printf 'unknown\n'
}


wait_for_confirmed_idle() {
  _pane="$1"
  _timeout="$2"
  _deadline=$((SECONDS + _timeout))
  while [ "$SECONDS" -lt "$_deadline" ]; do
    IFS=$'\t' read -r _exists _agent _status _legacy_omp <<EOF
$(pane_snapshot "$_pane")
EOF
    if [ "$_exists" = "absent" ]; then
      echo "fm-reload.sh: pane $_pane is absent; refusing /quit" >&2
      return 1
    fi
    _screen="$(screen_state "$_pane")"
    if [ "$_agent" = "omp" ] && { [ "$_status" = "idle" ] || [ "$_status" = "done" ] || { [ "$_status" = "unknown" ] && [ "$_legacy_omp" = 1 ]; }; } && [ "$_screen" = "idle" ]; then
      return 0
    fi
    sleep 0.25
  done
  echo "fm-reload.sh: pane $_pane never reached confirmed idle; refusing /quit (agent=${_agent:-unknown} status=${_status:-unknown})" >&2
  return 1
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
META_FILE="${FM_RELOAD_META:-}"
if [ -n "$TARGET" ]; then
  if ! PANE=$(fm_resolve_live_pane "$TARGET" "$STATE"); then
    exit 1
  fi
  # Durable target: remember the meta file so a replacement-pane recovery
  # can rebind pane=/tab= to the pane that actually hosts the resume.
  case "$TARGET" in
    *:*) ;;
    fm-*) META_FILE="$STATE/${TARGET#fm-}.meta" ;;
  esac
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

# Capture the target identity before a detached self-reload forks. The worker
# receives these values and must revalidate against them rather than adopting a
# replacement pane/session as its new baseline.
PANE_WS="${FM_RELOAD_PIN_WS-}"
PANE_CWD="${FM_RELOAD_PIN_CWD-}"
PANE_LABEL="${FM_RELOAD_PIN_LABEL-}"
PIN_AGENT_SESSION_PATH="${FM_RELOAD_PIN_AGENT_SESSION_PATH-}"
PIN_AGENT_SESSION_ID="${FM_RELOAD_PIN_AGENT_SESSION_ID-}"
PIN_AGENT_SESSION_PATH_TOKEN="${FM_RELOAD_PIN_AGENT_SESSION_PATH_TOKEN-}"
PIN_AGENT_SESSION_ID_TOKEN="${FM_RELOAD_PIN_AGENT_SESSION_ID_TOKEN-}"
PANE_WS_SET="${FM_RELOAD_PIN_WS_SET:-}"
PANE_CWD_SET="${FM_RELOAD_PIN_CWD_SET:-}"
PANE_LABEL_SET="${FM_RELOAD_PIN_LABEL_SET:-}"
PIN_AGENT_SESSION_PATH_SET="${FM_RELOAD_PIN_AGENT_SESSION_PATH_SET:-}"
PIN_AGENT_SESSION_ID_SET="${FM_RELOAD_PIN_AGENT_SESSION_ID_SET:-}"
PANE_WS_PRESENT="${FM_RELOAD_PIN_WS_PRESENT:-}"
PANE_CWD_PRESENT="${FM_RELOAD_PIN_CWD_PRESENT:-}"
PANE_LABEL_PRESENT="${FM_RELOAD_PIN_LABEL_PRESENT:-}"
PIN_AGENT_SESSION_PATH_PRESENT="${FM_RELOAD_PIN_AGENT_SESSION_PATH_PRESENT:-}"
PIN_AGENT_SESSION_ID_PRESENT="${FM_RELOAD_PIN_AGENT_SESSION_ID_PRESENT:-}"
IFS=$'\t' read -r _PIN_AGENT _PIN_STATUS _CAP_WS _CAP_CWD _CAP_LABEL _CAP_SESSION_PATH _CAP_SESSION_ID _CAP_LEGACY_OMP <<EOF
$(pane_details "$PANE")
EOF
_CAP_SESSION_PATH_TOKEN="$_CAP_SESSION_PATH"
_CAP_SESSION_ID_TOKEN="$_CAP_SESSION_ID"
detail_decode "$_PIN_AGENT" || exit 1; _PIN_AGENT="$DETAIL_VALUE"; _PIN_AGENT_PRESENT="$DETAIL_PRESENT"
detail_decode "$_PIN_STATUS" || exit 1; _PIN_STATUS="$DETAIL_VALUE"; _PIN_STATUS_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CAP_WS" || exit 1; _CAP_WS="$DETAIL_VALUE"; _CAP_WS_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CAP_CWD" || exit 1; _CAP_CWD="$DETAIL_VALUE"; _CAP_CWD_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CAP_LABEL" || exit 1; _CAP_LABEL="$DETAIL_VALUE"; _CAP_LABEL_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CAP_SESSION_PATH" || exit 1; _CAP_SESSION_PATH="$DETAIL_VALUE"; _CAP_SESSION_PATH_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CAP_SESSION_ID" || exit 1; _CAP_SESSION_ID="$DETAIL_VALUE"; _CAP_SESSION_ID_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CAP_LEGACY_OMP" || exit 1
if [ -z "$PANE_WS_SET" ]; then PANE_WS="$_CAP_WS"; PANE_WS_SET=1; PANE_WS_PRESENT="$_CAP_WS_PRESENT"; fi
if [ -z "$PANE_CWD_SET" ]; then PANE_CWD="$_CAP_CWD"; PANE_CWD_SET=1; PANE_CWD_PRESENT="$_CAP_CWD_PRESENT"; fi
if [ -z "$PANE_LABEL_SET" ]; then PANE_LABEL="$_CAP_LABEL"; PANE_LABEL_SET=1; PANE_LABEL_PRESENT="$_CAP_LABEL_PRESENT"; fi
if [ -z "$PIN_AGENT_SESSION_PATH_SET" ]; then PIN_AGENT_SESSION_PATH="$_CAP_SESSION_PATH"; PIN_AGENT_SESSION_PATH_TOKEN="$_CAP_SESSION_PATH_TOKEN"; PIN_AGENT_SESSION_PATH_SET=1; PIN_AGENT_SESSION_PATH_PRESENT="$_CAP_SESSION_PATH_PRESENT"; fi
if [ -z "$PIN_AGENT_SESSION_ID_SET" ]; then PIN_AGENT_SESSION_ID="$_CAP_SESSION_ID"; PIN_AGENT_SESSION_ID_TOKEN="$_CAP_SESSION_ID_TOKEN"; PIN_AGENT_SESSION_ID_SET=1; PIN_AGENT_SESSION_ID_PRESENT="$_CAP_SESSION_ID_PRESENT"; fi
if [ -z "$PIN_AGENT_SESSION_PATH" ] && [ -z "$PIN_AGENT_SESSION_ID" ]; then
  echo "fm-reload.sh: target pane $PANE has no Herdr agent_session identity; refusing /quit" >&2
  exit 1
fi
[ "$PANE_WS_PRESENT" = "$_CAP_WS_PRESENT" ] && [ "$PANE_CWD_PRESENT" = "$_CAP_CWD_PRESENT" ] && [ "$PANE_LABEL_PRESENT" = "$_CAP_LABEL_PRESENT" ] && [ "$PANE_WS" = "$_CAP_WS" ] && [ "$PANE_CWD" = "$_CAP_CWD" ] && [ "$PANE_LABEL" = "$_CAP_LABEL" ] || {
  echo "fm-reload.sh: target pane changed before identity capture; refusing /quit" >&2
  exit 1
}
[ "$PIN_AGENT_SESSION_PATH_PRESENT" = "$_CAP_SESSION_PATH_PRESENT" ] && [ "$PIN_AGENT_SESSION_ID_PRESENT" = "$_CAP_SESSION_ID_PRESENT" ] && [ "$PIN_AGENT_SESSION_PATH_TOKEN" = "$_CAP_SESSION_PATH_TOKEN" ] && [ "$PIN_AGENT_SESSION_ID_TOKEN" = "$_CAP_SESSION_ID_TOKEN" ] && [ "$PIN_AGENT_SESSION_PATH" = "$_CAP_SESSION_PATH" ] && [ "$PIN_AGENT_SESSION_ID" = "$_CAP_SESSION_ID" ] || {
  echo "fm-reload.sh: target pane $PANE agent_session identity changed before identity capture; refusing /quit" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Self-reload guard: this script running inside the pane it targets dies with
# the agent when /quit lands, before the relaunch step (observed live: pane
# targets (a child of that pane's agent), sending /quit would kill the agent
# and this script with it before the relaunch step (observed live: pane
# left at a bare shell, session apparently aborted). All fail-closed checks
# above already passed synchronously, so hand the quit/relaunch/proof
# sequence to a detached worker (own session, log-backed stdio) that
# survives the agent's exit, and return immediately.

# ---------------------------------------------------------------------------
SELF_PANE=""
if [ -z "${FM_RELOAD_NO_GUARD:-}" ]; then
  SELF_PANE="$(herdr pane current 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])' \
    2>/dev/null || true)"
fi
if [ -z "${FM_RELOAD_DETACHED:-}" ] && [ -z "${FM_RELOAD_NO_GUARD:-}" ]; then
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
    WORKER_PID="$(FM_RELOAD_DETACHED=1 FM_RELOAD_SESSION_ID="$SESSION_ID" FM_RELOAD_META="$META_FILE" FM_STATE_OVERRIDE="$STATE" FM_ROOT_OVERRIDE="$FM_ROOT" FM_RELOAD_PIN_WS="$PANE_WS" FM_RELOAD_PIN_CWD="$PANE_CWD" FM_RELOAD_PIN_LABEL="$PANE_LABEL" FM_RELOAD_PIN_AGENT_SESSION_PATH="$PIN_AGENT_SESSION_PATH" FM_RELOAD_PIN_AGENT_SESSION_ID="$PIN_AGENT_SESSION_ID" FM_RELOAD_PIN_AGENT_SESSION_PATH_TOKEN="$PIN_AGENT_SESSION_PATH_TOKEN" FM_RELOAD_PIN_AGENT_SESSION_ID_TOKEN="$PIN_AGENT_SESSION_ID_TOKEN" FM_RELOAD_PIN_WS_SET=1 FM_RELOAD_PIN_CWD_SET=1 FM_RELOAD_PIN_LABEL_SET=1 FM_RELOAD_PIN_AGENT_SESSION_PATH_SET=1 FM_RELOAD_PIN_AGENT_SESSION_ID_SET=1 FM_RELOAD_PIN_WS_PRESENT="$PANE_WS_PRESENT" FM_RELOAD_PIN_CWD_PRESENT="$PANE_CWD_PRESENT" FM_RELOAD_PIN_LABEL_PRESENT="$PANE_LABEL_PRESENT" FM_RELOAD_PIN_AGENT_SESSION_PATH_PRESENT="$PIN_AGENT_SESSION_PATH_PRESENT" FM_RELOAD_PIN_AGENT_SESSION_ID_PRESENT="$PIN_AGENT_SESSION_ID_PRESENT" python3 -c '
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

# Best-effort bounded safety gate: Herdr's pane run has no conditional-send
# primitive, so this check is fail-closed on every observed busy/unknown/
# mismatch state but cannot eliminate a final check-to-/quit TOCTOU race.
# A detached self-reload worker reaches this gate after the current turn.
# Pin the target identity before waiting: pane ids can be compacted/reused.
IFS=$'\t' read -r _CUR_AGENT _CUR_STATUS _CUR_WS _CUR_CWD _CUR_LABEL _CUR_SESSION_PATH _CUR_SESSION_ID _CUR_LEGACY_OMP <<EOF
$(pane_details "$PANE")
EOF
_CUR_SESSION_PATH_TOKEN="$_CUR_SESSION_PATH"
_CUR_SESSION_ID_TOKEN="$_CUR_SESSION_ID"
detail_decode "$_CUR_AGENT" || exit 1; _CUR_AGENT="$DETAIL_VALUE"; _CUR_AGENT_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CUR_STATUS" || exit 1; _CUR_STATUS="$DETAIL_VALUE"; _CUR_STATUS_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CUR_WS" || exit 1; _CUR_WS="$DETAIL_VALUE"; _CUR_WS_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CUR_CWD" || exit 1; _CUR_CWD="$DETAIL_VALUE"; _CUR_CWD_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CUR_LABEL" || exit 1; _CUR_LABEL="$DETAIL_VALUE"; _CUR_LABEL_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CUR_SESSION_PATH" || exit 1; _CUR_SESSION_PATH="$DETAIL_VALUE"; _CUR_SESSION_PATH_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CUR_SESSION_ID" || exit 1; _CUR_SESSION_ID="$DETAIL_VALUE"; _CUR_SESSION_ID_PRESENT="$DETAIL_PRESENT"
detail_decode "$_CUR_LEGACY_OMP" || exit 1
if [ "$_CUR_AGENT" != "omp" ] || [ "$_CUR_WS_PRESENT" != "$PANE_WS_PRESENT" ] || [ "$_CUR_CWD_PRESENT" != "$PANE_CWD_PRESENT" ] || [ "$_CUR_LABEL_PRESENT" != "$PANE_LABEL_PRESENT" ] || [ "$_CUR_WS" != "$PANE_WS" ] || [ "$_CUR_CWD" != "$PANE_CWD" ] || [ "$_CUR_LABEL" != "$PANE_LABEL" ]; then
  echo "fm-reload.sh: target pane changed before idle wait; refusing /quit" >&2
  exit 1
fi
if [ -z "$PIN_AGENT_SESSION_PATH" ] && [ -z "$PIN_AGENT_SESSION_ID" ]; then
  echo "fm-reload.sh: target pane $PANE has no Herdr agent_session identity; refusing /quit" >&2
  exit 1
fi
if [ "$_CUR_SESSION_PATH_PRESENT" != "$PIN_AGENT_SESSION_PATH_PRESENT" ] || [ "$_CUR_SESSION_ID_PRESENT" != "$PIN_AGENT_SESSION_ID_PRESENT" ] || [ "$_CUR_SESSION_PATH_TOKEN" != "$PIN_AGENT_SESSION_PATH_TOKEN" ] || [ "$_CUR_SESSION_ID_TOKEN" != "$PIN_AGENT_SESSION_ID_TOKEN" ] || [ "$_CUR_SESSION_PATH" != "$PIN_AGENT_SESSION_PATH" ] || [ "$_CUR_SESSION_ID" != "$PIN_AGENT_SESSION_ID" ]; then
  echo "fm-reload.sh: target pane $PANE agent_session identity changed; refusing /quit" >&2
  exit 1
fi
if ! wait_for_confirmed_idle "$PANE" "$TIMEOUT"; then
  exit 1
fi


REAL_STATE="$(screen_state "$PANE")"
if [ "$REAL_STATE" != "idle" ]; then
  echo "fm-reload.sh: pane $PANE screen is ${REAL_STATE:-unknown}; refusing /quit" >&2
  exit 1
fi
if ! revalidate_target "$PANE"; then
  echo "fm-reload.sh: target pane $PANE changed or session identity could not be revalidated; refusing /quit" >&2
  exit 1
fi
# ---------------------------------------------------------------------------
# Quit and wait for omp to exit.
# Residual limitation: the separate `pane run` can race a pane transition after
# revalidation; without Herdr conditional send, this is bounded mitigation only.
# ---------------------------------------------------------------------------
herdr pane run "$PANE" "/quit" || exit 1
sleep "$QUIT_GRACE"

EXIT_CONFIRMED=""
DEADLINE=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  PANE_INFO="$(herdr pane get "$PANE" 2>/dev/null || true)"
  case "$PANE_INFO" in
    ''|*'"error"'*)
      EXIT_CONFIRMED=1
      break
      ;;
  esac
  AGENT="$(printf '%s' "$PANE_INFO" | fm_json_get result pane agent)"
  case "$(fm_herdr_pane_agent_process_verdict "$PANE")" in
    shell)
      EXIT_CONFIRMED=1
      break
      ;;
    agent) ;;
    err)
      # Preserve the prior metadata fallback when process inspection is
      # unavailable. A stale "omp" identity still fails closed.
      if [ "$AGENT" != "omp" ]; then
        EXIT_CONFIRMED=1
        break
      fi
      ;;
  esac
  sleep 0.25
done

if [ -z "$EXIT_CONFIRMED" ]; then
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
RELAUNCH_TAB=""
if ! herdr pane get "$PANE" 2>/dev/null \
  | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("result",{}).get("pane") else 1)' \
  2>/dev/null; then
  echo "fm-reload.sh: pane $PANE closed with the agent; creating a replacement pane" >&2
  TAB_ARGS=(--no-focus --label "${PANE_LABEL:-fm-reload-recovered}")
  if [ -n "${PANE_WS:-}" ]; then TAB_ARGS+=(--workspace "$PANE_WS"); fi
  if [ -n "${PANE_CWD:-}" ]; then TAB_ARGS+=(--cwd "$PANE_CWD"); fi
  RELAUNCH_JSON="$(herdr tab create "${TAB_ARGS[@]}" 2>/dev/null || true)"
  RELAUNCH_PANE="$(printf '%s' "$RELAUNCH_JSON" | fm_json_get result root_pane pane_id)"
  RELAUNCH_TAB="$(printf '%s' "$RELAUNCH_JSON" | fm_json_get result tab tab_id)"
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
PROOF_PANE=""
PROOF_AGENT=""
PROOF_DEADLINE=$((SECONDS + PROOF_TIMEOUT))
while [ "$SECONDS" -lt "$PROOF_DEADLINE" ]; do
  IFS=$'\t' read -r PROOF_PANE PROOF_AGENT _PROOF_STATUS _PROOF_LEGACY_OMP <<EOF
$(pane_snapshot "$RELAUNCH_PANE")
EOF
  # pane_snapshot is the canonical decoder for current and legacy Herdr OMP
  # identity. Do not read pane.agent directly: legacy panes encode it solely
  # as agent_session.agent.
  if [ "$PROOF_PANE" = "present" ] && [ "$PROOF_AGENT" = "omp" ]; then
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

# ---------------------------------------------------------------------------
# Durable-target rebind: the resume landed in a replacement pane, so point
# the fm-<id> metadata at it before reporting success; otherwise supervision
# and later recovery keep following the closed pane.
# ---------------------------------------------------------------------------
if [ -n "$META_FILE" ] && [ "$RELAUNCH_PANE" != "$PANE" ] && [ -f "$META_FILE" ]; then
  if ! fm_meta_set "$META_FILE" pane "$RELAUNCH_PANE"; then
    echo "fm-reload.sh: session resumed in pane $RELAUNCH_PANE but failed to rebind pane= in $META_FILE" >&2
    exit 1
  fi
  if [ -n "$RELAUNCH_TAB" ]; then
    if ! fm_meta_set "$META_FILE" tab "$RELAUNCH_TAB"; then
      echo "fm-reload.sh: session resumed in pane $RELAUNCH_PANE but failed to rebind tab= in $META_FILE" >&2
      exit 1
    fi
  fi
  echo "fm-reload.sh: rebound $META_FILE to replacement pane $RELAUNCH_PANE${RELAUNCH_TAB:+ (tab $RELAUNCH_TAB)}" >&2
fi
