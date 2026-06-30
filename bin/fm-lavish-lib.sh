#!/usr/bin/env bash
# fm-lavish-lib.sh - shared primitives for the Lavish render-delegation flow.
#
# The render-delegation flow keeps firstmate (and any crewmate) off the Lavish
# long-poll: a dedicated steward worker process (bin/fm-lavish-steward.sh) holds
# `lavish-axi poll <file>` for each open session and relays the captain's feedback
# back to the originating agent's pane, so the agent's own thread is never tied up
# polling. This library is the seam those scripts share.
#
# Everything here mirrors lavish-axi's own client math so a key/URL we derive in
# bash addresses the exact same session the CLI would:
#   - canonical file  = realpath(abs path)            (CLI canonicalFile)
#   - session key     = sha256(canonical).slice(0,16) (CLI sessionKey)
#   - base URL        = http://<host>:<port>          (CLI clientHost/defaultPort)
# We talk to two surfaces deliberately:
#   - the steward POLLS via the official `bunx lavish-axi poll` CLI (the stable,
#     supported long-poll path; it is the ONLY consumer of a session's feedback);
#   - a reply WRITES via the HTTP `/api/<key>/agent-reply` endpoint, which only
#     appends an agent message and never consumes feedback, so an agent reply can
#     never race the steward's blocking poll for the same prompts.
#
# All functions are set -u / set -e safe.

# fm_lavish_canonical <file>: print the canonical absolute path lavish-axi keys a
# session by. Resolves symlinks like the CLI's realpath(); falls back to a plain
# abs-path when the file does not resolve (caller validates existence).
fm_lavish_canonical() {
  local f=$1
  if command -v realpath >/dev/null 2>&1; then
    realpath "$f" 2>/dev/null && return 0
  fi
  # Portable fallback: resolve dir with `cd -P`, append basename.
  local dir base
  dir=$(cd "$(dirname "$f")" 2>/dev/null && pwd -P) || { printf '%s\n' "$f"; return 0; }
  base=$(basename "$f")
  printf '%s/%s\n' "$dir" "$base"
}

# fm_lavish_key <canonical-path>: print the 16-hex session key. Mirrors the CLI's
# sessionKey: sha256 of the path string, first 16 hex chars. Works with shasum
# (macOS) or sha256sum (Linux).
fm_lavish_key() {
  local path=$1 hex
  if command -v shasum >/dev/null 2>&1; then
    hex=$(printf '%s' "$path" | shasum -a 256 | cut -d' ' -f1)
  elif command -v sha256sum >/dev/null 2>&1; then
    hex=$(printf '%s' "$path" | sha256sum | cut -d' ' -f1)
  else
    return 1
  fi
  printf '%s\n' "${hex:0:16}"
}

# fm_lavish_base_url: print the base URL of the local Lavish server, honoring the
# same env the CLI reads (LAVISH_AXI_HOST, LAVISH_AXI_PORT). A wildcard bind
# address maps to a loopback client host, and IPv6 hosts are bracketed for URLs.
fm_lavish_base_url() {
  local host port
  host=${LAVISH_AXI_HOST:-127.0.0.1}
  case "$host" in
    0.0.0.0) host=127.0.0.1 ;;
    ::) host=::1 ;;
  esac
  case "$host" in
    *:*) host="[$host]" ;; # bracket bare IPv6
  esac
  port=${LAVISH_AXI_PORT:-4387}
  printf 'http://%s:%s\n' "$host" "$port"
}

# fm_lavish_urlencode <str>: percent-encode a string for a query parameter.
fm_lavish_urlencode() {
  python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1], safe=""))' "$1" 2>/dev/null
}

# fm_lavish_state_dir: the per-home directory where steward metadata + relayed
# feedback live (under the firstmate state dir, gitignored). Honors the same
# FM_HOME / FM_STATE_OVERRIDE resolution as the rest of bin/.
fm_lavish_state_dir() {
  local script_dir root home state
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="${FM_ROOT_OVERRIDE:-$(cd "$script_dir/.." && pwd)}"
  home="${FM_HOME:-${FM_ROOT_OVERRIDE:-$root}}"
  state="${FM_STATE_OVERRIDE:-$home/state}"
  printf '%s/lavish\n' "$state"
}

# fm_lavish_server_up: 0 if the local Lavish server answers /health, else 1.
fm_lavish_server_up() {
  local base
  base=$(fm_lavish_base_url)
  curl -fsS --max-time 3 "$base/health" >/dev/null 2>&1
}

# fm_lavish_steward_alive <key>: 0 if a steward for <key> is recorded and its pid
# is still running, else 1. Used for idempotent open and recovery.
fm_lavish_steward_alive() {
  local key=$1 dir pid
  dir=$(fm_lavish_state_dir)
  pid=$(grep '^pid=' "$dir/$key.steward" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# fm_lavish_kill_polls <canonical-file>: terminate any `lavish-axi poll <file>`
# process for this session. Reaps an orphaned poll left behind by a hard-crashed
# steward (one that could not run its TERM trap) before a fresh steward starts,
# so exactly one poll ever owns a session's feedback - two pollers would race and
# one would silently consume and drop a feedback event. Callers MUST first ensure
# no live steward owns the session. Matches the canonical path as a fixed string,
# so paths with regex metacharacters are handled safely.
fm_lavish_kill_polls() {
  local file=$1 pid
  for pid in $(pgrep -f "lavish-axi poll" 2>/dev/null); do
    if ps -o command= -p "$pid" 2>/dev/null | grep -Fq "$file"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
