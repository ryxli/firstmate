#!/usr/bin/env bash
# Shared root/home resolver for firstmate shell scripts.
#
# Separates the canonical checked-out code root from the operational home that
# owns data/, state/, config/, and projects/. This lets a secondmate run from a
# plain home whose sbin/ is a symlink to the canonical checkout.

fm_realpath_existing() {
  local path=${1:?fm_realpath_existing requires a path} parent base
  [ -e "$path" ] || return 1
  if [ -d "$path" ]; then
    ( cd -P "$path" && pwd )
    return
  fi
  parent=$(dirname "$path")
  base=$(basename "$path")
  ( cd -P "$parent" && printf '%s/%s\n' "$(pwd)" "$base" )
}

fm_normalize_path() {
  local path=${1:?fm_normalize_path requires a path} prefix tail probe parent base component old_ifs out
  case "$path" in
    /*) probe=$path ;;
    *) probe="$(pwd -P)/$path" ;;
  esac
  if [ -e "$probe" ]; then
    fm_realpath_existing "$probe"
    return
  fi
  tail=
  while [ ! -e "$probe" ] && [ "$probe" != "/" ]; do
    tail="$(basename "$probe")${tail:+/$tail}"
    probe=$(dirname "$probe")
  done
  if [ -d "$probe" ]; then
    prefix=$(cd -P "$probe" && pwd)
  elif [ -e "$probe" ]; then
    parent=$(dirname "$probe")
    base=$(basename "$probe")
    prefix=$(cd -P "$parent" && printf '%s/%s\n' "$(pwd)" "$base")
  else
    prefix=/
  fi
  out=${prefix%/}
  [ -n "$out" ] || out=/
  old_ifs=$IFS
  IFS=/
  for component in $tail; do
    case "$component" in
      ''|.) ;;
      ..)
        if [ "$out" != "/" ]; then
          out=${out%/*}
          [ -n "$out" ] || out=/
        fi
        ;;
      *)
        if [ "$out" = "/" ]; then
          out="/$component"
        else
          out="$out/$component"
        fi
        ;;
    esac
  done
  IFS=$old_ifs
  printf '%s\n' "$out"
}

fm_script_dir_physical() {
  local source_path=${1:?fm_script_dir_physical requires a bash source path}
  ( cd -P "$(dirname "$source_path")" && pwd )
}

fm_code_root_from_script() {
  local source_path=${1:?fm_code_root_from_script requires a bash source path} script_dir root
  if [ -n "${FM_CODE_ROOT_OVERRIDE:-}" ]; then
    fm_realpath_existing "$FM_CODE_ROOT_OVERRIDE"
    return
  fi
  if [ -n "${FM_ROOT_OVERRIDE:-}" ]; then
    fm_realpath_existing "$FM_ROOT_OVERRIDE"
    return
  fi
  script_dir=$(fm_script_dir_physical "$source_path") || return 1
  root=$(cd -P "$script_dir/.." && pwd) || return 1
  printf '%s\n' "$root"
}

fm_init_roots() {
  local source_path=${1:?fm_init_roots requires a bash source path}
  FM_CODE_ROOT_EFFECTIVE=$(fm_code_root_from_script "$source_path") || return 1
  case "${FM_HOME:-}" in
    '')
      if [ -n "${FM_ROOT_OVERRIDE:-}" ] && [ -z "${FM_CODE_ROOT_OVERRIDE:-}" ]; then
        FM_HOME_EFFECTIVE=$(fm_normalize_path "$FM_ROOT_OVERRIDE")
      else
        FM_HOME_EFFECTIVE=$FM_CODE_ROOT_EFFECTIVE
      fi
      ;;
    *) FM_HOME_EFFECTIVE=$(fm_normalize_path "$FM_HOME") ;;
  esac
  FM_DATA_EFFECTIVE=${FM_DATA_OVERRIDE:-$FM_HOME_EFFECTIVE/data}
  FM_STATE_EFFECTIVE=${FM_STATE_OVERRIDE:-$FM_HOME_EFFECTIVE/state}
  FM_CONFIG_EFFECTIVE=${FM_CONFIG_OVERRIDE:-$FM_HOME_EFFECTIVE/config}
  FM_PROJECTS_EFFECTIVE=${FM_PROJECTS_OVERRIDE:-$FM_HOME_EFFECTIVE/projects}

  FM_ROOT=$FM_CODE_ROOT_EFFECTIVE
  FM_HOME=$FM_HOME_EFFECTIVE
  DATA=$FM_DATA_EFFECTIVE
  STATE=$FM_STATE_EFFECTIVE
  CONFIG=$FM_CONFIG_EFFECTIVE
  PROJECTS=$FM_PROJECTS_EFFECTIVE

  export FM_CODE_ROOT_EFFECTIVE FM_HOME_EFFECTIVE FM_DATA_EFFECTIVE FM_STATE_EFFECTIVE FM_CONFIG_EFFECTIVE FM_PROJECTS_EFFECTIVE
  export FM_ROOT FM_HOME DATA STATE CONFIG PROJECTS
}
