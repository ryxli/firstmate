#!/usr/bin/env bash
# Read-only bounded health check for the local firstmate fleet.
set -eu
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
HELPER_DIR="${FM_HEALTH_SCRIPT_DIR:-$SCRIPT_DIR}"
TIMEOUT="${FM_HEALTH_TIMEOUT:-10}"
case "$TIMEOUT" in ''|*[!0-9.]*|.*) TIMEOUT=10 ;; esac
run_check() {
  local out=$1; shift
  python3 - "$TIMEOUT" "$@" >"$out" 2>&1 <<'PY'
import subprocess, sys
try:
    p = subprocess.run(sys.argv[2:], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=float(sys.argv[1]))
    sys.stdout.write(p.stdout)
    raise SystemExit(p.returncode)
except subprocess.TimeoutExpired:
    print("timed out", file=sys.stderr); raise SystemExit(124)
except OSError as e:
    print(str(e), file=sys.stderr); raise SystemExit(125)
PY
}
status=0
warning=0
emit() {
  local check=$1 state=$2 detail=$3
  printf '%s\t%s\t%s\n' "$check" "$state" "$detail"
  if [ "$state" = fail ]; then status=1; fi
  if [ "$state" = warn ]; then warning=1; fi
}

check_current_home() {
  local home=$1 canonical entry name target
  [ -f "$home/.fm-secondmate-home" ] || return 1
  for dir in data state config projects; do
    [ -d "$home/$dir" ] && [ ! -L "$home/$dir" ] || return 1
  done
  [ -d "$home/bin" ] && [ ! -L "$home/bin" ] || return 1
  [ -L "$home/sbin" ] || return 1
  canonical="$FM_ROOT/sbin"
  target=$(readlink "$home/sbin") || return 1
  [ "$target" = "$canonical" ] || return 1
  [ -d "$home/.omp/extensions" ] && [ ! -L "$home/.omp/extensions" ] || return 1
  [ -d "$FM_ROOT/.omp/extensions" ] || return 1
  for entry in "$FM_ROOT/.omp/extensions"/*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    if [ -e "$home/.omp/extensions/$name" ] && [ ! -L "$home/.omp/extensions/$name" ]; then continue; fi
    [ -L "$home/.omp/extensions/$name" ] || return 1
    target=$(readlink "$home/.omp/extensions/$name") || return 1
    [ "$target" = "$entry" ] || return 1
  done
}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/fm-health.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT
out="$TMP_DIR/herdr"
if run_check "$out" herdr status; then
  if grep -q 'status: running' "$out"; then emit herdr ok running; else emit herdr fail not-running; fi
else emit herdr fail command-failed; fi
out="$TMP_DIR/capture"
if run_check "$out" "$HELPER_DIR/fm-capture-status.sh"; then
  hook=$(sed -n 's/^fleet_hook[[:space:]]*//p' "$out" | head -1)
  supervisor=$(sed -n 's/^supervisor_auto[[:space:]]*//p' "$out" | head -1)
  if [ "$hook" = present ] && [ "$supervisor" = live ]; then emit capture ok "hook=$hook supervisor=$supervisor"
  elif [ "$hook" = present ]; then emit capture warn "hook=$hook supervisor=${supervisor:-unknown}"
  else emit capture fail "hook=${hook:-unknown} supervisor=${supervisor:-unknown}"; fi
else emit capture fail command-failed; fi
out="$TMP_DIR/roster"
if run_check "$out" "$HELPER_DIR/fm-panes.sh"; then
  count=$(grep -c . "$out" || true); emit roster ok "panes=$count"
else emit roster fail command-failed; fi
registry="$DATA/secondmates.md"
if [ -f "$registry" ]; then
  python3 - "$registry" "$TMP_DIR/homes" <<'PY' >"$TMP_DIR/homes"
import os, re, sys
seen_regs, seen_homes = set(), set()
def walk(reg):
    reg = os.path.abspath(reg)
    if reg in seen_regs or not os.path.isfile(reg): return
    for line in open(reg, encoding='utf-8'):
        m = re.match(r"^- ([^ ]+) - .*\(home: ([^;)]+)[;)].*", line.rstrip())
        if not m: continue
        ident, home = m.group(1), os.path.expanduser(m.group(2).strip())
        if home in seen_homes: continue
        seen_homes.add(home); print(ident + "\t" + home)
        walk(os.path.join(home, "data", "secondmates.md"))
walk(sys.argv[1])
PY
  while IFS=$'\t' read -r ident home; do
    [ -n "$ident" ] || continue
    out="$TMP_DIR/home-$ident"
    if [ -L "$home/.omp" ]; then
      if run_check "$out" "$HELPER_DIR/fm-home-link.sh" "$home" --check; then emit "home:$ident" ok checked
      else detail=$(sed -n 's/^result=//p' "$out" | tail -1); emit "home:$ident" fail "${detail:-check-failed}"; fi
    elif check_current_home "$home"; then
      emit "home:$ident" ok checked
    else
      emit "home:$ident" fail current-layout
    fi
  done < "$TMP_DIR/homes"
else emit registry fail missing; fi
if [ "$status" -ne 0 ]; then printf 'overall\tfail\trequired check failed\n'; elif [ "$warning" -ne 0 ]; then printf 'overall\twarn\twarnings present\n'; else printf 'overall\tok\tall checks passed\n'; fi
exit "$status"
