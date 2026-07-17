#!/usr/bin/env bash
# Tests for the pre-spawn duplicate-pane guard in fm spawn --secondmate.
# The guard refuses to spawn when a live herdr pane already has cwd == the
# resolved secondmate home, preventing ghost-session duplicate mates.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPAWN="$ROOT/sbin/fm"
TMP_ROOT=
BASE_PATH=${FM_TEST_BASE_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}
# sbin/fm runs under bun; expose ONLY the real bun binary (not the mise shim
# dir, which would leak every other shimmed tool into the sandbox).
BUNBIN=$(mktemp -d "${TMPDIR:-/tmp}/fm-bunbin.XXXXXX")
ln -s "$(bun -e 'console.log(process.execPath)')" "$BUNBIN/bun"
BASE_PATH="$BASE_PATH:$BUNBIN"

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

cleanup() {
  [ -n "${TMP_ROOT:-}" ] && rm -rf "$TMP_ROOT"
}

trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-spawn-guard.XXXXXX")
BIN_DIR="$TMP_ROOT/fakebin"
mkdir -p "$BIN_DIR"

# Shared firstmate home (state, data, etc.) that is NOT any secondmate home.
FM_TEST_HOME="$TMP_ROOT/fmhome"
mkdir -p "$FM_TEST_HOME/state" \
         "$FM_TEST_HOME/data" \
         "$FM_TEST_HOME/projects" \
         "$FM_TEST_HOME/config"

# Build a minimal valid secondmate home for the given id.
# Returns the abs path via echo.
make_sm_home() {
  local id=$1 dir
  dir="$TMP_ROOT/homes/$id"
  mkdir -p "$dir/sbin" "$dir/data" "$dir/state" "$dir/config" "$dir/projects"
  printf '%s\n' "$id" > "$dir/.fm-secondmate-home"
  : > "$dir/AGENTS.md"
  ( cd "$dir" && pwd -P )
}

# Fake herdr: returns a pane list with a single pane whose cwd == $1.
# When $1 is empty, returns an empty pane list.
make_herdr() {
  local cwd_fixture=$1
  cat > "$BIN_DIR/herdr" << SH
#!/usr/bin/env bash
case "\${1:-}" in
  pane)
    case "\${2:-}" in
      list)
        printf '{"id":"cli:pane:list","result":{"panes":['
        if [ -n "$cwd_fixture" ]; then
          printf '{"pane_id":"wT:p1","cwd":"%s","agent_status":"unknown"}' "$cwd_fixture"
        fi
        printf ']}}\n'
        exit 0
        ;;
    esac
    ;;
esac
exit 1
SH
  chmod +x "$BIN_DIR/herdr"
}

# Spawn wrapper: run fm spawn <id> <home> --secondmate with test overrides.
run_spawn() {
  local id=$1 home=$2
  FM_ROOT_OVERRIDE="$ROOT" \
    FM_HOME="$FM_TEST_HOME" \
    FM_STATE_OVERRIDE="$FM_TEST_HOME/state" \
    FM_DATA_OVERRIDE="$FM_TEST_HOME/data" \
    FM_PROJECTS_OVERRIDE="$FM_TEST_HOME/projects" \
    FM_CONFIG_OVERRIDE="$FM_TEST_HOME/config" \
    FM_SPAWN_NO_GUARD=1 \
    PATH="$BIN_DIR:$BASE_PATH" \
    "$SPAWN" spawn "$id" "$home" --secondmate 2>&1
}

# --- T1: guard fires when pane cwd matches secondmate home --------------------
test_guard_refuses_matching_pane() {
  local home out rc
  home=$(make_sm_home grd-t1)
  make_herdr "$home"

  out=$(run_spawn grd-t1 "$home"); rc=$?
  [ "$rc" -ne 0 ] || fail "spawn should exit non-zero when matching pane found"
  printf '%s\n' "$out" | grep -q 'already has a live pane' \
    || fail "expected 'already has a live pane' in output: $out"
  printf '%s\n' "$out" | grep -q 'wT:p1' \
    || fail "expected pane id wT:p1 in error message: $out"
  printf '%s\n' "$out" | grep -q 'FM_SPAWN_FORCE=1' \
    || fail "expected FM_SPAWN_FORCE=1 hint in error: $out"
  pass "T1 guard refuses spawn when a live pane has matching cwd"
}

# --- T2: guard passes when no pane cwd matches --------------------------------
test_guard_passes_no_match() {
  local home out rc
  home=$(make_sm_home grd-t2)
  make_herdr "/some/other/path"

  out=$(run_spawn grd-t2 "$home"); rc=$?
  # Guard error must NOT appear; script will fail later (missing brief) - that's fine.
  printf '%s\n' "$out" | grep -q 'already has a live pane' \
    && fail "guard fired when no pane matches: $out"
  pass "T2 guard allows spawn when no pane cwd matches"
}

# --- T3: FM_SPAWN_FORCE=1 bypasses the guard ----------------------------------
test_guard_bypassed_with_force() {
  local home out
  home=$(make_sm_home grd-t3)
  make_herdr "$home"

  out=$(FM_SPAWN_FORCE=1 run_spawn grd-t3 "$home")
  printf '%s\n' "$out" | grep -q 'already has a live pane' \
    && fail "guard fired even with FM_SPAWN_FORCE=1: $out"
  pass "T3 FM_SPAWN_FORCE=1 bypasses the duplicate-pane guard"
}

# --- T4: guard passes when pane list is empty ---------------------------------
test_guard_passes_empty_pane_list() {
  local home out
  home=$(make_sm_home grd-t4)
  make_herdr ""   # empty pane list

  out=$(run_spawn grd-t4 "$home")
  printf '%s\n' "$out" | grep -q 'already has a live pane' \
    && fail "guard fired on empty pane list: $out"
  pass "T4 guard allows spawn when herdr returns no panes"
}

test_guard_refuses_matching_pane
test_guard_passes_no_match
test_guard_bypassed_with_force
test_guard_passes_empty_pane_list

echo "# all fm-spawn-guard tests passed"
