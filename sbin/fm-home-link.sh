#!/usr/bin/env bash
# Check or repair the shared-code links in a symlink-backed secondmate home.
# Operational state remains local to the home; only executable/instruction
# surfaces are linked to the firstmate code root.
set -eu

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_CODE_ROOT_OVERRIDE:-${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}}"
SUB_HOME_MARKER=.fm-secondmate-home

usage() {
  echo "usage: fm-home-link.sh <home> --check" >&2
  echo "       fm-home-link.sh <home> --repair" >&2
}

[ $# -eq 2 ] || { usage; exit 1; }
HOME_ARG=$1
case "$2" in
  --check) MODE=check ;;
  --repair) MODE=repair ;;
  *) usage; exit 1 ;;
esac

normalize_existing_dir() {
  [ -d "$1" ] || return 1
  cd -P "$1" && pwd
}

normalize_path() {
  local path=$1 parent base
  if [ -e "$path" ] || [ -L "$path" ]; then
    cd -P "$(dirname "$path")" && printf '%s/%s\n' "$(pwd)" "$(basename "$path")"
    return 0
  fi
  parent=$(dirname "$path")
  base=$(basename "$path")
  cd -P "$parent" && printf '%s/%s\n' "$(pwd)" "$base"
}

path_is_descendant() {
  local root=$1 path=$2
  [ "$root" != "$path" ] || return 1
  case "$path" in "$root"/*) return 0 ;; esac
  return 1
}

resolve_link_target() {
  local link=$1 target parent
  target=$(readlink "$link") || return 1
  case "$target" in
    /*) normalize_path "$target" ;;
    *) parent=$(dirname "$link"); normalize_path "$parent/$target" ;;
  esac
}

link_points_to() {
  local link=$1 expected=$2 actual expected_real
  [ -L "$link" ] || return 1
  actual=$(resolve_link_target "$link") || return 1
  expected_real=$(normalize_path "$expected") || return 1
  [ "$actual" = "$expected_real" ]
}

claude_link_ok() {
  local link=$1
  [ -L "$link" ] || return 1
  link_points_to "$link" "$HOME_PATH/AGENTS.md" && return 0
  link_points_to "$link" "$CODE_ROOT/AGENTS.md" && return 0
  link_points_to "$link" "$CODE_ROOT/CLAUDE.md" && return 0
  return 1
}

empty_regular_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ ! -s "$1" ]
}

empty_directory() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  (
    shopt -s nullglob dotglob
    local entries=("$1"/*)
    [ "${#entries[@]}" -eq 0 ]
  )
}

RESULT=ok
STATUS=ok
set_block() {
  RESULT=blocked
  STATUS="blocked:$1"
}
status_line() { printf '%s=%s\n' "$1" "$STATUS"; }

repair_link() {
  local name=$1 target=$2 link=$HOME_PATH/$1 reason
  if [ "$name" = CLAUDE.md ]; then
    if claude_link_ok "$link"; then STATUS=ok; return 0; fi
  elif link_points_to "$link" "$target"; then
    STATUS=ok
    return 0
  fi

  if [ "$MODE" = check ]; then
    set_block wrong-link
    return 0
  fi

  if [ -L "$link" ]; then
    rm -f "$link"
  elif [ ! -e "$link" ]; then
    :
  elif empty_regular_file "$link"; then
    rm -f "$link"
  elif empty_directory "$link"; then
    rmdir "$link"
  else
    if [ -d "$link" ]; then reason=non-empty-directory; else reason=non-empty-file; fi
    set_block "$reason"
    return 0
  fi

  if [ "$name" = CLAUDE.md ]; then
    ln -s AGENTS.md "$link" || { set_block repair-failed; return 0; }
  else
    [ -e "$target" ] || { set_block missing-target; return 0; }
    ln -s "$target" "$link" || { set_block repair-failed; return 0; }
  fi
  STATUS=repaired
}

check_operational_dir() {
  local name=$1 dir=$HOME_PATH/$1 abs_dir
  if [ ! -e "$dir" ]; then
    set_block missing
    return 0
  fi
  if [ ! -d "$dir" ]; then
    set_block not-directory
    return 0
  fi
  abs_dir=$(normalize_existing_dir "$dir") || { set_block unresolved; return 0; }
  if path_is_descendant "$HOME_PATH" "$abs_dir"; then STATUS=ok; else set_block escapes-home; fi
}

HOME_PATH=$(normalize_existing_dir "$HOME_ARG") || {
  printf 'home=%s\nmode=%s\nhome.status=blocked:missing\nresult=blocked\n' "$HOME_ARG" "$MODE"
  exit 1
}
CODE_ROOT=$(normalize_existing_dir "$FM_ROOT") || {
  echo "error: firstmate code root is not a directory: $FM_ROOT" >&2
  exit 1
}

printf 'home=%s\nmode=%s\n' "$HOME_PATH" "$MODE"
if [ -L "$HOME_PATH/$SUB_HOME_MARKER" ]; then
  set_block symlink
elif [ -f "$HOME_PATH/$SUB_HOME_MARKER" ]; then
  STATUS=ok
else
  set_block missing
fi
status_line marker

for op in data state config projects; do
  check_operational_dir "$op"
  status_line "operational.$op"
done

repair_link AGENTS.md "$CODE_ROOT/AGENTS.md"; status_line link.AGENTS.md
repair_link CLAUDE.md "$CODE_ROOT/CLAUDE.md"; status_line link.CLAUDE.md
repair_link bin "$CODE_ROOT/bin"; status_line link.bin
repair_link .agents "$CODE_ROOT/.agents"; status_line link..agents
repair_link .claude "$CODE_ROOT/.claude"; status_line link..claude
repair_link .omp "$CODE_ROOT/.omp"; status_line link..omp
repair_link .tasks.toml "$CODE_ROOT/.tasks.toml"; status_line link..tasks.toml
STATUS=$RESULT
status_line result
[ "$RESULT" = ok ]
