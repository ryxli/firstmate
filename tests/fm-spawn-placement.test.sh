#!/usr/bin/env bash
# Behavior tests for fm-spawn.sh deterministic herdr placement + labeling.
#
# These exercise the real placement path with a fake `herdr` on PATH (recording
# every invocation) and a real throwaway git repo for the project, so the git
# worktree creation is genuine while the herdr workspace/tab/agent calls are
# captured for assertion. FM_SPAWN_NO_GUARD=1 keeps them off the live watcher.
#
# What is asserted:
#   - a crewmate lands in a workspace LABELED by the project (not the task id),
#     creating it when absent and REUSING it when it already exists;
#   - the crewmate gets its OWN tab + pane DISPLAY-labeled "<supervisor>/<task-slug>"
#     with the random task id kept out of the visible label, while the herdr agent
#     identity stays the integration-safe key (omp) and is NEVER renamed;
#   - the tab ends as a SINGLE agent pane: the leftover root shell is closed;
#   - the meta records tab=, supervisor lineage, and agent_identity=omp, but no
#     workspace_id (so teardown does per-task cleanup, never destroying the shared
#     domain workspace);
#   - a --secondmate lands in its own workspace named after the secondmate (its home);
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
        printf '{"result":{"workspace":{"workspace_id":"%s"}}}\n' "$wid"
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
      start) printf '{"result":{"agent":{"pane_id":"%s"}}}\n' "${FM_FAKE_AGENT_PANE:-wX:p10}"; exit 0 ;;
    esac ;;
  pane)
    case "${2:-}" in close|run) exit 0 ;; get) printf '{"pane_id":"wX:p10"}\n'; exit 0 ;; esac ;;
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
    FM_FAKE_ROOT_PANE="wX:p9" FM_FAKE_AGENT_PANE="wX:p10" \
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
  if [ -n "${FM_FAKE_TOPLEVEL:-}" ] && [ "${2:-}" = "${FM_FAKE_WT:-}" ]; then
    printf '%s\n' "$FM_FAKE_TOPLEVEL"
    exit 0
  fi
fi
exec "${FM_REAL_GIT:?}" "$@"
SH
  chmod +x "$fakebin/git"
}

test_crewmate_creates_domain_workspace_and_own_tab() {
  local home fakebin out meta
  home=$(make_case crew-new myproj Mate)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  mkdir -p "$home/data/fix-login-k3"
  printf 'brief\n' > "$home/data/fix-login-k3/brief.md"

  out=$(run_spawn "$home" "$fakebin" fix-login-k3 projects/myproj omp) \
    || fail "spawn failed: $out"

  grep -qF 'workspace create --label myproj' "$home/herdr.log" \
    || fail "did not create a workspace labeled by project: $(cat "$home/herdr.log")"
  ! grep -qF 'workspace create --label fix-login-k3' "$home/herdr.log" \
    || fail "workspace was labeled by raw task id, not the project"
  grep -qF 'tab create --workspace wNEW --label mate/fix-login' "$home/herdr.log" \
    || fail "tab not created in domain workspace with worker display label: $(cat "$home/herdr.log")"
  # The herdr agent SLOT name is the UNIQUE task id (not the harness name), so
  # concurrent crewmates never collide on the agent name; the omp<->herdr status
  # binding survives via the integration's socket self-report (agent_identity=omp).
  grep -qF 'agent start fix-login-k3 --tab wX:t9' "$home/herdr.log" \
    || fail "agent not started in its own tab under the unique task-id slot: $(cat "$home/herdr.log")"
  grep -q 'agent start fix-login-k3 .*--env PATH=' "$home/herdr.log" \
    || fail "agent start did not pass --env PATH (omp would not resolve on the daemon PATH): $(cat "$home/herdr.log")"
  grep -qF 'pane rename wX:p10 mate/fix-login' "$home/herdr.log" \
    || fail "pane was not given its worker display label: $(cat "$home/herdr.log")"
  ! grep -qF 'agent rename' "$home/herdr.log" \
    || fail "agent rename appeared; it breaks the omp<->herdr status binding: $(cat "$home/herdr.log")"

  meta="$home/state/fix-login-k3.meta"
  [ -f "$meta" ] || fail "no meta written"
  grep -qF 'pane=wX:p10' "$meta" || fail "meta pane not the agent pane"
  grep -qF 'tab=wX:t9' "$meta" || fail "meta missing herdr tab id"
  grep -qF 'workspace=myproj' "$meta" || fail "meta missing workspace label"
  grep -qF 'worker=mate/fix-login' "$meta" || fail "meta missing worker label"
  grep -qF 'domain=myproj' "$meta" || fail "meta missing domain"
  grep -qF 'supervisor=Mate' "$meta" || fail "meta missing supervisor name"
  grep -qF 'agent_identity=omp' "$meta" || fail "meta missing agent_identity=omp"
  ! grep -q '^workspace_id=' "$meta" \
    || fail "meta recorded workspace_id; teardown would destroy the shared workspace"
  pass "crewmate creates project-labeled workspace, omp agent identity, worker display labels"
}

test_crewmate_single_agent_pane() {
  local home fakebin out
  home=$(make_case crew-single myproj Mate)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  mkdir -p "$home/data/add-x-q7"
  printf 'brief\n' > "$home/data/add-x-q7/brief.md"

  out=$(run_spawn "$home" "$fakebin" add-x-q7 projects/myproj omp) \
    || fail "spawn failed: $out"

  # The leftover root shell pane must be closed so the tab is a single agent pane.
  grep -qF 'pane close wX:p9' "$home/herdr.log" \
    || fail "root shell pane was not closed; tab would be a split beside a blank shell: $(cat "$home/herdr.log")"
  pass "spawned tab ends as a single agent pane (root shell closed)"
}

test_crewmate_reuses_existing_domain_workspace() {
  local home fakebin out
  home=$(make_case crew-reuse myproj Mate)
  fakebin=$(make_fake_herdr "$home")
  printf 'myproj\twEXIST\n' > "$home/ws.tsv"
  mkdir -p "$home/data/fix-bug-m2"
  printf 'brief\n' > "$home/data/fix-bug-m2/brief.md"

  out=$(run_spawn "$home" "$fakebin" fix-bug-m2 projects/myproj omp) \
    || fail "spawn failed: $out"

  ! grep -qF 'workspace create' "$home/herdr.log" \
    || fail "created a new workspace instead of reusing the existing labeled one"
  grep -qF 'tab create --workspace wEXIST --label mate/fix-bug' "$home/herdr.log" \
    || fail "did not add the tab to the existing domain workspace: $(cat "$home/herdr.log")"
  pass "crewmate reuses the existing project-labeled workspace"
}

# Build a seeded secondmate home (marker + operational dirs), optionally missing
# AGENTS.md/bin so the auto-link path is exercised. Echoes the home path.
# Args: case-name id supervisor-name with_agents_md(0|1)
make_secondmate_home() {
  local name=$1 id=$2 supname=$3 with_files=$4 home
  home="$TMP_ROOT/$name-smhome"
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects"
  printf '%s' "$id" > "$home/.fm-secondmate-home"
  printf 'name=%s\n' "$supname" > "$home/config/identity"
  printf 'charter\n' > "$home/data/charter.md"
  if [ "$with_files" = 1 ]; then
    printf '# fm\n' > "$home/AGENTS.md"
    mkdir -p "$home/bin"
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
  grep -qF 'tab create --workspace wNEW --label Anchor' "$home/herdr.log" \
    || fail "secondmate did not get its own tab labeled by name: $(cat "$home/herdr.log")"
  # The secondmate's display label (its own name) goes on the tab + pane; the herdr
  # agent SLOT is the unique task id (here `anchor`), never the harness name, so
  # concurrent secondmates do not collide. agent_identity=omp is recorded in meta.
  grep -qF 'agent start anchor --tab wX:t9' "$home/herdr.log" \
    || fail "secondmate agent not started under the unique task-id slot: $(cat "$home/herdr.log")"
  grep -q 'agent start anchor .*--env PATH=' "$home/herdr.log" \
    || fail "secondmate agent start did not pass --env PATH (binary would not resolve on the daemon PATH): $(cat "$home/herdr.log")"
  grep -qF 'pane rename wX:p10 Anchor' "$home/herdr.log" \
    || fail "secondmate pane did not get its display label: $(cat "$home/herdr.log")"
  ! grep -qF 'agent rename' "$home/herdr.log" \
    || fail "agent rename appeared; it breaks the omp<->herdr status binding: $(cat "$home/herdr.log")"
  grep -qF 'agent_identity=omp' "$home/state/anchor.meta" \
    || fail "secondmate meta missing agent_identity=omp"
  grep -qF 'tab=wX:t9' "$home/state/anchor.meta" \
    || fail "secondmate meta missing herdr tab id"
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

test_crewmate_creates_domain_workspace_and_own_tab
test_crewmate_single_agent_pane
test_crewmate_reuses_existing_domain_workspace
test_secondmate_lands_in_own_named_workspace
test_secondmate_home_autolinks_missing_files
test_spawn_refuses_when_worktree_resolves_to_primary_checkout
