#!/usr/bin/env bash
# Install or refresh ship omp extension symlinks in a secondmate home.
# Each entry under .omp/extensions/ in this repo (canonical) is symlinked into
# <home>/.omp/extensions/<name>. An existing correct symlink is a no-op; a
# stale/wrong symlink is refreshed; a real file the home provides itself is left
# untouched.
#
# Usage:
#   fm-link-ship-ext.sh <id>         resolve home from data/secondmates.md
#   fm-link-ship-ext.sh <home-path>  use explicit home path
set -eu

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd -P)}"
FM_HOME="${FM_HOME:-$FM_ROOT}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
# shellcheck source=sbin/fm-ship-ext-lib.sh
. "$SCRIPT_DIR/fm-ship-ext-lib.sh"

usage() {
  echo "usage: fm-link-ship-ext.sh <id|home-path>" >&2
  exit 2
}

[ $# -eq 1 ] || usage
arg="$1"

# Canonical extensions dir (machine-portable within this repo).
EXT_SRC="$(cd "$SCRIPT_DIR/.." && pwd)/.omp/extensions"

home_for_id() {
  local id="$1" reg="$DATA/secondmates.md" line home
  [ -f "$reg" ] || { echo "error: secondmates registry not found at $reg" >&2; return 1; }
  line=$(grep -E "^- $id " "$reg" | head -1)
  [ -n "$line" ] || { echo "error: id '$id' not found in $reg" >&2; return 1; }
  home=$(printf '%s\n' "$line" | sed -n 's/.*home: \([^;)]*\).*/\1/p')
  [ -n "$home" ] || { echo "error: no home entry for id '$id' in $reg" >&2; return 1; }
  printf '%s\n' "$home"
}

# Resolve home: explicit path (absolute or relative) or id lookup.
case "$arg" in
  /*|./*|../*)  home="$arg" ;;
  *)
    if [ -d "$arg" ]; then
      home="$arg"
    else
      home=$(home_for_id "$arg")
    fi
    ;;
esac

[ -d "$home" ] || { echo "error: home directory does not exist: $home" >&2; exit 1; }

FM_SHIP_EXT_VERBOSE=1
FM_SHIP_EXT_TRACK_FILE=
fm_link_ship_extensions "$home" "$EXT_SRC"

if [ "${FM_SHIP_EXT_SRC_MISSING:-0}" = 1 ]; then
  printf 'ship-ext: no extensions dir at %s; nothing to do\n' "$EXT_SRC"
  exit 0
fi

if [ "$FM_SHIP_EXT_CHANGED" -eq 0 ] && [ "$FM_SHIP_EXT_SKIPPED" -eq 0 ]; then
  printf 'ship-ext: all links up to date (%d)\n' "$FM_SHIP_EXT_NOOP"
else
  printf 'ship-ext: done (%d linked/refreshed, %d skipped, %d already up to date)\n' \
    "$FM_SHIP_EXT_CHANGED" "$FM_SHIP_EXT_SKIPPED" "$FM_SHIP_EXT_NOOP"
fi
