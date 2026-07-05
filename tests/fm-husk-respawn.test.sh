#!/usr/bin/env bash
# Behavior tests for the idempotent-respawn husk path.
#
# herdr persists/restores its session layout across a server restart, so a task
# tab can come back as a HUSK: the tab/pane are restored but the agent process is
# gone, while the agent SLOT name (the task id) stays registered. A respawn onto
# that slot then fails with `agent_name_taken`. The fix classifies the leftover
# slot and, ONLY for a CONFIRMED husk, closes-and-replaces it - always creating
# the replacement tab BEFORE closing the old one. A live agent (a real concurrent
# worker) or an unclassifiable slot still refuses, so the concurrent-crew guard
# never regresses.
#
# Two layers are covered:
#   - unit: fm_herdr_classify_slot / fm_herdr_reap_husk_slot (bin/fm-herdr-lib.sh)
#     against a scenario-driven fake `herdr`;
#   - integration: the full fm-spawn.sh placement path (herdr_place_agent_tab)
#     reaps a husk (replacement tab created before the husk tab is closed) and
#     refuses a live slot without touching it.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPAWN="$ROOT/bin/fm-spawn.sh"
LIB="$ROOT/bin/fm-herdr-lib.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-husk-respawn.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# A scenario-driven fake `herdr` shared by the unit and integration layers.
# The conflicting slot is FM_FAKE_SLOT; its shape is FM_FAKE_SLOT_KIND:
#   free        - not registered (agent get errors); no conflict.
#   husk-dead   - registered, but its pane is gone (pane get errors).
#   husk-shell  - registered, pane alive, agent_status unknown, only a plain
#                 shell running (no agent process) -> confirmed husk.
#   live-working|live-idle - registered, a bound agent (agent_status working/idle).
#   booting     - registered, agent_status unknown, but a harness (bun/omp)
#                 process is still running -> NOT confidently a husk.
# The husk's leftover tab/pane are FM_FAKE_HUSK_TAB / FM_FAKE_HUSK_PANE; the
# replacement tab/pane the spawn creates are FM_FAKE_NEW_TAB / FM_FAKE_NEW_ROOT_PANE
# / FM_FAKE_NEW_AGENT_PANE. Every invocation is appended to FM_FAKE_HERDR_LOG.
make_fake_herdr() {
  local dir=$1 fakebin
  fakebin="$dir/fakebin"
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
[ -n "${FM_FAKE_HERDR_LOG:-}" ] && printf '%s\n' "$*" >> "$FM_FAKE_HERDR_LOG"
slot="${FM_FAKE_SLOT:-}"
kind="${FM_FAKE_SLOT_KIND:-free}"
htab="${FM_FAKE_HUSK_TAB:-wV:tOLD}"
hpane="${FM_FAKE_HUSK_PANE:-wV:pOLD}"
case "${1:-} ${2:-}" in
  "agent get")
    want="${3:-}"
    if [ "$want" = "$slot" ] && [ "$kind" != free ]; then
      printf '{"id":"x","result":{"agent":{"name":"%s","pane_id":"%s","tab_id":"%s","workspace_id":"wV"},"type":"agent_info"}}\n' \
        "$slot" "$hpane" "$htab"
      exit 0
    fi
    printf '{"error":{"code":"agent_not_found","message":"agent target %s not found"},"id":"x"}\n' "$want"
    exit 1 ;;
  "pane get")
    p="${3:-}"
    if [ "$p" = "$hpane" ]; then
      case "$kind" in
        husk-dead)   printf '{"error":{"code":"pane_not_found","message":"pane %s not found"},"id":"x"}\n' "$p"; exit 1 ;;
        live-working) st=working ;;
        live-idle)    st=idle ;;
        *)            st=unknown ;;
      esac
      printf '{"id":"x","result":{"pane":{"pane_id":"%s","agent_status":"%s"},"type":"pane_info"}}\n' "$p" "$st"
      exit 0
    fi
    printf '{"id":"x","result":{"pane":{"pane_id":"%s","agent_status":"unknown"},"type":"pane_info"}}\n' "$p"
    exit 0 ;;
  "pane process-info")
    # `--pane <id>` follows.
    p=; shift 2; while [ $# -gt 0 ]; do case "$1" in --pane) shift; p=${1:-} ;; esac; shift; done
    if [ "$p" = "$hpane" ] && [ "$kind" = booting ]; then
      printf '{"id":"x","result":{"process_info":{"foreground_processes":[{"argv0":"bun","name":"bun","cmdline":"bun /x/omp --auto-approve brief"}],"shell_pid":1},"pane_id":"%s"}}\n' "$p"
      exit 0
    fi
    # Default: a plain login shell, no agent process.
    printf '{"id":"x","result":{"process_info":{"foreground_processes":[{"argv0":"zsh","name":"zsh","cmdline":"-zsh"}],"shell_pid":1},"pane_id":"%s"}}\n' "$p"
    exit 0 ;;
  "tab create")
    printf '{"id":"x","result":{"tab":{"tab_id":"%s"},"root_pane":{"pane_id":"%s"}}}\n' \
      "${FM_FAKE_NEW_TAB:-wV:tNEW}" "${FM_FAKE_NEW_ROOT_PANE:-wV:pNEWroot}"
    exit 0 ;;
  "agent start")
    if [ "${FM_FAKE_AGENT_START_FAIL:-0}" = "1" ]; then echo "fake: agent start failed" >&2; exit 1; fi
    printf '{"id":"x","result":{"agent":{"pane_id":"%s"}}}\n' "${FM_FAKE_NEW_AGENT_PANE:-wV:pNEWagent}"
    exit 0 ;;
  "pane current")
    printf '{"id":"x","result":{"pane":{"pane_id":"wV:p1","workspace_id":"%s","tab_id":"wV:t1"}}}\n' \
      "${FM_FAKE_CURRENT_WSID:-}"
    exit 0 ;;
  "workspace get")
    printf '{"id":"x","result":{"workspace":{"workspace_id":"%s","label":"%s"}}}\n' "${3:-}" "${FM_FAKE_WS_LABEL:-myproj}"
    exit 0 ;;
  "tab close"|"pane close"|"pane rename"|"pane run"|"pane send-keys")
    exit 0 ;;
esac
exit 0
SH
  chmod +x "$fakebin/herdr"
  printf '%s\n' "$fakebin"
}

# --- unit: fm_herdr_classify_slot -------------------------------------------

classify() {
  # classify <kind> <slot-to-query>: run fm_herdr_classify_slot under a fake herdr
  # configured for <kind>, querying the given slot. Echoes the verdict. The fake
  # herdr and FM_FAKE_* config ride in as a command env prefix (not a subshell
  # assignment) so PATH stays scoped to the one invocation.
  local kind=$1 query=$2 dir fakebin
  dir=$(mktemp -d "$TMP_ROOT/classify.XXXXXX")
  fakebin=$(make_fake_herdr "$dir")
  PATH="$fakebin:$PATH" \
  FM_FAKE_SLOT=conflict-slot FM_FAKE_SLOT_KIND="$kind" \
  FM_FAKE_HUSK_TAB=wV:tOLD FM_FAKE_HUSK_PANE=wV:pOLD \
  bash -c '. "$1"; fm_herdr_classify_slot "$2"' _ "$LIB" "$query"
}

test_classify_free_when_unregistered() {
  [ "$(classify free conflict-slot)" = free ] || fail "unregistered slot must classify free"
  # Even with a live scenario, a DIFFERENT slot name is free (no conflict).
  [ "$(classify live-working other-slot)" = free ] || fail "a non-matching slot must classify free"
  pass "classify: an unregistered / non-matching slot is free"
}

test_classify_live_refuses() {
  [ "$(classify live-working conflict-slot)" = live ] || fail "a working bound agent must classify live"
  [ "$(classify live-idle conflict-slot)" = live ] || fail "an idle bound agent must classify live"
  pass "classify: a bound (working|idle) agent is live"
}

test_classify_husk_dead_pane() {
  [ "$(classify husk-dead conflict-slot)" = husk ] || fail "a registered slot with a dead pane must classify husk"
  pass "classify: a registered slot whose pane is gone is a husk"
}

test_classify_husk_agentless_shell() {
  [ "$(classify husk-shell conflict-slot)" = husk ] \
    || fail "unknown status + plain shell (no agent process) must classify husk"
  pass "classify: unknown status with only a plain shell is a husk"
}

test_classify_booting_agent_is_not_husk() {
  # unknown agent_status but a harness process still running -> fail closed.
  [ "$(classify booting conflict-slot)" = unknown ] \
    || fail "unknown status with a running harness process must NOT be a husk"
  pass "classify: unknown status with a running harness is unknown (fail closed)"
}

# --- unit: fm_herdr_reap_husk_slot ------------------------------------------

reap() {
  # reap <kind>: run fm_herdr_reap_husk_slot for the conflict slot, echo
  # "<exit-code>\t<log-file>" so callers can assert control flow AND side effects.
  # Config rides in as a command env prefix (not a subshell assignment).
  local kind=$1 dir fakebin rc log
  dir=$(mktemp -d "$TMP_ROOT/reap.XXXXXX")
  fakebin=$(make_fake_herdr "$dir")
  log="$dir/herdr.log"
  PATH="$fakebin:$PATH" \
  FM_FAKE_HERDR_LOG="$log" \
  FM_FAKE_SLOT=conflict-slot FM_FAKE_SLOT_KIND="$kind" \
  FM_FAKE_HUSK_TAB=wV:tOLD FM_FAKE_HUSK_PANE=wV:pOLD \
  FM_HUSK_REAP_SETTLE=0 \
  bash -c '. "$1"; fm_herdr_reap_husk_slot conflict-slot >/dev/null 2>&1' _ "$LIB"
  rc=$?
  printf '%s\t%s\n' "$rc" "$log"
}

test_reap_husk_closes_old_tab_and_frees() {
  local out rc log
  out=$(reap husk-shell); rc=${out%%$'\t'*}; log=${out#*$'\t'}
  [ "$rc" = 0 ] || fail "reap of a confirmed husk must return 0 (free to reuse)"
  grep -qF 'tab close wV:tOLD' "$log" || fail "reap must close the husk's leftover tab: $(cat "$log")"
  pass "reap: a confirmed husk is closed and the slot is freed (returns 0)"
}

test_reap_dead_husk_closes() {
  local out rc log
  out=$(reap husk-dead); rc=${out%%$'\t'*}; log=${out#*$'\t'}
  [ "$rc" = 0 ] || fail "reap of a dead-pane husk must return 0"
  grep -qF 'tab close wV:tOLD' "$log" || fail "reap must close the dead husk's tab: $(cat "$log")"
  pass "reap: a dead-pane husk is closed (returns 0)"
}

test_reap_live_refuses_and_leaves_it() {
  local out rc log
  out=$(reap live-working); rc=${out%%$'\t'*}; log=${out#*$'\t'}
  [ "$rc" = 1 ] || fail "reap must REFUSE (return 1) a live slot"
  ! grep -qF 'tab close wV:tOLD' "$log" || fail "reap must NOT close a live agent's tab: $(cat "$log")"
  pass "reap: a live slot is refused and left untouched (returns 1)"
}

test_reap_booting_refuses() {
  local out rc log
  out=$(reap booting); rc=${out%%$'\t'*}; log=${out#*$'\t'}
  [ "$rc" = 1 ] || fail "reap must REFUSE (return 1) an unclassifiable (booting) slot"
  ! grep -qF 'tab close wV:tOLD' "$log" || fail "reap must NOT close a booting agent's tab: $(cat "$log")"
  pass "reap: an unclassifiable slot is refused (fail closed, returns 1)"
}

test_reap_free_is_noop() {
  local out rc log
  out=$(reap free); rc=${out%%$'\t'*}; log=${out#*$'\t'}
  [ "$rc" = 0 ] || fail "reap of a free slot must return 0"
  ! grep -qF 'tab close' "$log" 2>/dev/null || fail "reap of a free slot must not close anything: $(cat "$log")"
  pass "reap: a free slot is a no-op (returns 0, closes nothing)"
}

# --- integration: full fm-spawn.sh placement --------------------------------

# Build a self-contained firstmate home + a real git project clone + a brief so
# the genuine worktree-isolation guard passes while herdr calls are faked.
make_case() {
  local name=$1 proj=$2 home
  home="$TMP_ROOT/$name"
  mkdir -p "$home/state" "$home/data" "$home/config" "$home/worktrees" "$home/projects/$proj"
  printf 'name=Mate\n' > "$home/config/identity"
  (
    cd "$home/projects/$proj" || exit 1
    git init -q
    git config user.email t@t; git config user.name t
    printf 'x\n' > seed.txt
    git add seed.txt; git commit -qm init
  )
  printf '%s\n' "$home"
}

run_spawn() {
  local home=$1 fakebin=$2; shift 2
  PATH="$fakebin:$PATH" \
    FM_ROOT_OVERRIDE='' \
    FM_HOME="$home" \
    FM_STATE_OVERRIDE='' FM_DATA_OVERRIDE='' FM_PROJECTS_OVERRIDE='' FM_CONFIG_OVERRIDE='' \
    FM_FAKE_HERDR_LOG="$home/herdr.log" \
    FM_FAKE_CURRENT_WSID=wV FM_FAKE_WS_LABEL=myproj \
    FM_FAKE_NEW_TAB="wV:tNEW" FM_FAKE_NEW_ROOT_PANE="wV:pNEWroot" FM_FAKE_NEW_AGENT_PANE="wV:pNEWagent" \
    FM_FAKE_HUSK_TAB="wV:tOLD" FM_FAKE_HUSK_PANE="wV:pOLD" \
    FM_HUSK_REAP_SETTLE=0 \
    HERDR_WORKSPACE_ID='' \
    FM_SPAWN_NO_GUARD=1 \
    "$@" 2>&1
}

test_spawn_reaps_husk_replacement_tab_before_close() {
  local home fakebin out log
  home=$(make_case reap-husk myproj)
  fakebin=$(make_fake_herdr "$home")
  mkdir -p "$home/data/respawn-me-k3"
  printf 'brief\n' > "$home/data/respawn-me-k3/brief.md"

  # The task id IS the herdr agent slot, so the conflict slot is respawn-me-k3.
  out=$(FM_FAKE_SLOT=respawn-me-k3 FM_FAKE_SLOT_KIND=husk-shell \
        run_spawn "$home" "$fakebin" "$SPAWN" respawn-me-k3 projects/myproj omp) \
    || fail "respawn onto a husk slot should SUCCEED after reap: $out"
  log="$home/herdr.log"

  # The husk's leftover tab was closed (close-and-replace happened).
  grep -qF 'tab close wV:tOLD' "$log" || fail "husk tab was not reaped: $(cat "$log")"
  # The replacement tab was created BEFORE the husk tab was closed, so a husk that
  # was its workspace's only tab could not take the workspace down.
  local create_ln close_ln
  create_ln=$(grep -nF 'tab create' "$log" | head -1 | cut -d: -f1)
  close_ln=$(grep -nF 'tab close wV:tOLD' "$log" | head -1 | cut -d: -f1)
  [ -n "$create_ln" ] && [ -n "$close_ln" ] || fail "missing create/close lines: $(cat "$log")"
  [ "$create_ln" -lt "$close_ln" ] \
    || fail "replacement tab was NOT created before the husk was closed (create@$create_ln close@$close_ln): $(cat "$log")"
  # The agent was (re)started on the freed slot and the spawn reported success.
  grep -qF 'agent start respawn-me-k3' "$log" || fail "agent was not started on the freed slot: $(cat "$log")"
  printf '%s\n' "$out" | grep -qF 'spawned respawn-me-k3' || fail "spawn did not report success: $out"
  grep -qF 'pane=wV:pNEWagent' "$home/state/respawn-me-k3.meta" || fail "meta did not record the new agent pane"
  pass "spawn reaps a husk slot and creates the replacement tab before closing the old one"
}

test_spawn_refuses_live_slot_and_leaves_it() {
  local home fakebin out log
  home=$(make_case refuse-live myproj)
  fakebin=$(make_fake_herdr "$home")
  mkdir -p "$home/data/collide-live-q7"
  printf 'brief\n' > "$home/data/collide-live-q7/brief.md"

  out=$(FM_FAKE_SLOT=collide-live-q7 FM_FAKE_SLOT_KIND=live-working \
        run_spawn "$home" "$fakebin" "$SPAWN" collide-live-q7 projects/myproj omp) \
    && fail "respawn onto a LIVE slot must fail (concurrent-crew guard): $out"
  log="$home/herdr.log"

  printf '%s\n' "$out" | grep -qiE 'live agent|refusing to replace' \
    || fail "refusal did not explain the live-agent collision: $out"
  # The live agent's tab must NOT be touched.
  ! grep -qF 'tab close wV:tOLD' "$log" || fail "a live agent's tab was closed: $(cat "$log")"
  # No agent was started for this task.
  ! grep -qF 'agent start collide-live-q7' "$log" || fail "agent was started despite refusing a live slot: $(cat "$log")"
  # The refused spawn cleaned up its worktree and branch.
  [ ! -d "$home/worktrees/collide-live-q7" ] || fail "refused spawn left its worktree behind"
  ! git -C "$home/projects/myproj" rev-parse --verify --quiet refs/heads/fm/collide-live-q7 >/dev/null 2>&1 \
    || fail "refused spawn left its branch behind"
  pass "spawn refuses a live slot, leaves it untouched, and cleans up"
}

test_classify_free_when_unregistered
test_classify_live_refuses
test_classify_husk_dead_pane
test_classify_husk_agentless_shell
test_classify_booting_agent_is_not_husk
test_reap_husk_closes_old_tab_and_frees
test_reap_dead_husk_closes
test_reap_live_refuses_and_leaves_it
test_reap_booting_refuses
test_reap_free_is_noop
test_spawn_reaps_husk_replacement_tab_before_close
test_spawn_refuses_live_slot_and_leaves_it
