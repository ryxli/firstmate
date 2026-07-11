#!/usr/bin/env bash
# gpu-run.sh - drive a remote herdr pane and print ONLY the clean command output.
#
# Collapses the verbose three-call control pattern -
#   herdr pane run <pane> "...; printf SENTINEL"
#   herdr wait output <pane> --match SENTINEL
#   herdr pane read <pane> --source recent-unwrapped
# - which renders as 3 tool cards plus raw `{"id":"cli:..."}` JSON blobs plus
# leaked sentinels in the agent pane the captain watches, into ONE quiet command
# whose stdout is just the remote command's output: no herdr JSON, no sentinels,
# no triple card. The remote pane is also scrubbed after capture so the visible
# shell does not retain gpu-run plumbing or command output.
#
# Usage: gpu-run.sh <pane_id> "<remote command>" [--timeout-ms N] [--lines N]
#   <pane_id>   the local herdr pane bound to the remote shell (re-discover it;
#               herdr pane ids are not durable - see gpu-pane-herdr-control skill).
#   --timeout-ms  max wait for the command to finish (default 60000).
#   --lines       pane scrollback lines to scan; raise for large multi-node output
#                 (default 400).
#
# Arbitrary quoting in <remote command> is preserved (it is passed through as a
# single argument). Keep one GPU/sync lane at a time per the skill rules.
set -uo pipefail

pane="${1:?usage: gpu-run.sh <pane_id> \"<cmd>\" [--timeout-ms N] [--lines N]}"; shift
cmd="${1:?usage: gpu-run.sh <pane_id> \"<cmd>\" [--timeout-ms N] [--lines N]}"; shift
timeout_ms=60000
lines=400
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout-ms) timeout_ms="${2:?}"; shift 2;;
    --lines)      lines="${2:?}"; shift 2;;
    *) echo "gpu-run.sh: unknown arg: $1" >&2; exit 2;;
  esac
done

# Unique run id. START/END tokens are assembled remotely via printf %s so the
# literal end token never appears in the echoed command line (otherwise
# `wait output` could match the submitted line before the command finishes).
id="$$_$(date +%s)_${RANDOM}"
start_tok="GRUN_START_${id}"
end_tok="GRUN_END_${id}"
remote_cmd="__grun_dir=\$(mktemp -d /tmp/gpu-run.XXXXXX) || exit 1; ( ${cmd} ) >\"\${__grun_dir}/out\" 2>&1; __grun_rc=\$?; printf '\\033[3J\\033[H\\033[2J'; printf 'GRUN_START_%s\n' '${id}'; cat \"\${__grun_dir}/out\"; printf 'GRUN_END_%s\n' '${id}'; rm -rf \"\${__grun_dir}\"; unset __grun_dir __grun_rc"

# Fire the scratch-wrapped command; swallow all herdr CLI chatter.
herdr pane run "$pane" "$remote_cmd" >/dev/null 2>&1
herdr wait output "$pane" --match "$end_tok" --timeout "$timeout_ms" >/dev/null 2>&1 || true

# Emit only the lines strictly between the markers (the command's real output),
# then scrub the visible pane so neither markers nor command output remain.
herdr pane read "$pane" --source recent-unwrapped --lines "$lines" 2>/dev/null \
  | awk -v s="$start_tok" -v e="$end_tok" '
      index($0, s) {grab=1; next}
      index($0, e) {grab=0}
      grab {print}
    '
herdr pane run "$pane" "printf '\\033[3J\\033[H\\033[2J'" >/dev/null 2>&1
