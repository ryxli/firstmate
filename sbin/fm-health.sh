#!/usr/bin/env bash
# Read-only, bounded health check for the local firstmate fleet.
#
# One invocation reports (tab-separated: check<TAB>state<TAB>detail):
#   - herdr / capture / roster availability
#   - each registered secondmate home: layout + identity
#   - live-pane count
#   - unknown live panes (agent panes in a tracked workspace, absent from state/*.meta)
#   - stale state/*.meta pane references (recorded pane no longer live)
#   - metadata/live identity or workspace mismatches
#
# It NEVER restarts agents, mutates fleet state, or requires the retired bin/ layout.
# A current home is valid when its sbin and extension links are correct; the mate's
# bin/ is not required to be real, symlinked, or present (a stale bin link is at most
# a warning). Exit non-zero only on required health failures; drift/diagnostic
# findings warn (exit 0).
set -eu
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
HELPER_DIR="${FM_HEALTH_SCRIPT_DIR:-$SCRIPT_DIR}"
TIMEOUT="${FM_HEALTH_TIMEOUT:-10}"
case "$TIMEOUT" in ''|*[!0-9.]*|.*) TIMEOUT=10 ;; esac

# Run a command with a hard timeout; capture combined output to $1.
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

# A current (sbin) home is valid when the operational dirs are local, the sbin
# link points at the canonical toolbelt, and every extension is linked. The mate
# bin/ is intentionally NOT checked here: homes may carry a stale bin symlink to
# the retired path, and bin is never required.
check_current_home() {
  local expected_id=$1 home=$2 entry name target marker identity_name
  [ -f "$home/.fm-secondmate-home" ] || return 1
  marker=$(cat "$home/.fm-secondmate-home" 2>/dev/null || true)
  identity_name=
  if [ -f "$home/config/identity" ]; then
    identity_name=$(sed -n 's/^name=//p' "$home/config/identity" | head -1)
  fi
  [ -n "$marker" ] || return 1
  marker=$(printf '%s' "$marker" | tr '[:upper:]' '[:lower:]')
  expected_id=$(printf '%s' "$expected_id" | tr '[:upper:]' '[:lower:]')
  identity_name=$(printf '%s' "$identity_name" | tr '[:upper:]' '[:lower:]')
  if [ "$marker" != "$expected_id" ] && { [ -z "$identity_name" ] || [ "$marker" != "$identity_name" ]; }; then return 1; fi
  for dir in data state config projects; do
    [ -d "$home/$dir" ] && [ ! -L "$home/$dir" ] || return 1
  done
  [ -L "$home/sbin" ] || return 1
  target=$(readlink "$home/sbin") || return 1
  [ "$target" = "$FM_ROOT/sbin" ] || return 1
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

# --- herdr / capture / roster ------------------------------------------------
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

# --- registered secondmate homes: layout + identity -------------------------
registry="$DATA/secondmates.md"
if [ -f "$registry" ]; then
  python3 - "$registry" <<'PY' >"$TMP_DIR/homes"
import os, re, sys
seen_regs, seen_homes = set(), set()
def field(rest, key):
    m = re.search(key + r":\s*([^;)]+)", rest)
    return m.group(1).strip() if m else ""
def walk(reg):
    reg = os.path.abspath(reg)
    if reg in seen_regs or not os.path.isfile(reg):
        return
    seen_regs.add(reg)
    for line in open(reg, encoding='utf-8'):
        m = re.match(r"^- ([^ ]+) - .*\(home: ([^;)]+)[;)].*", line.rstrip())
        if not m:
            continue
        ident = m.group(1)
        home = os.path.expanduser(m.group(2).strip())
        if home in seen_homes:
            continue
        seen_homes.add(home)
        print("\t".join([ident, home, field(line, "workspace"), field(line, "name")]))
        walk(os.path.join(home, "data", "secondmates.md"))
walk(sys.argv[1])
PY
  while IFS=$'\t' read -r ident home _ nm; do
    [ -n "$ident" ] || continue
    out="$TMP_DIR/home-$ident"
    if [ -L "$home/.omp" ]; then
      # Legacy plain-clone home (whole .omp symlinked): delegate to fm-home-link.
      if run_check "$out" "$HELPER_DIR/fm-home-link.sh" "$home" --check; then emit "home:$ident" ok checked
      else detail=$(sed -n 's/^result=//p' "$out" | tail -1); emit "home:$ident" fail "${detail:-check-failed}"; fi
    elif check_current_home "$ident" "$home"; then
      emit "home:$ident" ok checked
    else
      emit "home:$ident" fail current-layout
    fi
    # bin is optional; only a dangling bin symlink is worth a (non-fatal) warning.
    if [ -L "$home/bin" ] && [ ! -e "$home/bin" ]; then
      emit "bin:$ident" warn "stale-link -> $(readlink "$home/bin")"
    fi
    # Identity is part of the named-home contract: versioned schema plus the
    # registry display name are required for reliable routing.
    if [ -f "$home/config/identity" ]; then
      schema=$(sed -n 's/^schema_version=//p' "$home/config/identity" | head -1)
      idname=$(sed -n 's/^name=//p' "$home/config/identity" | head -1)
      if [ "$schema" != 1 ]; then
        emit "identity:$ident" fail "schema_version=${schema:-missing}"
      elif [ -z "$idname" ]; then
        emit "identity:$ident" fail name-missing
      elif [ -n "$nm" ] && [ "$idname" != "$nm" ]; then
        emit "identity:$ident" fail "name registry=$nm config=$idname"
      else
        emit "identity:$ident" ok "name=$idname"
      fi
    else
      emit "identity:$ident" fail identity-missing
    fi
  done < "$TMP_DIR/homes"
else emit registry fail missing; fi

# --- live panes / drift (diagnostic; warn only) ------------------------------
out="$TMP_DIR/panes.json"
if run_check "$out" herdr pane list; then
  python3 - "$out" "$STATE" "$TMP_DIR/homes" "$FM_HOME" <<'PY' >"$TMP_DIR/drift" 2>/dev/null || true
import glob, json, os, sys
panes_file, state_dir, homes_file, fm_home = sys.argv[1:5]
try:
    panes = json.load(open(panes_file)).get("result", {}).get("panes", [])
except Exception:
    panes = []
def ws_of(pid):
    return pid.split(":", 1)[0] if ":" in pid else ""
def label_of(p):
    return p.get("display_agent") or p.get("agent") or ""
live = {p.get("pane_id", ""): p for p in panes if p.get("pane_id")}
live_agents = {pid: p for pid, p in live.items() if label_of(p)}
print("live-panes\tok\tcount=%d" % len(live_agents))

# This firstmate's own supervisor pane: identity name + cwd == FM_HOME.
own_name = ""
_idf = os.path.join(fm_home, "config", "identity")
if os.path.isfile(_idf):
    for _l in open(_idf, encoding="utf-8", errors="replace"):
        if _l.startswith("name="):
            own_name = _l[5:].strip(); break
fm_home_real = os.path.realpath(fm_home)

# This home's tracked children, from its own state/*.meta.
metas = {}
for f in sorted(glob.glob(os.path.join(state_dir, "*.meta"))):
    kv = {}
    for line in open(f, encoding="utf-8", errors="replace"):
        if "=" in line:
            k, v = line.rstrip("\n").split("=", 1)
            kv[k] = v
    metas[os.path.basename(f)[:-5]] = kv
meta_panes = {kv["pane"]: ident for ident, kv in metas.items() if kv.get("pane")}

# Registry: registered homes -> (workspace, name); collect mate labels + workspaces.
reg = {}
mate_labels = set()
home_ws = {ws_of(p) for p in meta_panes if p}
if os.path.isfile(homes_file):
    for line in open(homes_file):
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 4:
            continue
        ident, home, ws, name = parts
        reg[ident] = (home, ws, name)
        mate_labels.add(ident.lower())
        if name:
            mate_labels.add(name.lower())
        if ws:
            home_ws.add(ws)
        if os.path.realpath(home) == os.path.realpath(fm_home) and ws:
            home_ws.add(ws)

# Stale metadata: recorded pane no longer live.
for ident, kv in metas.items():
    pane = kv.get("pane", "")
    if pane and pane not in live:
        print("meta:%s\twarn\tstale-pane=%s" % (ident, pane))

# Identity mismatch: recorded agent identity vs the live pane's agent.
for ident, kv in metas.items():
    pane = kv.get("pane", "")
    if pane and pane in live:
        want = kv.get("agent_identity") or kv.get("harness") or ""
        got = live[pane].get("agent", "")
        if want and got and want != got:
            print("meta:%s\twarn\tmismatch agent meta=%s live=%s" % (ident, want, got))

# Unknown live panes: an agent pane in a tracked workspace, not in any meta, not
# a registered mate's supervisor pane, and not this firstmate's own supervisor
# pane (own identity name + cwd == FM_HOME).
for pid in sorted(live_agents):
    p = live_agents[pid]
    if pid in meta_panes:
        continue
    if home_ws and ws_of(pid) not in home_ws:
        continue
    lab = label_of(p)
    if lab.lower() in mate_labels:
        continue
    pcwd = p.get("cwd", "")
    if own_name and lab.lower() == own_name.lower() and pcwd and os.path.realpath(pcwd) == fm_home_real:
        continue
    print("pane:%s\twarn\tunknown ws=%s label=%s" % (pid, ws_of(pid), lab))

# Workspace mismatch: a registered mate's live pane not in its registered workspace.
by_label = {}
for pid, p in live_agents.items():
    lab = label_of(p).lower()
    if lab:
        by_label.setdefault(lab, pid)
for ident, (home, ws, name) in reg.items():
    if not ws:
        continue
    pid = by_label.get((name or ident).lower())
    if pid and ws_of(pid) != ws:
        print("workspace:%s\twarn\tregistry=%s live=%s" % (ident, ws, ws_of(pid)))
PY
  while IFS=$'\t' read -r c s d; do
    [ -n "$c" ] || continue
    emit "$c" "$s" "$d"
  done < "$TMP_DIR/drift"
else emit live-panes warn pane-list-unavailable; fi

if [ "$status" -ne 0 ]; then printf 'overall\tfail\trequired check failed\n'
elif [ "$warning" -ne 0 ]; then printf 'overall\twarn\twarnings present\n'
else printf 'overall\tok\tall checks passed\n'; fi
exit "$status"
