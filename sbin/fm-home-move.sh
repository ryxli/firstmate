#!/usr/bin/env bash
# Safely relocate a registered secondmate home and repoint its durable records.
#
# Usage: fm-home-move.sh <id> <new-home-path>
#
# The home must be seeded, inactive, and outside projects/. Herdr-managed
# homes move through herdr; their persisted workspace registration is removed
# afterwards because it is tied to the previous checkout path. Plain homes use
# git worktree move when registered as a linked worktree, otherwise mv.
set -eu

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sbin/fm-root-lib.sh
. "$SCRIPT_DIR/fm-root-lib.sh"
# shellcheck source=sbin/fm-identity-lib.sh
. "$SCRIPT_DIR/fm-identity-lib.sh"
fm_init_roots "${BASH_SOURCE[0]}"

SUB_HOME_MARKER=.fm-secondmate-home
REG="$DATA/secondmates.md"

usage() {
  echo "usage: fm-home-move.sh <id> <new-home-path>" >&2
}

path_is_ancestor_of() {
  local ancestor=$1 path=$2
  [ -n "$ancestor" ] || return 1
  [ -n "$path" ] || return 1
  [ "$ancestor" != "$path" ] || return 1
  case "$path" in
    "$ancestor"/*) return 0 ;;
  esac
  return 1
}

registry_line_for_id() {
  local id=$1 line found=0
  [ -f "$REG" ] || return 1
  while IFS= read -r line; do
    case "$line" in
      "- $id "*)
        if [ "$found" -eq 1 ]; then
          echo "error: duplicate secondmate registration for $id" >&2
          return 2
        fi
        printf '%s\n' "$line"
        found=1
        ;;
    esac
  done < "$REG"
  [ "$found" -eq 1 ]
}

registry_field() {
  local line=$1 field=$2
  case "$field" in
    home) printf '%s\n' "$line" | sed -n 's/^[^(]*(home: \([^;)]*\).*/\1/p' ;;
    workspace) printf '%s\n' "$line" | sed -n 's/^[^(]*(home: [^;)]*; workspace: \([^;)]*\).*/\1/p' ;;
    *) return 1 ;;
  esac
}

validate_safe_home_path() {
  local path=$1 label=$2 abs_root abs_active abs_projects
  abs_root=$(fm_realpath_existing "$FM_ROOT")
  abs_active=$(fm_normalize_path "$FM_HOME")
  abs_projects=$(fm_normalize_path "$PROJECTS")
  case "$path" in
    /) echo "error: $label cannot be the filesystem root" >&2; return 1 ;;
  esac
  if [ "$path" = "$abs_root" ] || [ "$path" = "$abs_active" ]; then
    echo "error: $label cannot be the firstmate repo or active home: $path" >&2
    return 1
  fi
  if path_is_ancestor_of "$path" "$abs_root" || path_is_ancestor_of "$path" "$abs_active" \
    || path_is_ancestor_of "$abs_root" "$path" || path_is_ancestor_of "$abs_active" "$path"; then
    echo "error: $label cannot overlap the firstmate repo or active home: $path" >&2
    return 1
  fi
  if [ "$path" = "$abs_projects" ] || path_is_ancestor_of "$abs_projects" "$path" || path_is_ancestor_of "$path" "$abs_projects"; then
    echo "error: $label cannot overlap projects/: $path" >&2
    return 1
  fi
}

validate_seeded_home() {
  local id=$1 home=$2 marker name dir abs_dir
  [ -d "$home" ] || { echo "error: registered home is not a directory: $home" >&2; return 1; }
  [ ! -L "$home/$SUB_HOME_MARKER" ] || { echo "error: secondmate marker must not be a symlink: $home/$SUB_HOME_MARKER" >&2; return 1; }
  [ -f "$home/$SUB_HOME_MARKER" ] || { echo "error: registered home is not seeded: missing $home/$SUB_HOME_MARKER" >&2; return 1; }
  marker=$(cat "$home/$SUB_HOME_MARKER" 2>/dev/null || true)
  [ "$marker" = "$id" ] || { echo "error: secondmate home $home is marked for ${marker:-unknown}, expected $id" >&2; return 1; }
  for name in data state config projects; do
    dir="$home/$name"
    [ -d "$dir" ] || { echo "error: secondmate $name directory is missing: $dir" >&2; return 1; }
    abs_dir=$(fm_realpath_existing "$dir") || return 1
    if ! path_is_ancestor_of "$home" "$abs_dir"; then
      echo "error: secondmate $name directory resolves outside the home: $dir" >&2
      return 1
    fi
  done
}

validate_target_home_assignment() {
  local id=$1 target=$2 line registered_id registered_home registered_abs
  [ -f "$REG" ] || return 1
  while IFS= read -r line; do
    case "$line" in
      "- "*)
        registered_id=${line#- }
        registered_id=${registered_id%% *}
        [ "$registered_id" = "$id" ] && continue
        registered_home=$(registry_field "$line" home || true)
        [ -n "$registered_home" ] || continue
        registered_abs=$(fm_normalize_path "$registered_home")
        if [ "$registered_abs" = "$target" ] \
          || path_is_ancestor_of "$registered_abs" "$target" \
          || path_is_ancestor_of "$target" "$registered_abs"; then
          echo "error: target home $target overlaps registered secondmate $registered_id at $registered_abs" >&2
          return 1
        fi
        ;;
    esac
  done < "$REG"
}

refuse_in_flight_work() {
  local home=$1 child_meta
  for child_meta in "$home/state"/*.meta; do
    [ -e "$child_meta" ] || continue
    echo "REFUSED: secondmate home still has in-flight work: $(basename "$child_meta")" >&2
    return 1
  done
}

is_linked_git_worktree() {
  local home=$1 listed line listed_path
  git -C "$home" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  listed=$(git -C "$home" -c core.quotePath=false worktree list --porcelain 2>/dev/null) || return 1
  while IFS= read -r line; do
    case "$line" in
      worktree\ *)
        listed_path=$(fm_normalize_path "${line#worktree }")
        [ "$listed_path" = "$home" ] && return 0
        ;;
    esac
  done <<EOF
$listed
EOF
  return 1
}

write_registry_with_new_home() {
  local id=$1 registered_home=$2 new_home=$3 tmp
  tmp=$(mktemp "${REG}.XXXXXX") || return 1
  if ! awk -v id="$id" -v registered_home="$registered_home" -v new_home="$new_home" '
    BEGIN { prefix = "- " id " "; old = "home: " registered_home ";"; replacement = "home: " new_home ";" }
    index($0, prefix) == 1 {
      if (updated++) exit 2
      position = index($0, old)
      if (!position) exit 3
      $0 = substr($0, 1, position - 1) replacement substr($0, position + length(old))
      sub(/workspace: [^;]*;[[:space:]]*/, "")
    }
    { print }
    END { exit updated == 1 ? 0 : 4 }
  ' "$REG" > "$tmp"; then
    rm -f "$tmp"
    echo "error: could not update secondmate registry for $id" >&2
    return 1
  fi
  mv "$tmp" "$REG"
}

write_meta_with_new_home() {
  local id new_home meta tmp
  id=$1
  new_home=$2
  meta="$STATE/$id.meta"
  [ -f "$meta" ] || return 0
  if ! grep -q '^kind=secondmate$' "$meta"; then
    echo "error: $meta is not secondmate metadata" >&2
    return 1
  fi
  tmp=$(mktemp "${meta}.XXXXXX") || return 1
  if ! awk -v home="$new_home" '
    $0 ~ /^home=/ { if (home_seen++) exit 2; print "home=" home; next }
    $0 ~ /^worktree=/ { if (worktree_seen++) exit 3; print "worktree=" home; next }
    $0 ~ /^workspace=/ { next }
    { print }
    END {
      if (home_seen != 1 || worktree_seen != 1) exit 4
    }
  ' "$meta" > "$tmp"; then
    rm -f "$tmp"
    echo "error: $meta must contain exactly one home= and worktree= line" >&2
    return 1
  fi
  mv "$tmp" "$meta"
}

[ "$#" -eq 2 ] || { usage; exit 2; }
ID=$1
NEW_HOME=$(fm_normalize_path "$2")

LINE=$(registry_line_for_id "$ID") || { echo "error: secondmate $ID is not registered in $REG" >&2; exit 1; }
REGISTERED_HOME=$(registry_field "$LINE" home || true)
WORKSPACE=$(registry_field "$LINE" workspace || true)
[ -n "$REGISTERED_HOME" ] || { echo "error: secondmate $ID has no registered home" >&2; exit 1; }
OLD_HOME=$(fm_normalize_path "$REGISTERED_HOME")

validate_safe_home_path "$OLD_HOME" "registered secondmate home"
validate_safe_home_path "$NEW_HOME" "target secondmate home"
validate_seeded_home "$ID" "$OLD_HOME"
validate_target_home_assignment "$ID" "$NEW_HOME"
refuse_in_flight_work "$OLD_HOME"
[ ! -e "$NEW_HOME" ] && [ ! -L "$NEW_HOME" ] || { echo "error: target path already exists: $NEW_HOME" >&2; exit 1; }

# Validate metadata before changing the filesystem, so a malformed live record
# cannot leave a successful move with an un-restartable supervisor record.
if [ -f "$STATE/$ID.meta" ]; then
  grep -q '^kind=secondmate$' "$STATE/$ID.meta" || { echo "error: $STATE/$ID.meta is not secondmate metadata" >&2; exit 1; }
  grep -q '^home=' "$STATE/$ID.meta" || { echo "error: $STATE/$ID.meta has no home= line" >&2; exit 1; }
  grep -q '^worktree=' "$STATE/$ID.meta" || { echo "error: $STATE/$ID.meta has no worktree= line" >&2; exit 1; }
fi

mkdir -p "$(dirname "$NEW_HOME")"
if [ -n "$WORKSPACE" ]; then
  herdr worktree move --workspace "$WORKSPACE" --path "$NEW_HOME" || {
    echo "error: herdr worktree move failed for workspace $WORKSPACE" >&2
    exit 1
  }
else
  if is_linked_git_worktree "$OLD_HOME"; then
    git -C "$OLD_HOME" worktree move "$OLD_HOME" "$NEW_HOME"
  else
    mv "$OLD_HOME" "$NEW_HOME"
  fi
fi

[ -d "$NEW_HOME" ] && [ ! -e "$OLD_HOME" ] || {
  echo "error: home move did not produce $NEW_HOME and remove $OLD_HOME; registry was not changed" >&2
  exit 1
}
write_registry_with_new_home "$ID" "$REGISTERED_HOME" "$NEW_HOME"
write_meta_with_new_home "$ID" "$NEW_HOME"

if [ -n "$WORKSPACE" ]; then
  printf 'cleared stale herdr workspace record: %s\n' "$WORKSPACE"
fi
printf 'moved secondmate %s: %s -> %s\n' "$ID" "$OLD_HOME" "$NEW_HOME"
printf 'restart when safe: %s\n' "$FM_ROOT/sbin/fm-spawn.sh $ID --secondmate"
