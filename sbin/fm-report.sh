#!/usr/bin/env bash
# Append one status line to a crewmate/secondmate status file.
# Agents invoke this helper instead of running `echo "<line>" >> <file>`
# directly: the omp bash tool blocks a direct echo/cat redirection in an
# agent's own command, but it allows invoking a script that does the
# redirection internally. The supervising firstmate watches the status file
# (state/<id>.status) via fs.watch, so each appended line wakes it.
#
# Dependency-delivery contract (added 2026-07-15 after the witness-handoff
# incident: a producer's terminal event reached only its parent while the
# named consumer stayed blocked ~1h on an artifact that already existed):
#
#   Terminal fan-out. A line carrying `consumers=<file>[,<file>...]` is
#   appended to the primary status file AND to every named consumer status
#   file, so each consumer's own fs.watch fires. "Report to parent only"
#   can no longer suppress delivery to named consumers. Dependency-bearing
#   lines should also carry `producer=`, `artifact=`, and `event=<id>`.
#
#   Exactly-once. When a line carries `event=<id>`, delivery is idempotent
#   per destination file: a replayed event never appends twice, so duplicate
#   terminal events and replayed BLOCKED reports cannot storm a watcher.
#
#   BLOCKED validation. A line whose first token is BLOCKED must carry
#   `waiting_on=<artifact>`, `owner=`, and `callback=`; anything less is
#   rejected with exit 3 and nothing is recorded. If the awaited artifact
#   already exists, an `ARTIFACT_READY` wake line is appended in the same
#   invocation (before any other work can run), so a consumer blocked on an
#   existing artifact is woken immediately. Optional `waiting_on_sha=<sha256>`
#   pins artifact identity: a mismatch appends `ARTIFACT_STALE` and never a
#   ready wake.
#
# Plain lines without this grammar pass through byte-identical to the
# original single-append behavior.
# Usage: fm-report.sh <status-file> <status-line>
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: fm-report.sh <status-file> <status-line>" >&2
  exit 2
fi

primary=$1
line=$2

# Extract a `key=value` token from the line (first match; empty if absent).
token() {
  printf '%s\n' "$line" | tr ' ' '\n' | sed -n "s/^$1=//p" | head -n1
}

event_id=$(token event)

# Idempotent append: with an event id, never append the same marker+event to
# the same destination twice; without one, preserve original append semantics.
append_once() {
  # $1 = destination file, $2 = line to append
  mkdir -p "$(dirname "$1")"
  if [ -n "$event_id" ] && [ -f "$1" ]; then
    local marker
    case $2 in
      ARTIFACT_READY*) marker="ARTIFACT_READY" ;;
      ARTIFACT_STALE*) marker="ARTIFACT_STALE" ;;
      BLOCKED*)        marker="BLOCKED" ;;
      *)               marker="" ;;
    esac
    if [ -n "$marker" ]; then
      grep -F "event=$event_id" "$1" | grep -Fq "$marker" && return 0
    else
      grep -F "event=$event_id" "$1" | grep -Eqv '^ARTIFACT_(READY|STALE)' && return 0
    fi
  fi
  printf '%s\n' "$2" >> "$1"
}

# --- BLOCKED contract --------------------------------------------------------
case $line in
  BLOCKED*)
    waiting_on=$(token waiting_on)
    owner=$(token owner)
    callback=$(token callback)
    if [ -z "$waiting_on" ] || [ -z "$owner" ] || [ -z "$callback" ]; then
      echo "fm-report: malformed BLOCKED line: waiting_on=, owner=, and callback= are required" >&2
      exit 3
    fi
    append_once "$primary" "$line"
    if [ -e "$waiting_on" ]; then
      pinned_sha=$(token waiting_on_sha)
      if [ -n "$pinned_sha" ]; then
        actual_sha=$(shasum -a 256 "$waiting_on" | cut -d' ' -f1)
        if [ "$actual_sha" != "$pinned_sha" ]; then
          append_once "$primary" "ARTIFACT_STALE waiting_on=$waiting_on expected=$pinned_sha actual=$actual_sha event=$event_id"
          exit 0
        fi
      fi
      # The awaited artifact already exists: wake the blocked consumer now.
      append_once "$primary" "ARTIFACT_READY waiting_on=$waiting_on owner=$owner callback=$callback event=$event_id"
    fi
    exit 0
    ;;
esac

# --- ordinary append + terminal fan-out ---------------------------------------
append_once "$primary" "$line"

consumers=$(token consumers)
if [ -n "$consumers" ]; then
  IFS=',' read -r -a dests <<< "$consumers"
  for dest in "${dests[@]}"; do
    [ -n "$dest" ] || continue
    append_once "$dest" "$line"
  done
fi
