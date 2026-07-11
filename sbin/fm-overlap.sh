#!/usr/bin/env bash
# Detect path overlap between in-flight tasks.
# Usage: fm-overlap.sh <id1> <id2> [id3...]
#        fm-overlap.sh --paths <csv> --paths <csv> [...]
#
# In task-id mode each task's scope is read from:
#   data/<id>/brief.md  - lines under "# Scope-paths" (one path per line)
#   state/<id>.meta     - project= field (repo-level coarse scope; fallback)
# Coarse rule (AGENTS.md section 7): same repo + no declared Scope-paths = overlap.
# Cross-repo tasks never overlap regardless of declared paths.
#
# Prints "overlap: <a> <b> <shared>" for every overlapping pair.
# Exits 1 on any overlap, 0 if all pairs are disjoint.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

die()   { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() {
  printf 'usage: fm-overlap.sh <id1> <id2> [id3...]\n' >&2
  printf '       fm-overlap.sh --paths <csv> --paths <csv> [...]\n' >&2
  exit 2
}

# ---- argument parsing ----
PATHS_MODE=0
PATH_SETS=()
TASK_IDS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --paths)
      shift; [ "$#" -gt 0 ] || usage
      PATHS_MODE=1
      PATH_SETS+=("$1")
      shift
      ;;
    -h|--help) usage ;;
    -*) printf 'error: unknown flag: %s\n' "$1" >&2; usage ;;
    *)  TASK_IDS+=("$1"); shift ;;
  esac
done

if [ "$PATHS_MODE" -eq 1 ] && [ "${#TASK_IDS[@]}" -gt 0 ]; then
  die "cannot mix --paths and task ids"
fi
if [ "$PATHS_MODE" -eq 1 ]; then
  [ "${#PATH_SETS[@]}" -ge 2 ] || { printf 'error: --paths mode requires at least two sets\n' >&2; usage; }
else
  [ "${#TASK_IDS[@]}" -ge 2 ] || { printf 'error: at least two task ids required\n' >&2; usage; }
fi

# ---- helpers ----

# _path_pair_overlap <a> <b>
# Returns 0 and prints the more-general overlapping path if one is a prefix
# of the other (or they are equal). Returns 1 if they are disjoint.
_path_pair_overlap() {
  local a="${1%/}" b="${2%/}"
  [ -n "$a" ] && [ -n "$b" ] || return 1
  if [ "$a" = "$b" ]; then
    printf '%s\n' "$a"; return 0
  fi
  if [ "${b#"${a}/"}" != "$b" ]; then   # a is a prefix of b
    printf '%s\n' "$a"; return 0
  fi
  if [ "${a#"${b}/"}" != "$a" ]; then   # b is a prefix of a
    printf '%s\n' "$b"; return 0
  fi
  return 1
}

# _sets_overlap <newline-sep-paths-a> <newline-sep-paths-b>
# Returns 0 and prints the shared path on first overlap found; 1 if disjoint.
_sets_overlap() {
  local pa pb shared
  while IFS= read -r pa; do
    [ -n "$pa" ] || continue
    while IFS= read -r pb; do
      [ -n "$pb" ] || continue
      shared=$(_path_pair_overlap "$pa" "$pb") && { printf '%s\n' "$shared"; return 0; } || true
    done <<< "$2"
  done <<< "$1"
  return 1
}

# ---- --paths mode ----
if [ "$PATHS_MODE" -eq 1 ]; then
  rc=0
  n="${#PATH_SETS[@]}"
  i=0
  while [ "$i" -lt "$((n - 1))" ]; do
    j="$((i + 1))"
    while [ "$j" -lt "$n" ]; do
      pa=$(printf '%s' "${PATH_SETS[$i]}" | tr ',' '\n')
      pb=$(printf '%s' "${PATH_SETS[$j]}" | tr ',' '\n')
      shared=$(_sets_overlap "$pa" "$pb") && {
        printf 'overlap: paths%d paths%d %s\n' "$((i+1))" "$((j+1))" "$shared"
        rc=1
      } || true
      j="$((j + 1))"
    done
    i="$((i + 1))"
  done
  exit "$rc"
fi

# ---- task-id mode ----

# _read_scope <id>
# Sets _SCOPE_REPO (repo basename) and _SCOPE_PATHS (newline-separated declared paths).
# _SCOPE_PATHS empty means coarse (whole-repo scope).
# Dies if neither source provides any scope information.
_read_scope() {
  local id="$1"
  _SCOPE_REPO=""
  _SCOPE_PATHS=""

  local meta="$STATE/$id.meta"
  local brief="$DATA/$id/brief.md"

  # Repo from meta: project= line.
  if [ -f "$meta" ]; then
    local proj
    proj=$(grep '^project=' "$meta" 2>/dev/null | head -1 | cut -d= -f2-) || true
    [ -n "$proj" ] && _SCOPE_REPO=$(basename "$proj")
  fi

  # Declared scope from brief.md: lines under "# Scope-paths" until next heading.
  if [ -f "$brief" ]; then
    local in_sec=0 collected=""
    while IFS= read -r line; do
      if [ "$in_sec" -eq 1 ]; then
        case "$line" in
          '#'*) break ;;
          '')   continue ;;
          *)    collected="${collected}${line}"$'\n' ;;
        esac
      else
        [ "$line" = "# Scope-paths" ] && in_sec=1
      fi
    done < "$brief"
    _SCOPE_PATHS="$collected"
  fi

  [ -n "$_SCOPE_REPO" ] || [ -n "$_SCOPE_PATHS" ] || \
    die "task '$id': no scope found (need data/$id/brief.md with '# Scope-paths' or state/$id.meta with project=)"
}

# ---- pairwise comparison ----
rc=0
n="${#TASK_IDS[@]}"
i=0
while [ "$i" -lt "$((n - 1))" ]; do
  id_a="${TASK_IDS[$i]}"
  _read_scope "$id_a"
  repo_a="$_SCOPE_REPO"
  paths_a="$_SCOPE_PATHS"

  j="$((i + 1))"
  while [ "$j" -lt "$n" ]; do
    id_b="${TASK_IDS[$j]}"
    _read_scope "$id_b"
    repo_b="$_SCOPE_REPO"
    paths_b="$_SCOPE_PATHS"

    # Cross-repo tasks never overlap (different repos always run in parallel).
    if [ -n "$repo_a" ] && [ -n "$repo_b" ] && [ "$repo_a" != "$repo_b" ]; then
      j="$((j + 1))"; continue
    fi

    # Same repo (or repo unknown on one side): apply coarse or declared-path rules.
    if [ -z "$paths_a" ] || [ -z "$paths_b" ]; then
      # Coarse: at least one task holds the whole repo.
      shared="${repo_a:-${repo_b:-<repo>}}"
      printf 'overlap: %s %s %s\n' "$id_a" "$id_b" "$shared"
      rc=1
    else
      shared=$(_sets_overlap "$paths_a" "$paths_b") && {
        printf 'overlap: %s %s %s\n' "$id_a" "$id_b" "$shared"
        rc=1
      } || true
    fi

    j="$((j + 1))"
  done
  i="$((i + 1))"
done
exit "$rc"
