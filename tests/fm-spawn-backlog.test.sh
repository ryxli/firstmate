#!/usr/bin/env bash
# Focused integration test: `fm spawn` records the dispatched task through the
# native `fm tasks add --start` verb (verbs/tasks.ts), not a hand-rolled
# append or an external tasks-axi probe. This exercises the real spawn
# subprocess/env wiring (appendBacklogInflight -> spawnSync sbin/fm tasks add),
# not just a standalone `fm tasks add` call.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPAWN="$ROOT/sbin/fm"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-spawn-backlog.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

make_fake_herdr() {
  local name=$1
  local fakebin="$TMP_ROOT/$name-fakebin"
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  'pane list')
    printf '{"result":{"panes":[]}}\n'
    ;;
  'pane current')
    printf '{"result":{"pane":{"pane_id":"w-parent:p1","workspace_id":"w-parent"}}}\n'
    ;;
  'tab create')
    printf '{"result":{"tab":{"tab_id":"w-parent:t2"},"root_pane":{"pane_id":"w-parent:p2"}}}\n'
    ;;
  'agent get')
    exit 1
    ;;
  'agent start')
    printf '{"result":{"agent":{"pane_id":"w-parent:p3"}}}\n'
    ;;
  'pane close'|'pane rename'|'tab close')
    ;;
esac
SH
  chmod +x "$fakebin/herdr"
  for harness in omp claude codex opencode pi; do
    cat > "$fakebin/$harness" <<'SH'
#!/usr/bin/env bash
exit 0
SH
    chmod +x "$fakebin/$harness"
  done
  printf '%s\n' "$fakebin"
}

make_supervisor_home() {
  local name=$1
  local home="$TMP_ROOT/$name-supervisor"
  mkdir -p "$home/config" "$home/data" "$home/projects" "$home/state" "$home/worktrees"
  printf 'name=Test Supervisor\n' > "$home/config/identity"
  printf '%s\n' '- demo [pr] - test project' > "$home/data/projects.md"
  printf '%s\n' "$home"
}

make_project() {
  local home=$1 project
  project="$home/projects/demo"
  mkdir -p "$project"
  git -C "$project" init -q
  git -C "$project" config user.name 'Spawn Tests'
  git -C "$project" config user.email 'spawn-tests@example.invalid'
  printf 'seed\n' > "$project/seed.txt"
  git -C "$project" add seed.txt
  git -C "$project" commit -qm initial
  printf '%s\n' "$project"
}

run_spawn() {
  local home=$1 fakebin=$2; shift 2
  mkdir -p "$home/data/$1"
  printf 'test brief\n' > "$home/data/$1/brief.md"
  PATH="$fakebin:$PATH" \
    FM_HOME="$home" \
    FM_STATE_OVERRIDE='' FM_DATA_OVERRIDE='' FM_PROJECTS_OVERRIDE='' FM_CONFIG_OVERRIDE='' \
    FM_HUSK_REAP_SETTLE=0 \
    "$SPAWN" spawn "$@" >/dev/null 2>&1
}

test_spawn_records_in_flight_via_native_fm_tasks() {
  local home fakebin project
  home=$(make_supervisor_home t1)
  fakebin=$(make_fake_herdr t1)
  project=$(make_project "$home")

  run_spawn "$home" "$fakebin" backlog-demo-1 "$project" \
    || fail "spawn failed"

  [ -f "$home/data/backlog.md" ] || fail "spawn did not create data/backlog.md"
  grep -F '## In flight' "$home/data/backlog.md" >/dev/null \
    || fail "backlog is missing the In flight section"
  grep -qE -- '^- \[ \] backlog-demo-1 - ship task .*\(repo: demo\).*\(since [0-9]{4}-[0-9]{2}-[0-9]{2}\)$' "$home/data/backlog.md" \
    || fail "spawn did not record the native fm tasks add line: $(cat "$home/data/backlog.md")"

  # The recorded line round-trips through `fm tasks show` (proves it landed
  # through the real backlog engine, not a hand-rolled string).
  out=$(FM_HOME="$home" "$SPAWN" tasks show backlog-demo-1) \
    || fail "fm tasks show could not read the task spawn recorded"
  printf '%s\n' "$out" | grep -qF 'inflight' \
    || fail "fm tasks show did not report the spawned task as in flight: $out"

  pass "fm spawn records the in-flight task through native fm tasks add --start"
}

test_spawn_backlog_recording_is_idempotent_on_reentry() {
  local home fakebin project
  home=$(make_supervisor_home t2)
  fakebin=$(make_fake_herdr t2)
  project=$(make_project "$home")

  # Simulate re-entry: the backlog already carries this id (e.g. a recovery
  # respawn), matching the exact line native fm tasks would itself write.
  mkdir -p "$home/data"
  printf '## In flight\n- [ ] backlog-demo-2 - ship task (repo: demo) (since 2020-01-01)\n\n## Queued\n\n## Done\n' \
    > "$home/data/backlog.md"

  run_spawn "$home" "$fakebin" backlog-demo-2 "$project" \
    || fail "spawn failed on re-entry"

  local count
  count=$(grep -cF -- '- [ ] backlog-demo-2 -' "$home/data/backlog.md")
  [ "$count" -eq 1 ] || fail "re-entry duplicated the backlog line (count=$count)"
  grep -qF 'since 2020-01-01' "$home/data/backlog.md" \
    || fail "re-entry overwrote the pre-existing recorded date"

  pass "fm spawn re-entry does not duplicate an already-recorded backlog line"
}

test_spawn_records_in_flight_via_native_fm_tasks
test_spawn_backlog_recording_is_idempotent_on_reentry

echo "all fm-spawn-backlog tests passed"
