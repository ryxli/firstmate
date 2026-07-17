#!/usr/bin/env bash
# Bootstrap detection, best-effort fleet refresh/prune, and installs.
# Usage: fm-bootstrap.sh
#          Detect: prints one line per problem or capability fact and exits 0.
#          Silent = all good.
#          Lines: "MISSING: <tool> (install: <command>)", "NEEDS_GH_AUTH",
#                 "CREW_HARNESS_OVERRIDE: <name>", "FLEET_SYNC: <repo>: skipped: <reason>",
#                 "TASKS_AXI: available",
#                 "MISSING_EXT: <name> (provision: chezmoi apply - dotfiles repo is the canonical owner)".
#          MISSING_EXT covers the per-machine provisioned OMP extensions expected
#          as directories under ~/.omp/agent/extensions (override the dir with
#          FM_OMP_EXT_OVERRIDE). They are dotfiles-owned; bootstrap only declares,
#          never vendors or installs them.
#          tasks-axi is an OPTIONAL backlog-management capability reported only
#          when tasks-axi --version is 0.1.1 or newer. It is never a MISSING
#          line and never prompts an install.
#          Fleet sync fetches, fast-forwards, and prunes gone local branches;
#          it is bounded by FM_FLEET_SYNC_BOOTSTRAP_TIMEOUT, default 20s.
#          Set FM_FLEET_PRUNE=0 to skip branch pruning during that refresh.
#        fm-bootstrap.sh install <tool>...
#          Install the named tools (only ones the captain approved).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# shellcheck source=sbin/fm-root-lib.sh
. "$SCRIPT_DIR/fm-root-lib.sh"
# A session opened directly in a symlinked home has no FM_HOME; resolve it from
# the invocation dir (nearest AGENTS.md) so we do not collapse onto the code root.
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$(fm_home_from_cwd)}}"
[ -n "$FM_HOME" ] || FM_HOME="$FM_ROOT"
export FM_HOME
PROJECTS="${FM_PROJECTS_OVERRIDE:-$FM_HOME/projects}"
CONFIG="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}"
# shellcheck source=sbin/fm-tasks-axi-lib.sh
. "$SCRIPT_DIR/fm-tasks-axi-lib.sh"

fleet_sync() {
  [ -x "$FM_ROOT/sbin/fm-fleet-sync.sh" ] || return 0
  [ -d "$PROJECTS" ] || return 0

  tmp=$(mktemp "${TMPDIR:-/tmp}/fm-fleet-sync.XXXXXX" 2>/dev/null) || return 0
  monitor_was_on=0
  case $- in *m*) monitor_was_on=1 ;; esac
  set -m 2>/dev/null || true
  "$FM_ROOT/sbin/fm-fleet-sync.sh" >"$tmp" 2>/dev/null &
  pid=$!

  timeout=${FM_FLEET_SYNC_BOOTSTRAP_TIMEOUT:-20}
  case "$timeout" in ''|*[!0-9]*) timeout=20 ;; esac
  start=$SECONDS
  while jobs -r -p | grep -qx "$pid"; do
    if [ $((SECONDS - start)) -ge "$timeout" ]; then
      kill -TERM "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      [ "$monitor_was_on" -eq 1 ] || set +m 2>/dev/null || true
      echo "FLEET_SYNC: fleet: skipped: bootstrap refresh timed out"
      rm -f "$tmp"
      return 0
    fi
    sleep 1
  done
  wait "$pid" 2>/dev/null || true
  [ "$monitor_was_on" -eq 1 ] || set +m 2>/dev/null || true

  while IFS= read -r line; do
    case "$line" in
      *': skipped: local-only project') ;;
      *': skipped: no origin remote') ;;
      *': skipped:'*) echo "FLEET_SYNC: $line" ;;
    esac
  done < "$tmp"
  rm -f "$tmp"
}

self_pane_sync() {
  [ -x "$FM_ROOT/sbin/fm-self-pane.sh" ] || return 0
  command -v herdr >/dev/null 2>&1 || return 0
  herdr_server_running || return 0

  tmp=$(mktemp "${TMPDIR:-/tmp}/fm-self-pane.XXXXXX" 2>/dev/null) || return 0
  if "$FM_ROOT/sbin/fm-self-pane.sh" >"$tmp" 2>&1; then
    rm -f "$tmp"
    return 0
  fi
  if IFS= read -r line < "$tmp" && [ -n "$line" ]; then
    echo "SELF_PANE: $line"
  fi
  rm -f "$tmp"
}

# Re-apply the herdr omp status-integration self-heal patch. A herdr update
# overwrites the managed integration file and reverts the patch, so bootstrap
# re-applies it every session. Idempotent and silent when already patched; only
# surfaces a line when it actually (re)patches after an update.
herdr_omp_patch_sync() {
  [ -x "$FM_ROOT/sbin/fm-patch-herdr-omp.sh" ] || return 0
  "$FM_ROOT/sbin/fm-patch-herdr-omp.sh" --check >/dev/null 2>&1 && return 0
  if "$FM_ROOT/sbin/fm-patch-herdr-omp.sh" >/dev/null 2>&1; then
    echo "HERDR_OMP_PATCH: re-applied status self-heal after integration update"
  else
    rc=$?
    if [ "$rc" -eq 4 ]; then
      echo "HERDR_OMP_PATCH: restart OMP panes before applying the status self-heal patch"
    else
      echo "HERDR_OMP_PATCH: failed to apply status self-heal patch (exit $rc)"
    fi
  fi
}

install_cmd() {
  case "$1" in
    herdr) echo "mise install herdr  # or download from https://herdr.dev" ;;
    node|gh) echo "brew install $1  # or the platform's package manager" ;;
    bun) echo "brew install oven-sh/bun/bun  # or https://bun.sh/docs/installation" ;;
    gh-axi|chrome-devtools-axi|lavish-axi) echo "npm install -g $1 && $1 setup hooks" ;;
    *) return 1 ;;
  esac
}

locked_dependency_sync() {
  local code_root
  code_root=$(cd -P "$FM_ROOT/sbin/.." 2>/dev/null && pwd) || return 0
  [ -f "$code_root/package.json" ] && [ -f "$code_root/bun.lock" ] || return 0
  command -v bun >/dev/null 2>&1 || return 0
  if (cd "$code_root" && bun install --frozen-lockfile >/dev/null 2>&1); then
    return 0
  fi
  echo "BUN_DEPENDENCY: locked install failed in $code_root"
}

# Per-machine provisioned OMP extensions, owned by the dotfiles repo (chezmoi).
# Bootstrap declares a missing one; it never vendors or installs extensions.
OMP_EXTENSIONS="whiteboard fleet-bus lavish textguard thinking-tag-guard agent-effectiveness capture"
OMP_EXT_DIR="${FM_OMP_EXT_OVERRIDE:-$HOME/.omp/agent/extensions}"

omp_ext_check() {
  local ext
  for ext in $OMP_EXTENSIONS; do
    [ -d "$OMP_EXT_DIR/$ext" ] || \
      echo "MISSING_EXT: $ext (provision: chezmoi apply - dotfiles repo is the canonical owner)"
  done
}

# herdr is the terminal/agent substrate and also manages secondmate home worktrees.
TOOLS="herdr node gh gh-axi chrome-devtools-axi lavish-axi"

herdr_server_running() {
  herdr status 2>/dev/null | grep -q 'status: running'
}

if [ "${1:-}" = "install" ]; then
  shift
  [ $# -gt 0 ] || { echo "usage: fm-bootstrap.sh install <tool>..." >&2; exit 1; }
  for t in "$@"; do
    cmd=$(install_cmd "$t") || { echo "error: unknown tool $t" >&2; exit 1; }
    cmd=${cmd%%  #*}
    echo "installing $t: $cmd"
    eval "$cmd"
  done
  exit 0
fi

for t in $TOOLS; do
  command -v "$t" >/dev/null || echo "MISSING: $t (install: $(install_cmd "$t"))"
done
if command -v herdr >/dev/null 2>&1 && ! herdr_server_running; then
  echo "MISSING: herdr-server (start with: herdr)"
fi
omp_ext_check
self_pane_sync
herdr_omp_patch_sync
gh auth status >/dev/null 2>&1 || echo "NEEDS_GH_AUTH"
crew=
[ -f "$CONFIG/crew-harness" ] && crew=$(tr -d '[:space:]' < "$CONFIG/crew-harness" || true)
[ -n "$crew" ] && [ "$crew" != "default" ] && echo "CREW_HARNESS_OVERRIDE: $crew"
fm_tasks_axi_compatible && echo "TASKS_AXI: available"
# Do not sync dependencies or fleet state from an unchecked captain handoff.
handoff_check_output=$("$FM_ROOT/sbin/fm-handoff-check.sh" 2>&1) || {
  printf '%s\n' "$handoff_check_output"
  exit 1
}

locked_dependency_sync
fleet_sync
exit 0
