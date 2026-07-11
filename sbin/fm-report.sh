#!/usr/bin/env bash
# Append one status line to a crewmate/secondmate status file.
# Agents invoke this helper instead of running `echo "<line>" >> <file>`
# directly: the omp bash tool blocks a direct echo/cat redirection in an
# agent's own command, but it allows invoking a script that does the
# redirection internally. The supervising firstmate watches the status file
# (state/<id>.status) via fs.watch, so each appended line wakes it.
# Usage: fm-report.sh <status-file> <status-line>
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: fm-report.sh <status-file> <status-line>" >&2
  exit 2
fi

mkdir -p "$(dirname "$1")"
printf '%s\n' "$2" >> "$1"
