#!/usr/bin/env bash
# Tests for the pre-spawn duplicate-pane guard in fm spawn --secondmate.
# The guard refuses to spawn when a Herdr agent pane already has cwd == the
# resolved secondmate home. Plain shell panes in that home are ignored.
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
# Harness resolves before the duplicate guard; seed a verified adapter so T1
# can reach the pane-list check instead of failing closed on 'unknown'.
printf 'omp\n' > "$FM_TEST_HOME/config/crew-harness"

# Build a minimal valid secondmate home for the given id.
# Returns the abs path via echo.
make_sm_home() {
  local id=$1 dir
  dir="$TMP_ROOT/homes/$id"
  mkdir -p "$dir/sbin" "$dir/data" "$dir/state" "$dir/config" "$dir/projects" "$dir/.omp/skills"
  printf '%s\n' "$id" > "$dir/.fm-secondmate-home"
  : > "$dir/AGENTS.md"
  : > "$dir/config/shared-skills"
  : > "$dir/config/local-skills"
  # OMP secondmate spawn fail-closes without a non-empty regular charter.
  printf '# Charter\n%s domain\n' "$id" > "$dir/data/charter.md"
  ( cd "$dir" && pwd -P )
}

# Fake herdr: returns a pane list with a single pane whose cwd == $1.
# The optional second argument selects agent (default) or shell.
# Agent and shell panes use separate literal JSON branches so the fixture
# never interpolates a JSON fragment into the printf format string.
make_herdr() {
  local cwd_fixture=$1 kind=${2:-agent}
  if [ "$kind" = agent ]; then
    cat > "$BIN_DIR/herdr" << SH
#!/usr/bin/env bash
case "\${1:-}" in
  "agent")
    if [ "\${2:-}" = get ]; then
      printf '{"error":{"code":"agent_not_found"}}\n'
      exit 1
    fi
    ;;
  pane)
    case "\${2:-}" in
      list)
        printf '{"id":"cli:pane:list","result":{"panes":['
        if [ -n "$cwd_fixture" ]; then
          printf '{"pane_id":"wT:p1","cwd":"%s","agent_status":"unknown","agent_session":{"agent":"omp"}}' "$cwd_fixture"
        fi
        printf ']}}\n'
        exit 0
        ;;
    esac
    ;;
esac
exit 1
SH
  elif [ "$kind" = empty-process ] || [ "$kind" = unrelated-process ]; then
    cat > "$BIN_DIR/herdr" << SH
#!/usr/bin/env bash
case "\${1:-}" in
  "agent")
    if [ "\${2:-}" = get ]; then
      printf '{"error":{"code":"agent_not_found"}}\n'
      exit 1
    fi
    ;;
  pane)
    case "\${2:-}" in
      list)
        printf '{"id":"cli:pane:list","result":{"panes":['
        if [ -n "$cwd_fixture" ]; then
          printf '{"pane_id":"wT:p1","cwd":"%s","agent_status":"unknown","agent_session":{"agent":"omp"}}' "$cwd_fixture"
        fi
        printf ']}}\n'
        exit 0
        ;;
      process-info)
        if [ "$kind" = empty-process ]; then
          printf '{"id":"cli:pane:process_info","result":{"process_info":{"foreground_processes":[]}}}\n'
        else
          printf '{"id":"cli:pane:process_info","result":{"process_info":{"foreground_processes":[{"argv0":"python","name":"python","cmdline":"python worker.py"}]}}}\n'
        fi
        exit 0
        ;;
    esac
    ;;
esac
exit 1
SH
    chmod +x "$BIN_DIR/herdr"
  elif [ "$kind" = stale-shell ]; then
    cat > "$BIN_DIR/herdr" << SH
#!/usr/bin/env bash
case "\${1:-}" in
  "agent")
    if [ "\${2:-}" = get ]; then
      printf '{"error":{"code":"agent_not_found"}}\n'
      exit 1
    fi
    ;;
  pane)
    case "\${2:-}" in
      list)
        printf '{"id":"cli:pane:list","result":{"panes":['
        if [ -n "$cwd_fixture" ]; then
          printf '{"pane_id":"wT:p1","cwd":"%s","agent_status":"unknown","agent_session":{"agent":"omp","value":"stale"}}' "$cwd_fixture"
        fi
        printf ']}}\n'
        exit 0
        ;;
      process-info)
        printf '{"id":"cli:pane:process_info","result":{"process_info":{"foreground_processes":[{"argv0":"zsh","name":"zsh","cmdline":"/bin/zsh -l"}]}}}\n'
        exit 0
        ;;
    esac
    ;;
esac
exit 1
SH
  else
    cat > "$BIN_DIR/herdr" << SH
#!/usr/bin/env bash
case "\${1:-}" in
  "agent")
    if [ "\${2:-}" = get ]; then
      printf '{"error":{"code":"agent_not_found"}}\n'
      exit 1
    fi
    ;;
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
  fi
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

# --- T5: a shell in the mate home is not a duplicate agent --------------------
test_guard_ignores_matching_shell_pane() {
  local home out
  home=$(make_sm_home grd-t5)
  make_herdr "$home" shell

  out=$(run_spawn grd-t5 "$home")
  printf '%s\n' "$out" | grep -q 'already has a live pane' \
    && fail "guard treated a shell as a duplicate mate: $out"
  pass "T5 guard ignores matching shell panes"
}

# --- T6: stale session metadata does not turn a shell into a duplicate --------
test_guard_ignores_stale_session_on_shell_pane() {
  local home out
  home=$(make_sm_home grd-t6)
  make_herdr "$home" stale-shell

  out=$(run_spawn grd-t6 "$home")
  printf '%s\n' "$out" | grep -q 'already has a live pane' \
    && fail "guard treated stale shell metadata as a duplicate mate: $out"
  pass "T6 guard ignores stale session metadata on shell panes"
}

# --- T7/T8: unknown foreground process lists do not unblock the guard ---------
test_guard_refuses_empty_foreground_processes() {
  local home out
  home=$(make_sm_home grd-t7)
  make_herdr "$home" empty-process

  out=$(run_spawn grd-t7 "$home")
  printf '%s\n' "$out" | grep -q 'already has a live pane' \
    || fail "guard allowed an empty foreground process list: $out"
  pass "T7 guard refuses empty foreground process lists"
}

test_guard_refuses_unrelated_foreground_processes() {
  local home out
  home=$(make_sm_home grd-t8)
  make_herdr "$home" unrelated-process

  out=$(run_spawn grd-t8 "$home")
  printf '%s\n' "$out" | grep -q 'already has a live pane' \
    || fail "guard allowed an unrelated foreground process list: $out"
  pass "T8 guard refuses unrelated foreground process lists"
}

# --- T9: slot rebound between husk proof and close is never closed ------------
test_husk_reap_refuses_rebound_slot() {
  local fakebin="$TMP_ROOT/rebound-bin" log="$TMP_ROOT/rebound.log" counter="$TMP_ROOT/rebound.count"
  mkdir -p "$fakebin"
  : > "$counter"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -u
[ -n "${FM_HERDR_LOG:-}" ] && printf '%s\n' "$*" >> "$FM_HERDR_LOG"
case "${1:-} ${2:-}" in
  "agent get")
    count=0
    [ -s "${FM_HERDR_COUNTER:-}" ] && count=$(cat "$FM_HERDR_COUNTER")
    count=$((count + 1))
    printf '%s\n' "$count" > "$FM_HERDR_COUNTER"
    if [ "$count" -eq 1 ]; then
      printf '{"result":{"agent":{"pane_id":"w1:p-old","tab_id":"w1:t-old","workspace_id":"w1"}}}\n'
    else
      printf '{"result":{"agent":{"pane_id":"w1:p-new","tab_id":"w1:t-new","workspace_id":"w1"}}}\n'
    fi
    exit 0
    ;;
  "pane get")
    printf '{"result":{"pane":{"agent_status":"unknown"}}}\n'
    exit 0
    ;;
  "pane process-info")
    if [ "${4:-}" = "w1:p-old" ]; then
      printf '{"result":{"process_info":{"foreground_processes":[{"argv0":"zsh","name":"zsh","cmdline":"/bin/zsh -l"}]}}}\n'
    else
      printf '{"result":{"process_info":{"foreground_processes":[{"argv0":"omp","name":"omp","cmdline":"omp"}]}}}\n'
    fi
    exit 0
    ;;
  "tab close"|"pane close"|"workspace close")
    exit 0
    ;;
esac
exit 1
SH
  chmod +x "$fakebin/herdr"
  if PATH="$fakebin:$BASE_PATH" FM_HERDR_COUNTER="$counter" FM_HERDR_LOG="$log" \
    bun -e '
      import { herdrReapHuskSlot } from "'"$ROOT"'/.omp/extensions/cli/lib/herdr.ts";
      process.exit((await herdrReapHuskSlot("slot")) ? 0 : 1);
    '; then
    fail "husk reap succeeded after the slot rebound"
  fi
  if grep -Eq '^(tab|pane|workspace) close ' "$log"; then
    fail "husk reap closed topology after the slot rebound: $(cat "$log")"
  fi
  pass "T9 husk reap refuses a rebound slot without closing topology"
}

test_husk_reap_refuses_rebound_slot
test_guard_refuses_empty_foreground_processes
test_guard_refuses_unrelated_foreground_processes

test_guard_refuses_matching_pane
test_guard_passes_no_match
test_guard_bypassed_with_force
test_guard_passes_empty_pane_list
test_guard_ignores_matching_shell_pane
test_guard_ignores_stale_session_on_shell_pane

echo "# all fm-spawn-guard tests passed"
