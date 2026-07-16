#!/usr/bin/env bash
# Shared ship omp-extension symlink logic.
# Sourced by fm-home-seed.sh (transactional seed) and fm-link-ship-ext.sh (CLI);
# not meant to be executed directly.
#
# fm_link_ship_extensions <home> <ext_src>
#   Install a symlink per entry under <ext_src> (the canonical .omp/extensions/
#   dir) into <home>/.omp/extensions/<name>. Idempotent: a correct symlink is a
#   no-op, a stale/wrong symlink is refreshed, and a real file the home provides
#   itself is left untouched. Callers own their own canonical-path resolution of
#   <ext_src> so each keeps its resolution semantics.
#
#   Optional input globals:
#     FM_SHIP_EXT_VERBOSE=1        print a per-entry line to stdout
#     FM_SHIP_EXT_TRACK_FILE=path  append every created/refreshed link path,
#                                  for transactional rollback
#   Output globals (always reset, then set):
#     FM_SHIP_EXT_SRC_MISSING  1 if <ext_src> is absent (no work done)
#     FM_SHIP_EXT_DST_EXISTED  1 if <home>/.omp/extensions existed beforehand
#     FM_SHIP_EXT_CHANGED      count of links created or refreshed
#     FM_SHIP_EXT_SKIPPED      count of real files left untouched
#     FM_SHIP_EXT_NOOP         count of already-correct links
#   Returns 0.
fm_link_ship_extensions() {
  local home=$1 ext_src=$2
  local ext_dst entry name link_path canonical existing_target track
  track="${FM_SHIP_EXT_TRACK_FILE:-/dev/null}"
  FM_SHIP_EXT_SRC_MISSING=0
  FM_SHIP_EXT_DST_EXISTED=0
  FM_SHIP_EXT_CHANGED=0
  FM_SHIP_EXT_SKIPPED=0
  FM_SHIP_EXT_NOOP=0

  if [ ! -d "$ext_src" ]; then
    FM_SHIP_EXT_SRC_MISSING=1
    return 0
  fi

  ext_dst="$home/.omp/extensions"
  if [ -d "$ext_dst" ]; then
    FM_SHIP_EXT_DST_EXISTED=1
  else
    FM_SHIP_EXT_DST_EXISTED=0
    mkdir -p "$ext_dst"
  fi

  for entry in "$ext_src"/*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    link_path="$ext_dst/$name"
    canonical="$entry"

    if [ -e "$link_path" ] && [ ! -L "$link_path" ]; then
      [ "${FM_SHIP_EXT_VERBOSE:-0}" = 1 ] && printf 'ship-ext: skip real file %s\n' "$name"
      FM_SHIP_EXT_SKIPPED=$((FM_SHIP_EXT_SKIPPED + 1))
      continue
    fi

    if [ -L "$link_path" ]; then
      existing_target=$(readlink "$link_path")
      if [ "$existing_target" = "$canonical" ]; then
        FM_SHIP_EXT_NOOP=$((FM_SHIP_EXT_NOOP + 1))
        continue
      fi
      rm -f "$link_path"
      ln -s "$canonical" "$link_path"
      printf '%s\n' "$link_path" >> "$track"
      [ "${FM_SHIP_EXT_VERBOSE:-0}" = 1 ] && printf 'ship-ext: refreshed %s -> %s\n' "$name" "$canonical"
      FM_SHIP_EXT_CHANGED=$((FM_SHIP_EXT_CHANGED + 1))
    else
      ln -s "$canonical" "$link_path"
      printf '%s\n' "$link_path" >> "$track"
      [ "${FM_SHIP_EXT_VERBOSE:-0}" = 1 ] && printf 'ship-ext: linked %s -> %s\n' "$name" "$canonical"
      FM_SHIP_EXT_CHANGED=$((FM_SHIP_EXT_CHANGED + 1))
    fi
  done
  return 0
}
