#!/usr/bin/env bash
# Check or repair shared-code links in a symlink-backed secondmate home.
set -eu

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/fm-root-lib.sh
. "$SCRIPT_DIR/fm-root-lib.sh"
fm_init_roots "${BASH_SOURCE[0]}"

usage() {
  echo "usage: fm-home-link.sh <home> --check" >&2
  echo "       fm-home-link.sh <home> --repair" >&2
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac
[ $# -eq 2 ] || { usage; exit 1; }
HOME_ARG=$1
MODE_ARG=$2
case "$MODE_ARG" in
  --check) MODE=check ;;
  --repair) MODE=repair ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 1 ;;
esac

SUB_HOME_MARKER=.fm-secondmate-home
HOME_PATH=$(fm_normalize_path "$HOME_ARG")
CODE_ROOT=$(fm_realpath_existing "$FM_ROOT")
RESULT=ok

status_line() {
  printf '%s=%s\n' "$1" "$STATUS"
}

set_block() {
  RESULT=blocked
  STATUS="blocked:$1"
}

path_is_ancestor_of() {
  local ancestor=$1 path=$2
  [ -n "$ancestor" ] || return 1
  [ -n "$path" ] || return 1
  [ "$ancestor" != "$path" ] || return 1
  case "$path" in "$ancestor"/*) return 0 ;; esac
  return 1
}

resolve_link_target() {
  local link=$1 target parent
  target=$(readlink "$link") || return 1
  case "$target" in
    /*) fm_normalize_path "$target" ;;
    *) parent=$(dirname "$link"); fm_normalize_path "$parent/$target" ;;
  esac
}

link_points_to() {
  local link=$1 expected=$2 actual expected_real
  [ -L "$link" ] || return 1
  actual=$(resolve_link_target "$link") || return 1
  expected_real=$(fm_normalize_path "$expected")
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
  [ -f "$1" ] && [ ! -s "$1" ] && [ ! -L "$1" ]
}

empty_directory() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]
}

repair_link() {
  local name target link reason
  name=$1
  target=$2
  link=$HOME_PATH/$name
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
    if [ -d "$link" ]; then
      reason=non-empty-directory
    else
      reason=non-empty-file
    fi
    set_block "$reason"
    return 0
  fi

  if [ "$name" = CLAUDE.md ]; then
    ln -s AGENTS.md "$link" 2>/dev/null || { set_block repair-failed; return 0; }
  else
    [ -e "$target" ] || { set_block missing-target; return 0; }
    ln -s "$target" "$link" 2>/dev/null || { set_block repair-failed; return 0; }
  fi
  STATUS=repaired
}

check_operational_dir() {
  local name dir abs_dir
  name=$1
  dir=$HOME_PATH/$name
  if [ ! -e "$dir" ]; then
    set_block missing
    return 0
  fi
  if [ ! -d "$dir" ]; then
    set_block not-directory
    return 0
  fi
  abs_dir=$(cd -P "$dir" && pwd) || { set_block unresolved; return 0; }
  if [ "$abs_dir" = "$HOME_PATH" ] || path_is_ancestor_of "$HOME_PATH" "$abs_dir"; then
    STATUS=ok
  else
    set_block escapes-home
  fi
}

printf 'home=%s\n' "$HOME_PATH"
printf 'mode=%s\n' "$MODE"

if [ ! -d "$HOME_PATH" ]; then
  set_block missing
  status_line home.status
  status_line result
  exit 1
fi

if [ -L "$HOME_PATH/$SUB_HOME_MARKER" ]; then
  set_block symlink
  status_line marker
elif [ -f "$HOME_PATH/$SUB_HOME_MARKER" ]; then
  STATUS=ok
  status_line marker
else
  set_block missing
  status_line marker
fi

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
