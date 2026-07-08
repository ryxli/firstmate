#!/usr/bin/env bash
# Behavior tests for fm-spawn.sh deterministic herdr placement + labeling.
#
# These exercise the real placement path with a fake `herdr` on PATH (recording
# every invocation) and a real throwaway git repo for the project, so the git
# worktree creation is genuine while the herdr workspace/tab/agent calls are
# captured for assertion. FM_SPAWN_NO_GUARD=1 keeps them off the live watcher.
#
# What is asserted:
#   - a crewmate lands in the SPAWNER'S CURRENT herdr workspace as a new tab and
#     NEVER creates a per-project workspace (main-home crew nest under firstmate's
#     own workspace; a secondmate's crew nest under the mate's home workspace);
#   - outside herdr (no live current workspace) crew fall back to a project-labeled
#     workspace so the workspace is still sensibly named;
#   - the crewmate gets its OWN tab + pane DISPLAY-labeled by the task slug
#     (no supervisor-slug prefix; the random task id stays out of the visible
#     label), while the herdr agent identity stays the integration-safe key
#     (omp) and is NEVER renamed;
#   - the tab ends as a SINGLE agent pane: the leftover root shell is closed;
#   - the meta records tab=, supervisor lineage, and agent_identity=omp, but no
#     workspace_id (so teardown does per-task cleanup, never destroying the shared
#     workspace);
#   - a --secondmate lands in its own workspace named after the secondmate (its home), its own tab labeled "home" so the space is not "Name . Name";
#   - an omp secondmate home overlay at config/omp-overlay.yml is injected into the fresh launch, and absent overlay leaves the omp command unchanged;
#   - a secondmate home missing AGENTS.md/bin is auto-linked, not rejected.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPAWN="$ROOT/bin/fm-spawn.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-spawn-placement.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# A fake herdr that records invocations and emits the minimal JSON each call
# site parses. Workspace identity is backed by FM_FAKE_WS (label<TAB>id lines)
# so reuse-vs-create can be exercised deterministically.
make_fake_herdr() {
  local dir=$1 fakebin
  fakebin="$dir/fakebin"
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
log="${FM_FAKE_HERDR_LOG:?}"
printf '%s\n' "$*" >> "$log"
case "${1:-}" in
  workspace)
    case "${2:-}" in
      list)
        printf '{"id":"x","result":{"type":"workspace_list","workspaces":['
        first=1
        if [ -n "${FM_FAKE_WS:-}" ] && [ -f "$FM_FAKE_WS" ]; then
          while IFS=$'\t' read -r lbl wid; do
            [ -n "$lbl" ] || continue
            [ "$first" -eq 1 ] || printf ','
            printf '{"label":"%s","workspace_id":"%s"}' "$lbl" "$wid"
            first=0
          done < "$FM_FAKE_WS"
        fi
        printf ']}}\n'
        exit 0 ;;
      create)
        lbl=; shift 2
        while [ $# -gt 0 ]; do case "$1" in --label) shift; lbl=${1:-} ;; esac; shift; done
        wid="${FM_FAKE_NEW_WSID:-wNEW}"
        [ -z "${FM_FAKE_WS:-}" ] || printf '%s\t%s\n' "$lbl" "$wid" >> "$FM_FAKE_WS"
        printf '{"result":{"workspace":{"workspace_id":"%s"},"root_pane":{"pane_id":"%s"}}}\n' \
          "$wid" "${FM_FAKE_WS_INIT_PANE:-wX:p1}"
        exit 0 ;;
      get)
        # Resolve a workspace id to its label from the FM_FAKE_WS table so the
        # parent-workspace path can record a human-readable workspace=/domain=.
        want=${3:-}; lbl=
        if [ -n "${FM_FAKE_WS:-}" ] && [ -f "$FM_FAKE_WS" ]; then
          while IFS=$'\t' read -r l w; do
            [ "$w" = "$want" ] && { lbl=$l; break; }
          done < "$FM_FAKE_WS"
        fi
        printf '{"result":{"workspace":{"workspace_id":"%s","label":"%s"}}}\n' "$want" "$lbl"
        exit 0 ;;
    esac ;;
  tab)
    case "${2:-}" in
      create)
        printf '{"result":{"tab":{"tab_id":"%s"},"root_pane":{"pane_id":"%s"}}}\n' \
          "${FM_FAKE_TAB_ID:-wX:t9}" "${FM_FAKE_ROOT_PANE:-wX:p9}"
        exit 0 ;;
    esac ;;
  agent)
    case "${2:-}" in
      start)
        if [ "${FM_FAKE_AGENT_START_FAIL:-0}" = "1" ]; then echo "fake: agent start failed" >&2; exit 1; fi
        printf '{"result":{"agent":{"pane_id":"%s"}}}\n' "${FM_FAKE_AGENT_PANE:-wX:p10}"; exit 0 ;;
    esac ;;
  pane)
    case "${2:-}" in
      close|run) exit 0 ;;
      get) printf '{"pane_id":"wX:p10"}\n'; exit 0 ;;
      current)
        # The spawner's live current pane. FM_FAKE_CURRENT_WSID drives the
        # parent-workspace placement rule; empty = spawned outside herdr.
        printf '{"result":{"pane":{"pane_id":"wV:p1","workspace_id":"%s","tab_id":"wV:t1"}}}\n' \
          "${FM_FAKE_CURRENT_WSID:-}"
        exit 0 ;;
    esac ;;
esac
exit 0
SH
  chmod +x "$fakebin/herdr"
  printf '%s\n' "$fakebin"
}

# Build a self-contained firstmate home + a real git project clone + a brief.
# Echoes the home path. Args: case-name project-name supervisor-name
make_case() {
  local name=$1 proj=$2 supname=$3 home
  home="$TMP_ROOT/$name"
  mkdir -p "$home/state" "$home/data" "$home/config" "$home/worktrees" "$home/projects/$proj"
  if [ -n "$supname" ]; then
    printf 'name=%s\n' "$supname" > "$home/config/identity"
  fi
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
    FM_FAKE_WS="$home/ws.tsv" \
    FM_FAKE_ROOT_PANE="wX:p9" FM_FAKE_AGENT_PANE="wX:p10" FM_FAKE_WS_INIT_PANE="wX:p1" \
    HERDR_WORKSPACE_ID='' FM_FAKE_CURRENT_WSID="${FM_FAKE_CURRENT_WSID:-}" \
    FM_SPAWN_NO_GUARD=1 \
    FM_REAL_GIT="${FM_REAL_GIT:-}" FM_FAKE_WT="${FM_FAKE_WT:-}" FM_FAKE_TOPLEVEL="${FM_FAKE_TOPLEVEL:-}" \
    "$SPAWN" "$@" 2>&1
}

# Drop a fake `git` into an existing fakebin that forces the worktree-isolation
# probe (`git -C <wt> rev-parse --show-toplevel`) to resolve to the primary
# checkout, simulating a tangle. Every other git call delegates to the real git.
add_fake_git() {
  local fakebin=$1
  cat > "$fakebin/git" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "-C" ] && [ "${3:-}" = "rev-parse" ] && [ "${4:-}" = "--show-toplevel" ]; then
  if [ -n "${FM_FAKE_TOPLEVEL:-}" ] && [ "$(cd "${2:-.}" 2>/dev/null && pwd -P)" = "$(cd "${FM_FAKE_WT:-.}" 2>/dev/null && pwd -P)" ]; then
    printf '%s\n' "$FM_FAKE_TOPLEVEL"
    exit 0
  fi
fi
exec "${FM_REAL_GIT:?}" "$@"
SH
  chmod +x "$fakebin/git"
}

test_crewmate_lands_in_spawners_current_workspace() {
  local home fakebin out meta
  home=$(make_case crew-new myproj Mate)
  fakebin=$(make_fake_herdr "$home")
  # The spawner (main firstmate) lives in workspace wV labeled "firstmate".
  printf 'firstmate\twV\n' > "$home/ws.tsv"
  mkdir -p "$home/data/fix-login-k3"
  printf 'brief\n' > "$home/data/fix-login-k3/brief.md"

  out=$(FM_FAKE_CURRENT_WSID=wV run_spawn "$home" "$fakebin" fix-login-k3 projects/myproj omp) \
    || fail "spawn failed: $out"

  # The whole point: a crewmate lands in the spawner's CURRENT workspace as a new
  # tab. No project-named workspace is ever created (that was the old sprawl).
  ! grep -qF 'workspace create' "$home/herdr.log" \
    || fail "crew created a workspace instead of using the spawner's current one: $(cat "$home/herdr.log")"
  grep -qF 'tab create --workspace wV --label fix-login' "$home/herdr.log" \
    || fail "tab not created in the spawner's current workspace with worker display label: $(cat "$home/herdr.log")"
  # The herdr agent SLOT name is the UNIQUE task id (not the harness name), so
  # concurrent crewmates never collide on the agent name; the omp<->herdr status
  # binding survives via the integration's socket self-report (agent_identity=omp).
  grep -qF 'agent start fix-login-k3 --tab wX:t9' "$home/herdr.log" \
    || fail "agent not started in its own tab under the unique task-id slot: $(cat "$home/herdr.log")"
  grep -q 'agent start fix-login-k3 .*--env PATH=' "$home/herdr.log" \
    || fail "agent start did not pass --env PATH (omp would not resolve on the daemon PATH): $(cat "$home/herdr.log")"
  grep -qF 'pane rename wX:p10 fix-login' "$home/herdr.log" \
    || fail "pane was not given its worker display label: $(cat "$home/herdr.log")"
  ! grep -qF 'agent rename' "$home/herdr.log" \
    || fail "agent rename appeared; it breaks the omp<->herdr status binding: $(cat "$home/herdr.log")"

  meta="$home/state/fix-login-k3.meta"
  [ -f "$meta" ] || fail "no meta written"
  grep -qF 'pane=wX:p10' "$meta" || fail "meta pane not the agent pane"
  grep -qF 'tab=wX:t9' "$meta" || fail "meta missing herdr tab id"
  grep -qF 'workspace=firstmate' "$meta" || fail "meta workspace not the spawner's current workspace label"
  grep -qF 'worker=fix-login' "$meta" || fail "meta missing worker label"
  grep -qF 'domain=firstmate' "$meta" || fail "meta domain not the spawner's current workspace label"
  grep -qF 'supervisor=Mate' "$meta" || fail "meta missing supervisor name"
  grep -qF 'agent_identity=omp' "$meta" || fail "meta missing agent_identity=omp"
  ! grep -q '^workspace_id=' "$meta" \
    || fail "meta recorded workspace_id; teardown would destroy the shared workspace"
  pass "crewmate lands in the spawner's current workspace as a new tab (no project workspace)"
}

test_crewmate_single_agent_pane() {
  local home fakebin out
  home=$(make_case crew-single myproj Mate)
  fakebin=$(make_fake_herdr "$home")
  printf 'firstmate\twV\n' > "$home/ws.tsv"
  mkdir -p "$home/data/add-x-q7"
  printf 'brief\n' > "$home/data/add-x-q7/brief.md"

  out=$(FM_FAKE_CURRENT_WSID=wV run_spawn "$home" "$fakebin" add-x-q7 projects/myproj omp) \
    || fail "spawn failed: $out"

  # The leftover tab root shell pane must be closed so the tab is a single agent pane.
  grep -qF 'pane close wX:p9' "$home/herdr.log" \
    || fail "tab root shell pane was not closed; tab would be a split beside a blank shell: $(cat "$home/herdr.log")"
  # On the parent-workspace path there is NO fresh workspace, hence no orphan
  # workspace root shell to close - only the new tab's own root shell.
  ! grep -qF 'pane close wX:p1' "$home/herdr.log" \
    || fail "crew closed a workspace init pane, but no workspace was created on the parent-workspace path: $(cat "$home/herdr.log")"
  pass "spawned tab ends as a single agent pane (only the tab root shell is closed)"
}

test_crewmate_in_secondmate_home_nests_under_mate_workspace() {
  local home fakebin out meta
  home=$(make_case crew-in-sm myproj Anchor)
  printf '%s' anchor > "$home/.fm-secondmate-home"
  fakebin=$(make_fake_herdr "$home")
  # A secondmate runs IN its own home workspace, so its current workspace is the
  # mate's home space (here wANCHOR labeled "Anchor"). Its crew simply land there.
  printf 'Anchor\twANCHOR\n' > "$home/ws.tsv"
  mkdir -p "$home/data/probe-cache-z9"
  printf 'brief\n' > "$home/data/probe-cache-z9/brief.md"

  out=$(FM_FAKE_CURRENT_WSID=wANCHOR run_spawn "$home" "$fakebin" probe-cache-z9 projects/myproj omp) \
    || fail "crewmate spawn in secondmate home failed: $out"

  # A secondmate's crew nest under the mate's own workspace because that is the
  # spawner's current workspace - the same parent-workspace rule, no special case,
  # and never a per-project workspace.
  ! grep -qF 'workspace create' "$home/herdr.log" \
    || fail "secondmate crew created a workspace instead of using the mate's current one: $(cat "$home/herdr.log")"
  grep -qF 'tab create --workspace wANCHOR --label probe-cache' "$home/herdr.log" \
    || fail "crew did not nest under the secondmate's current workspace: $(cat "$home/herdr.log")"

  meta="$home/state/probe-cache-z9.meta"
  grep -qF 'workspace=Anchor' "$meta" || fail "meta workspace not the mate's current workspace label"
  grep -qF 'domain=Anchor' "$meta" || fail "meta domain not the mate's current workspace label"
  pass "crewmate from a secondmate home nests under the mate's current workspace"
}

test_crewmate_fallback_creates_project_workspace_outside_herdr() {
  local home fakebin out meta
  home=$(make_case crew-fallback myproj Mate)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  # No live current workspace (spawned outside herdr): FM_FAKE_CURRENT_WSID unset
  # AND HERDR_WORKSPACE_ID cleared by run_spawn. The documented fallback is the
  # old per-project workspace so the workspace is still sensibly named.
  mkdir -p "$home/data/fix-bug-m2"
  printf 'brief\n' > "$home/data/fix-bug-m2/brief.md"

  out=$(run_spawn "$home" "$fakebin" fix-bug-m2 projects/myproj omp) \
    || fail "spawn failed: $out"

  grep -qF 'workspace create --label myproj' "$home/herdr.log" \
    || fail "fallback did not create the project-labeled workspace: $(cat "$home/herdr.log")"
  grep -qF 'tab create --workspace wNEW --label fix-bug' "$home/herdr.log" \
    || fail "fallback did not place the tab in the created project workspace: $(cat "$home/herdr.log")"
  # A freshly-created workspace has an orphan root shell that must be closed.
  grep -qF 'pane close wX:p1' "$home/herdr.log" \
    || fail "fallback did not close the fresh workspace's orphan root shell: $(cat "$home/herdr.log")"
  meta="$home/state/fix-bug-m2.meta"
  grep -qF 'workspace=myproj' "$meta" || fail "fallback meta workspace not the project label"
  pass "outside herdr, crew fall back to a project-labeled workspace"
}

# Build a seeded secondmate home (marker + operational dirs), optionally with
# already-repaired shared-code symlinks. Echoes the home path.
# Args: case-name id supervisor-name with_shared_links(0|1)
make_secondmate_home() {
  local name=$1 id=$2 supname=$3 with_files=$4 home
  home="$TMP_ROOT/$name-smhome"
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects"
  printf '%s' "$id" > "$home/.fm-secondmate-home"
  printf 'name=%s\n' "$supname" > "$home/config/identity"
  printf 'charter\n' > "$home/data/charter.md"
  if [ "$with_files" = 1 ]; then
    ln -s "$ROOT/AGENTS.md" "$home/AGENTS.md"
    ln -s AGENTS.md "$home/CLAUDE.md"
    ln -s "$ROOT/bin" "$home/bin"
  fi
  printf '%s\n' "$home"
}

test_secondmate_lands_in_own_named_workspace() {
  local home fakebin smhome out
  home=$(make_case sm-ship shipproj Mate)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  smhome=$(make_secondmate_home sm-ship anchor Anchor 1)

  out=$(run_spawn "$home" "$fakebin" anchor "$smhome" omp --secondmate) \
    || fail "secondmate spawn failed: $out"

  grep -qF 'workspace create --label Anchor' "$home/herdr.log" \
    || fail "secondmate did not create its own named workspace: $(cat "$home/herdr.log")"
  grep -qF 'tab create --workspace wNEW --label home' "$home/herdr.log" \
    || fail "secondmate own tab not labeled 'home' (avoids the 'Name . Name' duplicate): $(cat "$home/herdr.log")"
  # The secondmate's workspace carries its name (Anchor); its own tab is labeled
  # "home" so the space reads "Anchor . home" instead of the duplicate
  # "Anchor . Anchor". The herdr agent SLOT is the unique task id (here `anchor`),
  # never the harness name, so concurrent secondmates do not collide.
  # agent_identity=omp is recorded in meta.
  grep -qF 'agent start anchor --tab wX:t9' "$home/herdr.log" \
    || fail "secondmate agent not started under the unique task-id slot: $(cat "$home/herdr.log")"
  grep -q 'agent start anchor .*--env PATH=' "$home/herdr.log" \
    || fail "secondmate agent start did not pass --env PATH (binary would not resolve on the daemon PATH): $(cat "$home/herdr.log")"
  grep -qF 'pane rename wX:p10 home' "$home/herdr.log" \
    || fail "secondmate spawn-time pane label not 'home' (it renames to its name at bootstrap): $(cat "$home/herdr.log")"
  ! grep -qF 'agent rename' "$home/herdr.log" \
    || fail "agent rename appeared; it breaks the omp<->herdr status binding: $(cat "$home/herdr.log")"
  grep -qF 'agent_identity=omp' "$home/state/anchor.meta" \
    || fail "secondmate meta missing agent_identity=omp"
  grep -qF 'tab=wX:t9' "$home/state/anchor.meta" \
    || fail "secondmate meta missing herdr tab id"
  grep -qF 'pane close wX:p1' "$home/herdr.log" \
    || fail "secondmate spawn did not close the fresh workspace's orphan root shell: $(cat "$home/herdr.log")"
  pass "secondmate lands in its own named workspace (its home) with omp identity"
}

test_secondmate_home_autolinks_missing_files() {
  local home fakebin smhome out
  home=$(make_case sm-autolink shipproj Mate)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  smhome=$(make_secondmate_home sm-autolink anchor2 Anchor 0)

  out=$(run_spawn "$home" "$fakebin" anchor2 "$smhome" omp --secondmate) \
    || fail "secondmate spawn with missing files failed (should auto-link): $out"

  [ -L "$smhome/AGENTS.md" ] || fail "AGENTS.md was not auto-linked into the home"
  [ -L "$smhome/bin" ] || fail "bin was not auto-linked into the home"
  [ -e "$smhome/AGENTS.md" ] || fail "auto-linked AGENTS.md does not resolve"
  [ -d "$smhome/bin" ] || fail "auto-linked bin does not resolve to a directory"
  pass "secondmate home missing AGENTS.md/bin is auto-linked, not rejected"
}

test_secondmate_omp_overlay_is_injected_when_present() {
  local home fakebin smhome smhome_abs out
  home=$(make_case sm-overlay shipproj Mate)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  smhome=$(make_secondmate_home sm-overlay anchor3 Anchor 1)
  smhome_abs=$(cd "$smhome" && pwd -P)
  printf 'modelRoles:\n  default: openai-codex/gpt-5.4-mini\n' > "$smhome/config/omp-overlay.yml"

  out=$(run_spawn "$home" "$fakebin" anchor3 "$smhome" omp --secondmate) \
    || fail "secondmate spawn with overlay failed: $out"

  grep -qF -- "--config '$smhome_abs/config/omp-overlay.yml'" "$home/herdr.log" \
    || fail "omp overlay config path was not injected into the secondmate launch: $(cat "$home/herdr.log")"
  grep -qF -- "--approval-mode=write" "$home/herdr.log" \
    || fail "secondmate omp launch did not raise approval friction for hands-on tools: $(cat "$home/herdr.log")"
  pass "secondmate omp overlay is injected into the fresh launch"
}

test_secondmate_omp_overlay_is_omitted_when_absent() {
  local home fakebin smhome smhome_abs out base_cmd
  home=$(make_case sm-no-overlay shipproj Mate)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  smhome=$(make_secondmate_home sm-no-overlay anchor4 Anchor 1)
  smhome_abs=$(cd "$smhome" && pwd -P)
  out=$(run_spawn "$home" "$fakebin" anchor4 "$smhome" omp --secondmate) \
    || fail "secondmate spawn without overlay failed: $out"

  base_cmd="omp --auto-approve --approval-mode=write \"\$(cat '$smhome_abs/data/charter.md')\""
  grep -qF -- "$base_cmd" "$home/herdr.log" \
    || fail "omp launch changed despite no overlay file: $(cat "$home/herdr.log")"
  ! grep -qF -- '--config ' "$home/herdr.log" \
    || fail "omp launch unexpectedly included --config without an overlay file: $(cat "$home/herdr.log")"
  pass "secondmate omp launch stays unchanged when no overlay file exists"
}

# The worktree-isolation guard must refuse to launch when the just-created
# worktree resolves to the primary project checkout, and must clean up after
# itself (no leaked worktree/branch, no agent started).
test_spawn_refuses_when_worktree_resolves_to_primary_checkout() {
  local home fakebin out realgit
  home=$(make_case crew-tangle myproj Mate)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  mkdir -p "$home/data/fix-tangle-k3"
  printf 'brief\n' > "$home/data/fix-tangle-k3/brief.md"
  add_fake_git "$fakebin"
  realgit=$(command -v git)

  out=$(FM_REAL_GIT="$realgit" \
        FM_FAKE_WT="$home/worktrees/fix-tangle-k3" \
        FM_FAKE_TOPLEVEL="$(cd "$home/projects/myproj" && pwd -P)" \
        run_spawn "$home" "$fakebin" fix-tangle-k3 projects/myproj omp) \
    && fail "spawn launched despite the worktree resolving to the primary checkout: $out"

  printf '%s\n' "$out" | grep -qF 'refusing to launch' \
    || fail "spawn did not refuse with an isolation error: $out"
  printf '%s\n' "$out" | grep -qF 'primary checkout' \
    || fail "refusal did not mention the primary checkout: $out"
  ! grep -qF 'agent start' "$home/herdr.log" 2>/dev/null \
    || fail "agent was started despite the isolation refusal: $(cat "$home/herdr.log")"
  [ ! -d "$home/worktrees/fix-tangle-k3" ] \
    || fail "refused spawn left its worktree behind"
  ! "$realgit" -C "$home/projects/myproj" rev-parse --verify --quiet refs/heads/fm/fix-tangle-k3 >/dev/null 2>&1 \
    || fail "refused spawn left its branch behind"
  pass "spawn refuses to launch when the worktree resolves to the primary checkout"
}

test_workspace_orphan_pane_closed_on_agent_start_failure() {
  local home fakebin out
  home=$(make_case crew-fail-cleanup myproj Mate)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  mkdir -p "$home/data/add-feat-r5"
  printf 'brief\n' > "$home/data/add-feat-r5/brief.md"

  out=$(
    export FM_FAKE_AGENT_START_FAIL=1
    run_spawn "$home" "$fakebin" add-feat-r5 projects/myproj omp
  ) && fail "spawn should have failed when agent start fails: $out"

  grep -qF 'pane close wX:p1' "$home/herdr.log" \
    || fail "agent start failure did not close the fresh workspace's orphan root shell: $(cat "$home/herdr.log")"
  [ ! -d "$home/worktrees/add-feat-r5" ] \
    || fail "failed spawn left its worktree behind"
  ! git -C "$home/projects/myproj" rev-parse --verify --quiet refs/heads/fm/add-feat-r5 >/dev/null 2>&1 \
    || fail "failed spawn left its branch behind"
  pass "workspace orphan root shell closed even when agent start fails"
}

# Reuse regression (ports upstream #202 "reuse the workspace instead of leaking
# one per spawn" onto this ship's resolve path): outside herdr, when the
# project-labeled workspace ALREADY exists, the spawn REUSES it - it must NOT
# create a second workspace, and there is no fresh workspace, hence no orphan
# root shell to close.
test_crewmate_fallback_reuses_existing_project_workspace() {
  local home fakebin out meta
  home=$(make_case crew-fallback-reuse myproj Mate)
  fakebin=$(make_fake_herdr "$home")
  # No live current workspace (spawned outside herdr), but the project-labeled
  # workspace already exists from a prior spawn.
  printf 'myproj\twEXIST\n' > "$home/ws.tsv"
  mkdir -p "$home/data/fix-again-p3"
  printf 'brief\n' > "$home/data/fix-again-p3/brief.md"

  out=$(run_spawn "$home" "$fakebin" fix-again-p3 projects/myproj omp) \
    || fail "spawn failed: $out"

  ! grep -qF 'workspace create' "$home/herdr.log" \
    || fail "reused-workspace spawn created a second workspace instead of reusing the existing one: $(cat "$home/herdr.log")"
  grep -qF 'tab create --workspace wEXIST --label fix-again' "$home/herdr.log" \
    || fail "tab not created in the existing project workspace: $(cat "$home/herdr.log")"
  # Reuse path yields no fresh workspace, so there is no orphan workspace init
  # pane to close (only the new tab's own root shell wX:p9).
  ! grep -qF 'pane close wX:p1' "$home/herdr.log" \
    || fail "reuse path closed a workspace init pane, but no workspace was created: $(cat "$home/herdr.log")"
  grep -qF 'pane close wX:p9' "$home/herdr.log" \
    || fail "the new tab's own root shell was not closed: $(cat "$home/herdr.log")"
  meta="$home/state/fix-again-p3.meta"
  grep -qF 'workspace=myproj' "$meta" || fail "reuse meta workspace not the project label"
  ! grep -q '^workspace_id=' "$meta" \
    || fail "meta recorded workspace_id; teardown would destroy the shared workspace"
  pass "outside herdr, crew reuse an existing project workspace instead of leaking one"
}

# Reuse regression for a secondmate (recovery respawn): a secondmate whose named
# home workspace already exists reuses it rather than minting a second one.
test_secondmate_reuses_existing_named_workspace() {
  local home fakebin smhome out
  home=$(make_case sm-reuse shipproj Mate)
  fakebin=$(make_fake_herdr "$home")
  smhome=$(make_secondmate_home sm-reuse anchor Anchor 1)
  # The secondmate's own named workspace already exists (as after a restart).
  printf 'Anchor\twSM\n' > "$home/ws.tsv"

  out=$(run_spawn "$home" "$fakebin" anchor "$smhome" omp --secondmate) \
    || fail "secondmate respawn failed: $out"

  ! grep -qF 'workspace create' "$home/herdr.log" \
    || fail "secondmate respawn created a second named workspace instead of reusing it: $(cat "$home/herdr.log")"
  grep -qF 'tab create --workspace wSM --label home' "$home/herdr.log" \
    || fail "secondmate did not reuse its existing named workspace: $(cat "$home/herdr.log")"
  ! grep -qF 'pane close wX:p1' "$home/herdr.log" \
    || fail "secondmate reuse path closed a workspace init pane, but no workspace was created: $(cat "$home/herdr.log")"
  pass "secondmate reuses its existing named workspace on respawn instead of leaking one"
}
# --model/--effort are threaded into the crewmate's launch command (omp: --model
# + --thinking) and recorded in meta, so an easy task can spawn on a cheap model.
test_crewmate_model_effort_threaded_into_launch() {
  local home fakebin out
  home=$(make_case crew-model myproj Mate)
  fakebin=$(make_fake_herdr "$home")
  printf 'firstmate\twV\n' > "$home/ws.tsv"
  mkdir -p "$home/data/easy-fix-k3"
  printf 'brief\n' > "$home/data/easy-fix-k3/brief.md"

  out=$(FM_FAKE_CURRENT_WSID=wV run_spawn "$home" "$fakebin" easy-fix-k3 projects/myproj omp --model gpt-5.4-mini --effort low) \
    || fail "spawn failed: $out"

  grep -qF -- "--model 'gpt-5.4-mini'" "$home/herdr.log" \
    || fail "launch command did not carry the fuzzy --model: $(grep 'agent start' "$home/herdr.log")"
  grep -qF -- "--thinking 'low'" "$home/herdr.log" \
    || fail "launch command did not map --effort to omp --thinking: $(grep 'agent start' "$home/herdr.log")"
  grep -qF 'model=gpt-5.4-mini' "$home/state/easy-fix-k3.meta" || fail "meta missing model="
  grep -qF 'effort=low' "$home/state/easy-fix-k3.meta" || fail "meta missing effort="
  pass "crewmate --model/--effort thread into the launch command and meta"
}

# A default spawn (no --model/--effort) produces the byte-identical baseline
# command and records the default sentinels, so the knob is opt-in only.
test_crewmate_no_model_effort_is_baseline() {
  local home fakebin out
  home=$(make_case crew-baseline myproj Mate)
  fakebin=$(make_fake_herdr "$home")
  printf 'firstmate\twV\n' > "$home/ws.tsv"
  mkdir -p "$home/data/plain-q7"
  printf 'brief\n' > "$home/data/plain-q7/brief.md"

  out=$(FM_FAKE_CURRENT_WSID=wV run_spawn "$home" "$fakebin" plain-q7 projects/myproj omp) \
    || fail "spawn failed: $out"

  ! grep -qF -- '--model' "$home/herdr.log" \
    || fail "unpinned spawn leaked a --model flag: $(grep 'agent start' "$home/herdr.log")"
  ! grep -qF -- '--thinking' "$home/herdr.log" \
    || fail "unpinned spawn leaked a --thinking flag: $(grep 'agent start' "$home/herdr.log")"
  grep -qF 'model=default' "$home/state/plain-q7.meta" || fail "meta missing model=default"
  grep -qF 'effort=default' "$home/state/plain-q7.meta" || fail "meta missing effort=default"
  pass "an unpinned spawn stays at the baseline command (no model/effort flags)"
}

# A secondmate resolved from config/secondmate-harness inherits its pinned
# model/effort tokens durably (this is the #180 intent on this ship).
test_secondmate_pin_from_config_threaded() {
  local home fakebin smhome out
  home=$(make_case sm-pin shipproj Mate)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  # Primary's own config pins the harness + model + effort for its secondmates.
  printf 'omp gpt-5.4-mini low\n' > "$home/config/secondmate-harness"
  smhome=$(make_secondmate_home sm-pin anchor Anchor 1)

  # No explicit harness arg, so the harness (and its pinned model/effort) come
  # from config/secondmate-harness.
  out=$(run_spawn "$home" "$fakebin" anchor "$smhome" --secondmate) \
    || fail "secondmate spawn failed: $out"

  grep -qF 'gpt-5.4-mini' "$home/herdr.log" \
    || fail "secondmate launch did not carry the config-pinned model: $(grep 'agent start' "$home/herdr.log")"
  grep -qF -- '--thinking' "$home/herdr.log" \
    || fail "secondmate launch did not carry the config-pinned effort flag: $(grep 'agent start' "$home/herdr.log")"
  grep -qF 'low' "$home/herdr.log" \
    || fail "secondmate launch did not carry the config-pinned low effort: $(grep 'agent start' "$home/herdr.log")"
  grep -qF 'model=gpt-5.4-mini' "$home/state/anchor.meta" || fail "secondmate meta missing pinned model="
  grep -qF 'effort=low' "$home/state/anchor.meta" || fail "secondmate meta missing pinned effort="
  pass "a secondmate inherits its config/secondmate-harness model/effort pin"
}
test_secondmate_explicit_flags_override_pin() {
  local home fakebin smhome out
  home=$(make_case sm-pin-override shipproj Mate)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  printf 'omp gpt-5.4-mini low\n' > "$home/config/secondmate-harness"
  smhome=$(make_secondmate_home sm-pin-override anchor Anchor 1)

  out=$(run_spawn "$home" "$fakebin" anchor "$smhome" --secondmate --model opus --effort high) \
    || fail "secondmate spawn failed: $out"

  grep -qF -- '--model' "$home/herdr.log" \
    || fail "explicit --model did not reach the launch command: $(grep 'agent start' "$home/herdr.log")"
  grep -qF -- 'opus' "$home/herdr.log" \
    || fail "explicit --model did not override the config pin: $(grep 'agent start' "$home/herdr.log")"
  grep -qF -- '--thinking' "$home/herdr.log" \
    || fail "explicit --effort did not reach the launch command: $(grep 'agent start' "$home/herdr.log")"
  grep -qF -- 'high' "$home/herdr.log" \
    || fail "explicit --effort did not override the config pin: $(grep 'agent start' "$home/herdr.log")"
  ! grep -qF -- 'gpt-5.4-mini' "$home/herdr.log" \
    || fail "config-pinned model leaked despite an explicit override"
  pass "explicit --model/--effort override the config/secondmate-harness pin"
}


# Emergency limit-mode forces the OpenAI Codex lane through omp, low effort, and ignores
# ordinary harness/model/effort requests. This is the deterministic supervisor
# fallback profile.
test_emergency_limit_mode_forces_openai_codex_lane() {
  local home fakebin smhome out
  home=$(make_case sm-limit-mode shipproj Mate)
  fakebin=$(make_fake_herdr "$home")
  mkdir -p "$fakebin"
  cat > "$fakebin/omp" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$fakebin/omp"
  : > "$home/ws.tsv"
  smhome=$(make_secondmate_home sm-limit-mode anchor Anchor 1)
  : > "$home/state/emergency-limit-mode"

  out=$(PATH="$fakebin:/usr/bin:/bin" FM_SPAWN_NO_GUARD=1 run_spawn "$home" "$fakebin" anchor "$smhome" claude --secondmate --model opus --effort high) \
    || fail "emergency-mode secondmate spawn failed: $out"

  grep -qF -- 'omp --auto-approve' "$home/herdr.log" \
    || fail "emergency mode did not force the OpenAI Codex GPT lane through omp: $(grep 'agent start' "$home/herdr.log")"
  grep -qF -- "openai-codex/gpt-5.4-mini" "$home/herdr.log" \
    || fail "emergency mode did not use a provider-qualified GPT model: $(grep 'agent start' "$home/herdr.log")"
  grep -qF -- "--thinking 'low'" "$home/herdr.log" \
    || fail "emergency mode did not force low effort: $(grep 'agent start' "$home/herdr.log")"
  ! grep -qF -- 'claude --dangerously-skip-permissions' "$home/herdr.log" \
    || fail "emergency mode leaked the requested non-omp harness: $(grep 'agent start' "$home/herdr.log")"
  ! grep -qF -- "--model 'opus'" "$home/herdr.log" \
    || fail "emergency mode leaked the requested model override: $(grep 'agent start' "$home/herdr.log")"
  grep -qF 'model=openai-codex/gpt-5.4-mini' "$home/state/anchor.meta" \
    || fail "emergency mode did not record the forced OpenAI Codex model"
  grep -qF 'effort=low' "$home/state/anchor.meta" \
    || fail "emergency mode did not record the forced low effort"
  pass "emergency limit-mode forces the OpenAI Codex GPT lane through omp and low effort"
}

# If omp is unavailable, emergency mode parks the launch and reports
# the exact unblock condition instead of trying an alternate harness.
test_emergency_limit_mode_reports_blocking_condition() {
  local home fakebin smhome out
  home=$(make_case sm-limit-block shipproj Mate)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  smhome=$(make_secondmate_home sm-limit-block anchor Anchor 1)
  : > "$home/state/emergency-limit-mode"

  if PATH="$fakebin:/usr/bin:/bin" FM_SPAWN_NO_GUARD=1 run_spawn "$home" "$fakebin" anchor "$smhome" omp --secondmate >/dev/null 2>&1; then
    fail "emergency mode should have blocked without an omp binary"
  fi

  grep -qF 'blocked: emergency limit-mode - omp command not found; install omp or remove emergency-limit-mode' "$home/state/anchor.status" \
    || fail "emergency mode did not report the exact omp unblock condition"
  pass "emergency limit-mode parks and reports the omp unblock condition"
}


test_crewmate_lands_in_spawners_current_workspace
test_crewmate_single_agent_pane
test_crewmate_in_secondmate_home_nests_under_mate_workspace
test_crewmate_fallback_creates_project_workspace_outside_herdr
test_crewmate_fallback_reuses_existing_project_workspace
test_secondmate_lands_in_own_named_workspace
test_secondmate_reuses_existing_named_workspace
test_secondmate_home_autolinks_missing_files
test_secondmate_omp_overlay_is_injected_when_present
test_secondmate_omp_overlay_is_omitted_when_absent
test_spawn_refuses_when_worktree_resolves_to_primary_checkout
test_workspace_orphan_pane_closed_on_agent_start_failure
test_crewmate_model_effort_threaded_into_launch
test_crewmate_no_model_effort_is_baseline
test_secondmate_pin_from_config_threaded
test_secondmate_explicit_flags_override_pin
test_emergency_limit_mode_forces_openai_codex_lane
test_emergency_limit_mode_reports_blocking_condition
