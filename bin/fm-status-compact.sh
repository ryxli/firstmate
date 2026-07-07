#!/usr/bin/env bash
# fm-status-compact.sh - compact a state/<name>.status file.
#
# Keeps only the newest lane (everything after the last superseded terminal
# line), preserving any needs-decision/blocked lines that fall inside the
# current lane.  Writes "compacted <date>: history archived" as the first line.
# Archived lines are appended to state/.status-archive/<name>.<date>.log.
#
# A done/failed line is "superseded" when at least one more done/failed line
# follows it; the final done/failed in a file is never superseded.
#
# Conservative: never touches a file whose last non-blank line is
# needs-decision: or blocked:.
#
# Usage:
#   fm-status-compact.sh <name>
#       Compact state/<name>.status.
#   fm-status-compact.sh --all
#       Compact every state/*.status whose mtime is older than 7 days,
#       skipping files that end with needs-decision:/blocked:.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

TODAY="$(date +%Y-%m-%d)"
ALL=0
POS=()

for _a in "$@"; do
  case "$_a" in
    --all) ALL=1 ;;
    --*) printf 'error: unknown option %s\n' "$_a" >&2; exit 1 ;;
    *) POS+=("$_a") ;;
  esac
done

# compact_file <path>
compact_file() {
  local file="$1"
  local name
  name="$(basename "$file" .status)"

  # Load all lines (including blanks) into array
  local -a lines=()
  local _ln
  while IFS= read -r _ln || [ -n "$_ln" ]; do
    lines+=("$_ln")
  done < "$file"

  local nlines="${#lines[@]}"
  (( nlines > 0 )) || return 0

  # Find last non-blank line index
  local last_nb=-1
  local i
  for (( i = nlines - 1; i >= 0; i-- )); do
    if [[ -n "${lines[$i]}" ]]; then
      last_nb=$i
      break
    fi
  done
  (( last_nb >= 0 )) || return 0

  # Conservative: refuse if last non-blank line is needs-decision or blocked
  if [[ "${lines[$last_nb]}" == needs-decision:* || "${lines[$last_nb]}" == blocked:* ]]; then
    printf 'skip %s: last line is needs-decision/blocked\n' "$name"
    return 0
  fi

  # Find archive boundary: last done/failed line that has at least one more
  # done/failed line after it (making it superseded).
  local boundary=-1
  local j found
  for (( i = 0; i < nlines; i++ )); do
    [[ "${lines[$i]}" == done:* || "${lines[$i]}" == failed:* ]] || continue
    found=0
    for (( j = i + 1; j < nlines; j++ )); do
      if [[ "${lines[$j]}" == done:* || "${lines[$j]}" == failed:* ]]; then
        found=1
        break
      fi
    done
    (( found )) && boundary=$i
  done

  # Nothing to archive (file has only one terminal line or no terminal lines)
  if (( boundary < 0 )); then
    printf 'skip %s: nothing to archive\n' "$name"
    return 0
  fi

  # Append archived lines to the archive log
  local archive_dir="$STATE/.status-archive"
  mkdir -p "$archive_dir"
  local archive="$archive_dir/${name}.${TODAY}.log"
  for (( i = 0; i <= boundary; i++ )); do
    printf '%s\n' "${lines[$i]}"
  done >> "$archive"

  # Rewrite file: header + current lane (lines after boundary)
  {
    printf 'compacted %s: history archived\n' "$TODAY"
    for (( i = boundary + 1; i < nlines; i++ )); do
      printf '%s\n' "${lines[$i]}"
    done
  } > "$file"

  printf 'compacted %s: archived %d lines -> %s\n' "$name" "$((boundary + 1))" "$archive"
}

if (( ALL )); then
  [[ ${#POS[@]} -eq 0 ]] || { printf 'error: --all takes no positional arguments\n' >&2; exit 1; }
  if [ -d "$STATE" ]; then
    while IFS= read -r _f; do
      compact_file "$_f"
    done < <(find "$STATE" -maxdepth 1 -name '*.status' -mtime +7 2>/dev/null)
  fi
else
  [[ ${#POS[@]} -eq 1 ]] || { printf 'usage: fm-status-compact.sh [--all] <name>\n' >&2; exit 1; }
  _status_file="$STATE/${POS[0]}.status"
  [[ -f "$_status_file" ]] || { printf 'error: %s not found\n' "$_status_file" >&2; exit 1; }
  compact_file "$_status_file"
fi
