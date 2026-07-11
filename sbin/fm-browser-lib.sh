#!/usr/bin/env bash
# fm-browser-lib.sh - shared named browser-session helpers for firstmate.
#
# The helpers are side-effect free.  They keep browser sessions scoped to the
# active firstmate home instead of the process-wide chrome-devtools-axi default.

# fm_browser_slug <raw-string>
# Print a normalized browser-session slug.
fm_browser_slug() {
  local raw=${1:-} slug
  slug=$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//')
  [ -n "$slug" ] || slug=browser
  printf '%s\n' "$slug"
}

# fm_browser_default_session <home> <cwd>
# Print the stable session name for a browser opened from cwd in home.
fm_browser_default_session() {
  local home=${1:?fm_browser_default_session requires home}
  local cwd=${2:?fm_browser_default_session requires cwd}
  local home_slug cwd_slug

  home_slug=$(fm_browser_slug "$(basename "$home")")
  cwd_slug=$(fm_browser_slug "$(basename "$cwd")")
  if [ "$home_slug" = "$cwd_slug" ]; then
    cwd_slug=manual
  fi
  printf 'fm-%s-%s\n' "$home_slug" "$cwd_slug"
}

# fm_browser_state_dir
# Print the browser state directory for the active firstmate home.  The root,
# home, and state override rules match the other firstmate shell wrappers.
fm_browser_state_dir() {
  local script_dir root home state

  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  root=${FM_ROOT_OVERRIDE:-$(cd "$script_dir/.." && pwd)}
  home=${FM_HOME:-${FM_ROOT_OVERRIDE:-$root}}
  state=${FM_STATE_OVERRIDE:-$home/state}
  printf '%s/browser\n' "$state"
}
