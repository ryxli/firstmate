#!/usr/bin/env bash
# gpu-run-watch.sh - fire a remote command on a herdr pane and BLOCK until a
# user-supplied sentinel pattern appears in the pane output, then print the
# recent output once.
#
# This is the sibling of gpu-run.sh. Use gpu-run.sh when you want a single
# command's own completion + output. Use gpu-run-watch.sh when you are waiting
# for a STATE or CONDITION to appear over time - a job reaching RUNNING, a log
# hitting a marker, a node finishing a drain, a training loop printing a step.
#
# Why it exists: the manual pattern is send-a-command, read-the-pane, repeat
# until the condition holds. Each read is a full model round-trip. A 65-poll
# wait measured ~12.7 min of pure round-trip latency. This collapses that whole
# loop into ONE blocking call: herdr wait output already blocks server-side
# until the pattern matches, so the model spends zero round-trips waiting.
#
# Usage:
#   gpu-run-watch.sh <pane_id> "<remote command>" "<sentinel regex>" [--timeout-ms N] [--lines N]
#     <pane_id>        local herdr pane bound to the remote shell (re-discover it;
#                      herdr pane ids are not durable - see gpu-pane-herdr-control skill).
#     "<remote command>"  command to fire before watching; pass "" to watch an
#                      already-running stream without sending anything new.
#     "<sentinel regex>"  pattern to block on; the call returns as soon as it appears.
#     --timeout-ms N   max wait (default 300000 = 5 min; watches run longer than one command).
#     --lines N        pane scrollback lines to print on return (default 400).
#
# For a poll-until-true condition, make the command a remote wait-loop that
# prints the sentinel exactly when the condition holds, e.g.:
#   gpu-run-watch.sh <pane> \
#     "until squeue -h -n myjob | grep -q ' R '; do sleep 5; done; printf 'WATCH_OK\n'" \
#     "WATCH_OK" --timeout-ms 600000
#
# Exit: 0 if the sentinel matched (output printed); 1 on timeout (recent output
# still printed to stdout, with a TIMEOUT note on stderr) so the caller can act.
set -uo pipefail

pane="${1:?usage: gpu-run-watch.sh <pane_id> \"<cmd>\" \"<sentinel>\" [--timeout-ms N] [--lines N]}"; shift
cmd="${1?usage: gpu-run-watch.sh <pane_id> \"<cmd>\" \"<sentinel>\" [--timeout-ms N] [--lines N]}"; shift
sentinel="${1:?usage: gpu-run-watch.sh <pane_id> \"<cmd>\" \"<sentinel>\" [--timeout-ms N] [--lines N]}"; shift
timeout_ms=300000
lines=400
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout-ms) timeout_ms="${2:?}"; shift 2;;
    --lines)      lines="${2:?}"; shift 2;;
    *) echo "gpu-run-watch.sh: unknown arg: $1" >&2; exit 2;;
  esac
done

# Fire the command if one was given (it may run, stream, or loop); swallow all
# herdr CLI chatter so the agent pane stays clean.
if [ -n "$cmd" ]; then
  herdr pane run "$pane" "$cmd" >/dev/null 2>&1
fi

# ONE blocking wait, server-side, until the sentinel appears. No poll loop.
if herdr wait output "$pane" --match "$sentinel" --timeout "$timeout_ms" >/dev/null 2>&1; then
  herdr pane read "$pane" --source recent-unwrapped --lines "$lines" 2>/dev/null
  exit 0
else
  herdr pane read "$pane" --source recent-unwrapped --lines "$lines" 2>/dev/null
  echo "gpu-run-watch.sh: TIMEOUT waiting for /${sentinel}/ on ${pane} after ${timeout_ms}ms" >&2
  exit 1
fi
