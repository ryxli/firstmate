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
#   - the crewmate gets its OWN tab + agent labeled "<supervisor>/<task-slug>",
#     with the random task id kept out of the visible label;
#   - the tab ends as a SINGLE agent pane: the leftover root shell is closed;
#   - the meta records no workspace_id (so teardown does per-task cleanup, never
#     destroying the shared domain workspace);
#   - a --secondmate lands in its own tab inside the single `ship` workspace;
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
    "$SPAWN" "$@" 2>&1
}

test_crewmate_creates_domain_workspace_and_own_tab() {
  local home fakebin out meta
  home=$(make_case crew-new myproj Keel)
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
  grep -qF 'tab create --workspace wNEW --label keel/fix-login' "$home/herdr.log" \
    || fail "tab not created in domain workspace with worker label: $(cat "$home/herdr.log")"
  grep -qF 'agent start keel/fix-login --tab wX:t9' "$home/herdr.log" \
    || fail "agent not started in its own tab with worker label: $(cat "$home/herdr.log")"

  meta="$home/state/fix-login-k3.meta"
  [ -f "$meta" ] || fail "no meta written"
  grep -qF 'pane=wX:p10' "$meta" || fail "meta pane not the agent pane"
  grep -qF 'workspace=myproj' "$meta" || fail "meta missing workspace label"
  grep -qF 'worker=keel/fix-login' "$meta" || fail "meta missing worker label"
  grep -qF 'domain=myproj' "$meta" || fail "meta missing domain"
  ! grep -q '^workspace_id=' "$meta" \
    || fail "meta recorded workspace_id; teardown would destroy the shared workspace"
  pass "crewmate creates project-labeled workspace and its own labeled tab/agent"
}

test_crewmate_single_agent_pane() {
  local home fakebin out
  home=$(make_case crew-single myproj Keel)
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
  home=$(make_case crew-reuse myproj Keel)
  fakebin=$(make_fake_herdr "$home")
  printf 'myproj\twEXIST\n' > "$home/ws.tsv"
  mkdir -p "$home/data/fix-bug-m2"
  printf 'brief\n' > "$home/data/fix-bug-m2/brief.md"

  out=$(run_spawn "$home" "$fakebin" fix-bug-m2 projects/myproj omp) \
    || fail "spawn failed: $out"

  ! grep -qF 'workspace create' "$home/herdr.log" \
    || fail "created a new workspace instead of reusing the existing labeled one"
  grep -qF 'tab create --workspace wEXIST --label keel/fix-bug' "$home/herdr.log" \
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

test_secondmate_lands_in_ship_workspace_own_tab() {
  local home fakebin smhome out
  home=$(make_case sm-ship shipproj Keel)
  fakebin=$(make_fake_herdr "$home")
  : > "$home/ws.tsv"
  smhome=$(make_secondmate_home sm-ship anchor Anchor 1)

  out=$(run_spawn "$home" "$fakebin" anchor "$smhome" omp --secondmate) \
    || fail "secondmate spawn failed: $out"

  grep -qF 'workspace create --label ship' "$home/herdr.log" \
    || fail "secondmate did not target the ship workspace: $(cat "$home/herdr.log")"
  grep -qF 'tab create --workspace wNEW --label Anchor' "$home/herdr.log" \
    || fail "secondmate did not get its own ship tab labeled by name: $(cat "$home/herdr.log")"
  grep -qF 'agent start Anchor --tab wX:t9' "$home/herdr.log" \
    || fail "secondmate agent not started in its own tab: $(cat "$home/herdr.log")"
  pass "secondmate lands in its own tab inside the ship workspace"
}

test_secondmate_home_autolinks_missing_files() {
  local home fakebin smhome out
  home=$(make_case sm-autolink shipproj Keel)
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

test_crewmate_creates_domain_workspace_and_own_tab
test_crewmate_single_agent_pane
test_crewmate_reuses_existing_domain_workspace
test_secondmate_lands_in_ship_workspace_own_tab
test_secondmate_home_autolinks_missing_files
