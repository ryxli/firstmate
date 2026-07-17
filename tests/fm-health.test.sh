#!/usr/bin/env bash
# Focused coverage for the read-only firstmate health diagnostic.
# Scenarios: healthy no-drift, sbin-only home (stale bin), stale metadata,
# unknown live panes (with cross-workspace scoping), and a required failure.
set -eu
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fm-health-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $1" >&2; [ -n "${2:-}" ] && { echo "--- output ---" >&2; cat "$2" >&2; }; exit 1; }
have() { grep -q "$1" "$2" || fail "expected line /$1/" "$2"; }
lack() { if grep -q "$1" "$2"; then fail "unexpected line /$1/" "$2"; fi; }

# --- fake toolchain ---------------------------------------------------------
mkdir -p "$TMP/bin" "$TMP/fake-sbin"
cat >"$TMP/bin/herdr" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = status ]; then printf 'status: running\n'
elif [ "${1:-}" = pane ] && [ "${2:-}" = list ]; then cat "${FM_HEALTH_TEST_PANES:-/dev/null}"
else printf 'status: running\n'; fi
EOF
cat >"$TMP/fake-sbin/fm" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  capture-status) printf 'fleet_hook\tpresent\nsupervisor_auto\tlive\n' ;;
  panes) printf 'Demo\tidle\twH:p9\n' ;;
  home-link)
    if [ "${FM_HEALTH_TEST_FAIL_HOME:-}" = 1 ]; then printf 'result=blocked\n'; exit 1; fi
    printf 'result=ok\n'
    ;;
esac
EOF
chmod +x "$TMP/bin/herdr" "$TMP/fake-sbin/fm"

# make_current_home <dir> <name> <bin: none|valid|stale>
make_current_home() {
  local d=$1 name=$2 binmode=$3 entry
  mkdir -p "$d/data" "$d/state" "$d/config" "$d/projects" "$d/.omp/extensions"
  ln -s "$ROOT/sbin" "$d/sbin"
  printf '%s\n' "$name" >"$d/.fm-secondmate-home"
  printf 'schema_version=1\nname=%s\n' "$name" >"$d/config/identity"
  for entry in "$ROOT/.omp/extensions"/*; do
    [ -e "$entry" ] || continue
    ln -s "$entry" "$d/.omp/extensions/$(basename "$entry")"
  done
  case "$binmode" in
    valid) ln -s "$ROOT/sbin" "$d/bin" ;;
    stale) ln -s "$ROOT/retired-bin-does-not-exist" "$d/bin" ;;
    none) : ;;
  esac
}

# run <fm-home> [panes-json] -> writes stdout to $OUT, returns exit code
run() {
  PATH="$TMP/bin:$PATH" FM_HOME="$1" FM_HEALTH_SCRIPT_DIR="$TMP/fake-sbin" \
    FM_HEALTH_TIMEOUT=3 FM_HEALTH_TEST_PANES="${2:-}" "$ROOT/sbin/fm" health
}

# =====================================================================
# Scenario A: healthy no-drift  ->  everything ok, overall ok, exit 0
# =====================================================================
A="$TMP/A"; mkdir -p "$A/data" "$A/state" "$A/config"
printf 'schema_version=1\nname=Keel\n' >"$A/config/identity"
make_current_home "$TMP/demoA" Demo valid
cat >"$A/data/secondmates.md" <<EOF
- demo - demo mate (home: $TMP/demoA; workspace: wH; name: Demo)
EOF
printf 'pane=wH:p1\nkind=ship\nagent_identity=omp\n' >"$A/state/task1.meta"
cat >"$TMP/panesA.json" <<EOF
{"result":{"panes":[
  {"pane_id":"wH:p1","agent":"omp","display_agent":"","agent_status":"idle"},
  {"pane_id":"wH:p9","agent":"omp","display_agent":"Demo","agent_status":"idle"},
  {"pane_id":"wH:pA","agent":"omp","display_agent":"Keel","agent_status":"idle","cwd":"$A"}
]}}
EOF
run "$A" "$TMP/panesA.json" >"$TMP/A.out" || fail "healthy scenario exited non-zero" "$TMP/A.out"
have $'^home:demo\tok\tchecked$' "$TMP/A.out"
have $'^identity:demo\tok\tname=Demo$' "$TMP/A.out"
have $'^live-panes\tok\tcount=3$' "$TMP/A.out"
have $'^overall\tok\tall checks passed$' "$TMP/A.out"
lack $'\twarn\t' "$TMP/A.out"
lack $'\tfail\t' "$TMP/A.out"
lack 'pane:wH:pA' "$TMP/A.out"   # own supervisor pane (name=Keel, cwd=FM_HOME) not flagged unknown

# =====================================================================
# Scenario B: sbin-only home with a stale bin link  ->  home valid,
# bin reported as a warning (never a required failure), exit 0
# =====================================================================
B="$TMP/B"; mkdir -p "$B/data" "$B/state"
make_current_home "$TMP/sbinB" Sbin stale   # sbin+extensions correct, bin dangling, no real bin
cat >"$B/data/secondmates.md" <<EOF
- sbinonly - sbin-only mate (home: $TMP/sbinB; workspace: wS; name: Sbin)
EOF
printf '{"result":{"panes":[]}}\n' >"$TMP/panesB.json"
run "$B" "$TMP/panesB.json" >"$TMP/B.out" || fail "sbin-only scenario exited non-zero" "$TMP/B.out"
have $'^home:sbinonly\tok\tchecked$' "$TMP/B.out"      # valid WITHOUT a real bin
have $'^bin:sbinonly\twarn\tstale-link' "$TMP/B.out"    # stale bin -> warning only
have $'^overall\twarn\twarnings present$' "$TMP/B.out"
lack $'^home:sbinonly\tfail' "$TMP/B.out"               # never a required failure

# =====================================================================
# Scenario C: stale metadata  ->  recorded pane no longer live -> warn
# =====================================================================
C="$TMP/C"; mkdir -p "$C/data" "$C/state"
make_current_home "$TMP/demoC" Demo valid
cat >"$C/data/secondmates.md" <<EOF
- demo - demo mate (home: $TMP/demoC; workspace: wH; name: Demo)
EOF
printf 'pane=wH:p7\nkind=ship\n' >"$C/state/dead.meta"
cat >"$TMP/panesC.json" <<'EOF'
{"result":{"panes":[{"pane_id":"wH:p9","agent":"omp","display_agent":"Demo","agent_status":"idle"}]}}
EOF
run "$C" "$TMP/panesC.json" >"$TMP/C.out" || fail "stale-meta scenario exited non-zero" "$TMP/C.out"
have $'^meta:dead\twarn\tstale-pane=wH:p7$' "$TMP/C.out"
have $'^overall\twarn\twarnings present$' "$TMP/C.out"

# =====================================================================
# Scenario D: unknown live panes  ->  untracked agent pane in a tracked
# workspace flagged; a pane in another workspace is NOT flagged
# =====================================================================
D="$TMP/D"; mkdir -p "$D/data" "$D/state"
make_current_home "$TMP/demoD" Demo valid
cat >"$D/data/secondmates.md" <<EOF
- demo - demo mate (home: $TMP/demoD; workspace: wH; name: Demo)
EOF
printf 'pane=wH:p1\nkind=ship\n' >"$D/state/task1.meta"
cat >"$TMP/panesD.json" <<'EOF'
{"result":{"panes":[
  {"pane_id":"wH:p1","agent":"omp","display_agent":"","agent_status":"idle"},
  {"pane_id":"wH:p5","agent":"omp","display_agent":"fm-orphan","agent_status":"idle"},
  {"pane_id":"wZ:p1","agent":"omp","display_agent":"fm-foreign","agent_status":"idle"},
  {"pane_id":"wH:p9","agent":"omp","display_agent":"Demo","agent_status":"idle"}
]}}
EOF
run "$D" "$TMP/panesD.json" >"$TMP/D.out" || fail "unknown-pane scenario exited non-zero" "$TMP/D.out"
have $'^pane:wH:p5\twarn\tunknown ws=wH label=fm-orphan$' "$TMP/D.out"
lack 'wZ:p1' "$TMP/D.out"                               # foreign-workspace pane not flagged
lack 'pane:wH:p9' "$TMP/D.out"                          # registered mate's own pane not flagged
lack 'pane:wH:p1' "$TMP/D.out"                          # tracked pane not flagged
have $'^overall\twarn\twarnings present$' "$TMP/D.out"

# =====================================================================
# Scenario E: required failure  ->  broken current layout -> fail, exit 1
# =====================================================================
E="$TMP/E"; mkdir -p "$E/data" "$E/state"
mkdir -p "$TMP/brokenE/data" "$TMP/brokenE/state" "$TMP/brokenE/config" "$TMP/brokenE/projects" "$TMP/brokenE/.omp/extensions"
printf 'broken\n' >"$TMP/brokenE/.fm-secondmate-home"   # marker present but NO sbin link -> invalid
cat >"$E/data/secondmates.md" <<EOF
- broken - broken mate (home: $TMP/brokenE; workspace: wB; name: Broken)
EOF
printf '{"result":{"panes":[]}}\n' >"$TMP/panesE.json"
if run "$E" "$TMP/panesE.json" >"$TMP/E.out"; then
  fail "required-failure scenario unexpectedly exited 0" "$TMP/E.out"
fi
have $'^home:broken\tfail\tcurrent-layout$' "$TMP/E.out"
have $'^overall\tfail\trequired check failed$' "$TMP/E.out"

# Legacy plain-clone home branch still fails via fm-home-link when broken.
L="$TMP/L"; mkdir -p "$L/data" "$L/state"
mkdir -p "$TMP/legacyL"; ln -s "$ROOT/.omp" "$TMP/legacyL/.omp"
cat >"$L/data/secondmates.md" <<EOF
- legacy - legacy mate (home: $TMP/legacyL; workspace: wL; name: Legacy)
EOF
printf '{"result":{"panes":[]}}\n' >"$TMP/panesL.json"
if FM_HEALTH_TEST_FAIL_HOME=1 run "$L" "$TMP/panesL.json" >"$TMP/L.out"; then
  fail "legacy failure scenario unexpectedly exited 0" "$TMP/L.out"
fi
have $'^home:legacy\tfail\tblocked$' "$TMP/L.out"

printf 'fm-health: healthy, sbin-only(stale-bin), stale-meta, unknown-pane, and required-failure scenarios passed\n'
