#!/usr/bin/env bash
# tests/fm-secondmate-lifecycle-e2e.test.sh - the happy-path secondmate operator
# flow, end to end, against one shared world:
#
#   seed -> spawn -> routed send -> backlog handoff -> recovery respawn -> teardown
#
# Each phase asserts the durable contracts the consolidation audit lists, so the
# many former positive unit tests (registry scope/charter/clone/mode, spawn meta,
# bare-window send, recovery respawn, teardown of an empty home, backlog handoff)
# collapse into one lifecycle. The path-boundary safety invariants and the
# lease-specific paths live in fm-secondmate-safety.test.sh.
#
# Coverage anchored here (must not regress):
#   - registry line records scope (from a filled charter brief) and project list
#   - charter is copied into the subhome
#   - remote-backed projects are cloned with their origin URL preserved
#   - a no-mistakes project is initialized (init + doctor) in the NEW subhome clone
#     and the parent project clone is never mutated (no write through a project)
#   - spawn meta records kind=secondmate, home=, the project list, the shared
#     workspace + worker display labels, the herdr pane + tab, supervisor lineage,
#     and agent_identity (the integration key, never the human label); launch runs
#     in the subhome via `herdr agent start` with the persistent charter + cleared
#     overrides, and the herdr agent identity is never renamed
#   - a bare `fm-<id>` send targets the pane recorded in THIS home's meta
#   - backlog items move verbatim into the subhome and leave the main backlog
#   - recovery respawns from the durable registry + persistent home
#   - teardown removes meta and the registry route only after removing the home
set -u

# shellcheck source=tests/secondmate-helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/secondmate-helpers.sh"

TMP_ROOT=$(fm_test_tmproot fm-secondmate-lifecycle)

HOME_DIR="$TMP_ROOT/main home"
SUB="$TMP_ROOT/design-home"
SUB_ABS=
FAKEBIN=
LOG="$TMP_ROOT/herdr.log"
# Stable ids the fake herdr below returns, mirrored here for assertions.
HERDR_WS=wSHIP
HERDR_TAB=wSHIP:t2
HERDR_ROOT_PANE=wSHIP:p2
HERDR_AGENT_PANE=wSHIP:p3
ALPHA_ORIGIN=
BETA_ORIGIN=

# --- local herdr stub -------------------------------------------------------
#
# fm-spawn/fm-send/fm-teardown drive crewmate panes through `herdr`, not tmux,
# so the lifecycle runs against a fake `herdr` on PATH that emits the JSON
# shapes fm-spawn parses (workspace_id, tab_id, root_pane.pane_id,
# result.agent.pane_id) and logs every call to FM_FAKE_HERDR_LOG. Same stubbing
# convention as fm-spawn-placement and fm-secondmate-safety; the agent get
# response models the idle->working transition fm-herdr-lib uses to confirm a
# send. no-mistakes (seed's gamma init) is stubbed separately via the shared helper.
make_fake_herdr() {
  local dir=$1 fakebin
  fakebin=$(fm_fakebin "$dir")
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -u
printf 'herdr %s\n' "$*" >> "${FM_FAKE_HERDR_LOG:-/dev/null}"
case "${1:-}" in
  workspace)
    case "${2:-}" in
      list)   printf '{"result":{"type":"workspace_list","workspaces":[]}}\n'; exit 0 ;;
      create) printf '{"result":{"workspace":{"workspace_id":"wSHIP"}}}\n'; exit 0 ;;
    esac ;;
  tab)
    case "${2:-}" in
      create) printf '{"result":{"tab":{"tab_id":"wSHIP:t2"},"root_pane":{"pane_id":"wSHIP:p2"}}}\n'; exit 0 ;;
    esac ;;
  agent)
    case "${2:-}" in
      start) printf '{"result":{"agent":{"pane_id":"wSHIP:p3"}}}\n'; exit 0 ;;
      get)
        if grep -q 'pane run' "${FM_FAKE_HERDR_LOG:-/dev/null}" 2>/dev/null; then
          printf '{"agent_status":"working"}\n'
        else
          printf '{"agent_status":"idle"}\n'
        fi
        exit 0 ;;
    esac ;;
  pane)
    case "${2:-}" in
      close|run|rename|send-keys) exit 0 ;;
      read) printf 'idle prompt\n'; exit 0 ;;
      get) printf '{"pane_id":"wSHIP:p3"}\n'; exit 0 ;;
    esac ;;
esac
exit 0
SH
  chmod +x "$fakebin/herdr"
  printf '%s\n' "$fakebin"
}

# --- shared world + seed ----------------------------------------------------
setup_world() {
  mkdir -p "$HOME_DIR/projects" "$HOME_DIR/data" "$HOME_DIR/state"
  fm_git_init_commit "$HOME_DIR/projects/alpha"
  fm_git_init_commit "$HOME_DIR/projects/beta"
  fm_git_init_commit "$HOME_DIR/projects/gamma"
  fm_git_add_origin "$HOME_DIR/projects/alpha" "$TMP_ROOT/remotes/alpha.git"
  fm_git_add_origin "$HOME_DIR/projects/beta" "$TMP_ROOT/remotes/beta.git"
  fm_git_add_origin "$HOME_DIR/projects/gamma" "$TMP_ROOT/remotes/gamma.git"
  cat > "$HOME_DIR/data/projects.md" <<EOF
- alpha [direct-PR +yolo] - alpha project (added 2026-06-22)
- beta [direct-PR] - beta project (added 2026-06-22)
- gamma - gamma project (added 2026-06-22)
EOF
  ALPHA_ORIGIN=$(git -C "$HOME_DIR/projects/alpha" remote get-url origin)
  BETA_ORIGIN=$(git -C "$HOME_DIR/projects/beta" remote get-url origin)

  # One combined fakebin: the fake herdr (the workspace/tab/agent/pane ops that
  # spawn/send/teardown drive) plus no-mistakes (gamma init during seed).
  FAKEBIN=$(make_fake_herdr "$TMP_ROOT/fake")
  make_fake_no_mistakes "$TMP_ROOT/fake" >/dev/null

  # A filled charter brief whose routing scope differs from the charter summary,
  # so the registry must read the scope from the brief, not invent a generic one.
  FM_SECONDMATE_SCOPE='customer onboarding from brief' \
    scaffold_secondmate_charter "$HOME_DIR" design 'customer onboarding charter' alpha beta gamma \
    || fail "filled secondmate charter scaffold failed"
}

phase_seed() {
  local out
  out=$(PATH="$FAKEBIN:$PATH" FM_HOME="$HOME_DIR" \
    "$ROOT/bin/fm-home-seed.sh" design "$SUB" alpha beta gamma) \
    || fail "seed failed"
  SUB_ABS=$(cd "$SUB" && pwd -P)

  assert_contains "$out" "home=$SUB_ABS" "seed did not report the subhome"
  assert_present "$SUB/.fm-secondmate-home" "seed did not mark the subhome"
  assert_present "$SUB/data/charter.md" "seed did not copy the charter into the subhome"
  assert_grep 'customer onboarding charter' "$SUB/data/charter.md" "charter body was not copied verbatim"

  # Projects cloned; remote-backed origins preserved.
  assert_present "$SUB/projects/alpha/.git" "alpha was not cloned"
  assert_present "$SUB/projects/beta/.git" "beta was not cloned"
  assert_present "$SUB/projects/gamma/.git" "gamma was not cloned"
  [ "$(git -C "$SUB/projects/alpha" remote get-url origin)" = "$ALPHA_ORIGIN" ] \
    || fail "alpha clone did not preserve its origin URL"
  [ "$(git -C "$SUB/projects/beta" remote get-url origin)" = "$BETA_ORIGIN" ] \
    || fail "direct-PR beta clone did not preserve its origin URL"

  # no-mistakes init runs in the NEW clone, never the parent project.
  assert_present "$SUB/projects/gamma/.no-mistakes-init" "no-mistakes project was not initialized in the subhome"
  assert_present "$SUB/projects/gamma/.no-mistakes-doctor" "no-mistakes project was not doctored in the subhome"
  assert_absent "$HOME_DIR/projects/gamma/.no-mistakes-init" "seed wrote no-mistakes state through the parent project"

  # Registry line: scope from the filled brief, project list, no legacy owns field.
  assert_grep '- design - customer onboarding charter' "$HOME_DIR/data/secondmates.md" "registry summary not from the charter"
  assert_grep 'scope: customer onboarding from brief' "$HOME_DIR/data/secondmates.md" "registry scope not from the filled brief"
  assert_grep 'projects: alpha, beta, gamma' "$HOME_DIR/data/secondmates.md" "registry did not record the project list"
  assert_no_grep 'owns:' "$HOME_DIR/data/secondmates.md" "registry used the legacy owns field"

  # Delivery modes preserved in the subhome registry; validation passes.
  [ "$(FM_HOME="$SUB" "$ROOT/bin/fm-project-mode.sh" alpha)" = "direct-PR on" ] \
    || fail "alpha delivery mode not preserved in the subhome"
  [ "$(FM_HOME="$SUB" "$ROOT/bin/fm-project-mode.sh" beta)" = "direct-PR off" ] \
    || fail "beta delivery mode not preserved in the subhome"
  FM_HOME="$HOME_DIR" "$ROOT/bin/fm-home-seed.sh" validate >/dev/null || fail "registry validation failed after seed"

  pass "seed: registry scope+projects, charter copied, clones+origins, no-mistakes init in subhome only"
}

phase_spawn() {
  : > "$LOG"
  PATH="$FAKEBIN:$PATH" FM_HOME="$HOME_DIR" FM_CONFIG_OVERRIDE="$HOME_DIR/parent-config" \
    FM_FAKE_HERDR_LOG="$LOG" \
    "$ROOT/bin/fm-spawn.sh" design "$SUB" codex --secondmate >/dev/null \
    || fail "secondmate spawn failed"

  local meta="$HOME_DIR/state/design.meta"
  local pane
  pane=$(grep '^pane=' "$meta" | cut -d= -f2-)
  assert_grep 'kind=secondmate' "$meta" "spawn meta did not record kind=secondmate"
  assert_grep "home=$SUB_ABS" "$meta" "spawn meta did not record the subhome"
  assert_grep 'projects=alpha, beta, gamma' "$meta" "spawn meta did not record the project list"
  assert_grep 'workspace=Design' "$meta" "spawn meta did not record the secondmate's own named workspace"
  assert_grep 'worker=Design' "$meta" "spawn meta did not record the secondmate worker display label"
  assert_grep "tab=$HERDR_TAB" "$meta" "spawn meta did not record the herdr tab id"
  assert_grep 'supervisor=firstmate' "$meta" "spawn meta did not record the supervisor name"
  assert_grep 'agent_identity=codex' "$meta" "spawn meta did not record the codex integration identity"
  [ "$pane" = "$HERDR_AGENT_PANE" ] || fail "spawn meta did not record the herdr agent pane (got '$pane')"

  # Placement: the secondmate lands in its own tab inside the shared ship
  # workspace, with the human name on the tab + pane DISPLAY labels. The herdr
  # agent SLOT is the unique task id (here `design`), never the harness name, so
  # concurrent secondmates do not collide on the agent name; agent_identity=codex
  # is recorded in meta (the integration key status binds to), and the leftover
  # root shell is closed.
  assert_grep "tab create --workspace $HERDR_WS --label Design" "$LOG" "spawn did not create the secondmate's own tab in its own named workspace"
  assert_grep "agent start design --tab $HERDR_TAB" "$LOG" "spawn did not start the agent in its own tab under the unique task-id slot"
  assert_grep "pane close $HERDR_ROOT_PANE" "$LOG" "spawn did not close the tab's leftover root shell"
  assert_grep "pane rename $HERDR_AGENT_PANE Design" "$LOG" "spawn did not apply the display-only pane label"
  # The agent identity must survive (it binds the omp<->herdr status integration);
  # only the pane gets a display label, and the agent's own pane is never closed.
  assert_no_grep 'agent rename' "$LOG" "spawn renamed the herdr agent, which breaks the omp<->herdr status binding"
  assert_no_grep "pane close $HERDR_AGENT_PANE" "$LOG" "spawn closed the agent's own pane"

  # Launch ran in the subhome, with the persistent charter and cleared overrides.
  assert_grep "FM_HOME='$SUB_ABS'" "$LOG" "secondmate launch did not set FM_HOME to the subhome"
  assert_grep 'FM_ROOT_OVERRIDE= FM_STATE_OVERRIDE= FM_DATA_OVERRIDE= FM_PROJECTS_OVERRIDE=' "$LOG" "launch did not clear operational overrides"
  assert_grep 'FM_CONFIG_OVERRIDE=' "$LOG" "launch did not clear the config override"
  assert_grep "$SUB_ABS/data/charter.md" "$LOG" "launch did not use the persistent charter"
  pass "spawn: own tab in its own named workspace via herdr agent start, persistent charter, routing meta"
}

phase_send() {
  : > "$LOG"
  local pane
  pane=$(grep '^pane=' "$HOME_DIR/state/design.meta" | cut -d= -f2-)
  # A bare fm-<id> resolves the target PANE from THIS home's meta, then submits
  # via `herdr pane run` (text+Enter) - it never re-resolves the shorthand as a
  # herdr agent label.
  PATH="$FAKEBIN:$PATH" FM_HOME="$HOME_DIR" FM_FAKE_HERDR_LOG="$LOG" \
    "$ROOT/bin/fm-send.sh" fm-design 'route this work' >/dev/null 2>&1 \
    || fail "fm-send failed for a bare firstmate id with home metadata"
  assert_grep "pane run $pane route this work" "$LOG" "send did not run the text on the pane recorded in this home's meta"
  assert_no_grep 'agent get fm-design' "$LOG" "bare fm-<id> was resolved as a herdr agent label instead of via this home's meta"
  pass "send: a bare fm-<id> routes to the pane recorded in this home's meta"
}

phase_handoff() {
  cat > "$HOME_DIR/data/backlog.md" <<'EOF'
## In flight
- [ ] live-task - active work (repo: alpha, since 2026-06-20)

## Queued
- [ ] feat-x - add feature x (repo: alpha)
- [ ] feat-y - add feature y (repo: beta) blocked-by: feat-x - waits
- [ ] bug-z - fix bug z (repo: gamma)

## Done
- [x] old-task - shipped thing - local main (merged 2026-06-19)
EOF
  local out before
  out=$(FM_HOME="$HOME_DIR" "$ROOT/bin/fm-backlog-handoff.sh" design feat-x feat-y) \
    || fail "handoff failed for in-scope items"
  assert_contains "$out" "handed off 2 item(s) to design" "handoff did not report the moved items"

  assert_no_grep 'feat-x' "$HOME_DIR/data/backlog.md" "feat-x was not removed from the main backlog"
  assert_no_grep 'feat-y' "$HOME_DIR/data/backlog.md" "feat-y was not removed from the main backlog"
  assert_grep 'bug-z' "$HOME_DIR/data/backlog.md" "out-of-scope bug-z was wrongly removed"
  assert_grep 'live-task' "$HOME_DIR/data/backlog.md" "in-flight item was wrongly removed"

  assert_grep '- [ ] feat-x - add feature x (repo: alpha)' "$SUB/data/backlog.md" "feat-x did not arrive verbatim"
  assert_grep '- [ ] feat-y - add feature y (repo: beta) blocked-by: feat-x - waits' "$SUB/data/backlog.md" "feat-y line not preserved verbatim"
  awk '/^## Queued/{q=1;next} /^## /{q=0} q && /feat-x/{found=1} END{exit found?0:1}' "$SUB/data/backlog.md" \
    || fail "feat-x did not land under the Queued section"

  # Idempotent: a second handoff neither errors nor duplicates, and leaves main alone.
  before=$(cat "$HOME_DIR/data/backlog.md")
  FM_HOME="$HOME_DIR" "$ROOT/bin/fm-backlog-handoff.sh" design feat-x feat-y >/dev/null 2>&1 \
    || fail "idempotent re-run failed"
  [ "$(grep -cF -- '- [ ] feat-x - add feature x (repo: alpha)' "$SUB/data/backlog.md")" -eq 1 ] \
    || fail "idempotent re-run duplicated feat-x in the subhome backlog"
  [ "$before" = "$(cat "$HOME_DIR/data/backlog.md")" ] || fail "idempotent re-run mutated the main backlog"
  pass "handoff: in-scope items move verbatim, out-of-scope stays, idempotent"
}

phase_recovery() {
  # Simulate a restart: drop the live meta, then respawn from the registry +
  # persistent home (no explicit home argument).
  rm -f "$HOME_DIR/state/design.meta"
  PATH="$FAKEBIN:$PATH" FM_HOME="$HOME_DIR" FM_FAKE_HERDR_LOG="$LOG" \
    "$ROOT/bin/fm-spawn.sh" design "echo relaunch" --secondmate >/dev/null 2>&1 \
    || fail "recovery respawn failed"
  local meta="$HOME_DIR/state/design.meta"
  assert_grep "home=$SUB_ABS" "$meta" "respawn did not preserve the persistent home from the registry"
  assert_grep 'projects=alpha, beta, gamma' "$meta" "respawn did not preserve the project list from the registry"
  # The herdr placement is reconstructed: the secondmate's own named workspace,
  # its worker label, and a fresh agent pane recorded for routing.
  assert_grep 'workspace=Design' "$meta" "respawn did not reconstruct the named-workspace placement"
  assert_grep 'worker=Design' "$meta" "respawn did not reconstruct the worker label"
  assert_grep "pane=$HERDR_AGENT_PANE" "$meta" "respawn did not record a herdr pane for the relaunched agent"
  pass "recovery: respawns from the durable registry and persistent home"
}

phase_teardown() {
  : > "$LOG"
  local pane
  pane=$(grep '^pane=' "$HOME_DIR/state/design.meta" | cut -d= -f2-)
  PATH="$FAKEBIN:$PATH" FM_HOME="$HOME_DIR" FM_FAKE_HERDR_LOG="$LOG" \
    "$ROOT/bin/fm-teardown.sh" design >/dev/null 2>&1 \
    || fail "teardown failed for the empty secondmate home"
  assert_grep "pane close $pane" "$LOG" "teardown did not close the recorded agent pane before removing the home"
  assert_absent "$SUB" "teardown did not remove the retired secondmate home"
  assert_absent "$HOME_DIR/state/design.meta" "teardown did not clear the parent meta"
  assert_no_grep '- design ' "$HOME_DIR/data/secondmates.md" "teardown did not remove the registry route"
  # The parent's source projects are untouched (no write through a parent home).
  assert_present "$HOME_DIR/projects/alpha" "teardown disturbed a parent project"
  pass "teardown: closes the pane, removes the home, then clears meta and the registry route"
}

setup_world
phase_seed
phase_spawn
phase_send
phase_handoff
phase_recovery
phase_teardown
