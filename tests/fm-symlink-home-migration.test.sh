#!/usr/bin/env bash
# Behavior tests for symlink-backed secondmate homes and migration tooling.
# These tests use temp homes plus fake herdr only. They defend the contracts that
# matter during the worktree-to-symlink migration: operational state stays in the
# mate home, shared code resolves to the canonical code root, live panes are not
# migrated accidentally, and rollback restores the saved registry/meta snapshot.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

HOME_LINK="$ROOT/bin/fm-home-link.sh"
HOME_SEED="$ROOT/bin/fm-home-seed.sh"
SPAWN="$ROOT/bin/fm-spawn.sh"
UPDATE="$ROOT/bin/fm-update.sh"
MIGRATE="$ROOT/bin/fm-mate-home-migrate.sh"

fm_git_identity fmtest fmtest@example.com

abs_dir() {
  ( cd "$1" && pwd -P )
}

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-symlink-home-migration.XXXXXX") || exit 1
TMP_ROOT=$(abs_dir "$TMP_ROOT")
trap 'rm -rf "$TMP_ROOT"' EXIT

make_code_root() {
  local name=$1 code
  code="$TMP_ROOT/$name-code"
  mkdir -p "$code/.agents/skills/demo" "$code/.claude" "$code/.omp"
  printf '# Code root %s\n' "$name" > "$code/AGENTS.md"
  printf '# Claude root %s\n' "$name" > "$code/CLAUDE.md"
  printf 'backend = "markdown"\n' > "$code/.tasks.toml"
  printf 'skill\n' > "$code/.agents/skills/demo/SKILL.md"
  printf 'claude\n' > "$code/.claude/settings.json"
  printf 'omp\n' > "$code/.omp/supervisor-overlay.yml"
  ln -s "$ROOT/bin" "$code/bin"
  (
    cd "$code" || exit 1
    git init -q
    git config user.email t@t
    git config user.name t
    git add -A
    git commit -qm init
  )
  printf '%s\n' "$code"
}

make_plain_home() {
  local home=$1 id=$2
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects"
  printf '%s\n' "$id" > "$home/.fm-secondmate-home"
}

assert_symlink_to() {
  local path=$1 expected=$2 msg=$3 actual
  [ -L "$path" ] || fail "$msg: $path is not a symlink"
  actual=$(readlink "$path")
  [ "$actual" = "$expected" ] || fail "$msg: expected $expected, got $actual"
}

assert_no_git_repo() {
  local dir=$1 msg=$2
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "$msg"
  fi
}

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
      list)
        printf '{"result":{"workspaces":['
        first=1
        if [ -n "${FM_FAKE_WS:-}" ] && [ -f "$FM_FAKE_WS" ]; then
          while IFS=$'\t' read -r label wid cwd; do
            [ -n "$label" ] || continue
            [ "$first" -eq 1 ] || printf ','
            printf '{"label":"%s","workspace_id":"%s","cwd":"%s"}' "$label" "$wid" "$cwd"
            first=0
          done < "$FM_FAKE_WS"
        fi
        printf ']}}\n'
        exit 0 ;;
      create)
        label= cwd=; shift 2
        while [ $# -gt 0 ]; do
          case "$1" in
            --label) shift; label=${1:-} ;;
            --cwd) shift; cwd=${1:-} ;;
          esac
          shift || true
        done
        wid="${FM_FAKE_NEW_WSID:-wNEW}"
        if [ -n "${FM_FAKE_WS:-}" ]; then
          printf '%s\t%s\t%s\n' "$label" "$wid" "$cwd" >> "$FM_FAKE_WS"
        fi
        printf '{"result":{"workspace":{"workspace_id":"%s"},"root_pane":{"pane_id":"%s"}}}\n' \
          "$wid" "${FM_FAKE_ROOT_PANE:-wNEW:p0}"
        exit 0 ;;
      get)
        printf '{"result":{"workspace":{"workspace_id":"%s","label":"%s"}}}\n' "${3:-wNEW}" "${FM_FAKE_WORKSPACE_LABEL:-Mate}"
        exit 0 ;;
      rename)
        exit 0 ;;
    esac ;;
  tab)
    case "${2:-}" in
      create)
        printf '{"result":{"tab":{"tab_id":"%s"},"root_pane":{"pane_id":"%s"}}}\n' \
          "${FM_FAKE_TAB_ID:-wNEW:t1}" "${FM_FAKE_TAB_ROOT:-wNEW:p1}"
        exit 0 ;;
      close) exit 0 ;;
    esac ;;
  agent)
    case "${2:-}" in
      start)
        printf '{"result":{"agent":{"pane_id":"%s"}}}\n' "${FM_FAKE_AGENT_PANE:-wNEW:p2}"
        exit 0 ;;
      get)
        exit 1 ;;
    esac ;;
  pane)
    case "${2:-}" in
      close|rename|run|send-keys) exit 0 ;;
      current)
        printf '{"result":{"pane":{"pane_id":"wCUR:p1","workspace_id":"%s","tab_id":"wCUR:t1"}}}\n' "${FM_FAKE_CURRENT_WSID:-}"
        exit 0 ;;
      get)
        printf '{"result":{"pane":{"pane_id":"%s","agent_status":"idle"}}}\n' "${3:-wNEW:p2}"
        exit 0 ;;
      read) printf '%s\n' "${FM_FAKE_PANE_LINES:-}"; exit 0 ;;
      process-info)
        printf '{"result":{"process_info":{"foreground_processes":[]}}}\n'
        exit 0 ;;
    esac ;;
  worktree)
    case "${2:-}" in
      remove)
        [ -z "${FM_FAKE_REMOVE_HOME:-}" ] || rm -rf -- "$FM_FAKE_REMOVE_HOME"
        exit 0 ;;
    esac ;;
esac
exit 0
SH
  chmod +x "$fakebin/herdr"
  printf '%s\n' "$fakebin"
}

run_with_code_root() {
  local code=$1 active_home=$2 script=$3
  shift 3
  FM_ROOT_OVERRIDE="$code" FM_HOME="$active_home" "$script" "$@"
}

test_home_link_repairs_checks_and_refuses_conflicts() {
  local home out rc code_root
  code_root=$(abs_dir "$ROOT")
  home="$TMP_ROOT/link-home"
  make_plain_home "$home" linkmate

  rc=0
  out=$(FM_HOME="$home" "$HOME_LINK" "$home" --check 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || fail "check unexpectedly passed before shared-code links existed"
  assert_contains "$out" 'link.AGENTS.md=blocked:wrong-link' "check reports missing AGENTS.md link"
  assert_contains "$out" 'result=blocked' "check result blocks an unlinked home"

  out=$(FM_HOME="$home" "$HOME_LINK" "$home" --repair 2>&1) \
    || fail "repair failed: $out"
  assert_contains "$out" 'link.AGENTS.md=repaired' "repair creates AGENTS.md link"
  assert_contains "$out" 'link.bin=repaired' "repair creates bin link"
  assert_contains "$out" 'result=ok' "repair leaves the home valid"
  assert_symlink_to "$home/AGENTS.md" "$code_root/AGENTS.md" "AGENTS.md link target"
  assert_symlink_to "$home/bin" "$code_root/bin" "bin link target"
  assert_symlink_to "$home/CLAUDE.md" 'AGENTS.md' "CLAUDE.md relative link target"

  out=$(FM_HOME="$home" "$home/bin/fm-home-link.sh" "$home" --check 2>&1) \
    || fail "symlinked-bin check failed: $out"
  assert_contains "$out" "home=$(abs_dir "$home")" "script launched through home/bin still used the operational home"
  assert_contains "$out" 'result=ok' "script launched through home/bin still resolved the canonical code root"

  out=$(FM_HOME="$home" "$HOME_LINK" "$home" --repair 2>&1) \
    || fail "second repair was not idempotent: $out"
  assert_contains "$out" 'link.AGENTS.md=ok' "idempotent repair keeps existing AGENTS.md link"
  assert_contains "$out" 'link.bin=ok' "idempotent repair keeps existing bin link"

  rm -f "$home/AGENTS.md"
  printf 'local instructions must survive\n' > "$home/AGENTS.md"
  rc=0
  out=$(FM_HOME="$home" "$HOME_LINK" "$home" --repair 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || fail "repair overwrote a non-empty AGENTS.md conflict"
  assert_contains "$out" 'link.AGENTS.md=blocked:non-empty-file' "repair surfaces non-empty file conflicts"
  assert_contains "$out" 'result=blocked' "conflict makes repair fail closed"
  assert_grep 'local instructions must survive' "$home/AGENTS.md" "conflicting file was overwritten"

  pass "fm-home-link checks, repairs, stays idempotent, refuses conflicts, and works through symlinked bin"
}

test_seed_symlink_mode_creates_non_git_home_and_registry() {
  local active sm_base fakebin log ws out mate
  active="$TMP_ROOT/seed-active"
  sm_base="$TMP_ROOT/seed-mates"
  mkdir -p "$active/data" "$active/state" "$active/config" "$active/projects" "$sm_base"
  fakebin=$(make_fake_herdr "$TMP_ROOT/seed-fake")
  log="$TMP_ROOT/seed-herdr.log"; : > "$log"
  ws="$TMP_ROOT/seed-ws.tsv"; : > "$ws"

  out=$(PATH="$fakebin:$PATH" FM_HOME="$active" FM_HERDR_SM_BASE="$sm_base" \
    FM_FAKE_HERDR_LOG="$log" FM_FAKE_WS="$ws" FM_FAKE_NEW_WSID=wSEED \
    FM_SECONDMATE_HOME_MODE=symlink FM_SECONDMATE_CHARTER='Own deterministic migration tests.' \
    FM_SECONDMATE_SCOPE='migration quality' FM_SECONDMATE_NAME='Migrator' \
    "$HOME_SEED" seedmate - 2>&1) || fail "symlink seed failed: $out"

  mate="$sm_base/seedmate"
  assert_contains "$out" "home=$mate" "seed reports the created mate home"
  assert_no_git_repo "$mate" "symlink seed created a git worktree instead of a plain home"
  assert_present "$mate/.fm-secondmate-home" "seed did not write the mate marker"
  assert_symlink_to "$mate/AGENTS.md" "$(abs_dir "$ROOT")/AGENTS.md" "seed AGENTS.md link"
  assert_symlink_to "$mate/bin" "$(abs_dir "$ROOT")/bin" "seed bin link"
  assert_symlink_to "$mate/CLAUDE.md" 'AGENTS.md' "seed CLAUDE.md link"
  assert_present "$mate/data/charter.md" "seed did not copy charter into the mate home"
  assert_grep 'workspace: wSEED' "$active/data/secondmates.md" "registry did not store fake herdr workspace id"
  assert_grep 'name: Migrator' "$active/data/secondmates.md" "registry did not store secondmate display name"
  assert_grep 'projects: (none)' "$active/data/secondmates.md" "registry did not record an empty project set"
  assert_grep "herdr workspace create --label Migrator --cwd $mate --no-focus" "$log" "seed did not create the home workspace through fake herdr"

  pass "symlink seed creates a non-git linked mate home and registry entry through fake herdr"
}

test_spawn_secondmate_repairs_links_and_starts_in_home_with_root_env() {
  local code active mate fakebin log ws out start_line
  code=$(make_code_root spawn)
  active="$TMP_ROOT/spawn-active"
  mate="$TMP_ROOT/spawn-mate"
  mkdir -p "$active/data" "$active/state" "$active/config" "$active/projects"
  make_plain_home "$mate" spawnmate
  printf 'name=SpawnMate\n' > "$mate/config/identity"
  printf 'Spawn charter\n' > "$mate/data/charter.md"
  printf -- '- spawnmate - spawn domain (home: %s; workspace: wOLD; name: SpawnMate; scope: spawn; projects: (none); added 2026-07-08)\n' "$mate" \
    > "$active/data/secondmates.md"
  rm -f "$mate/AGENTS.md" "$mate/CLAUDE.md" "$mate/bin"
  fakebin=$(make_fake_herdr "$TMP_ROOT/spawn-fake")
  log="$TMP_ROOT/spawn-herdr.log"; : > "$log"
  ws="$TMP_ROOT/spawn-ws.tsv"; : > "$ws"

  out=$(PATH="$fakebin:$PATH" FM_ROOT_OVERRIDE="$code" FM_HOME="$active" \
    FM_FAKE_HERDR_LOG="$log" FM_FAKE_WS="$ws" FM_FAKE_NEW_WSID=wSPAWN \
    FM_FAKE_TAB_ID=wSPAWN:t1 FM_FAKE_TAB_ROOT=wSPAWN:p1 FM_FAKE_AGENT_PANE=wSPAWN:p2 \
    FM_HUSK_REAP_SETTLE=0 FM_SPAWN_NO_GUARD=1 \
    "$SPAWN" spawnmate omp --secondmate 2>&1) || fail "secondmate spawn failed: $out"

  assert_contains "$out" "spawned spawnmate harness=omp kind=secondmate" "spawn did not report a secondmate launch"
  assert_symlink_to "$mate/AGENTS.md" "$code/AGENTS.md" "spawn repaired AGENTS.md link"
  assert_symlink_to "$mate/bin" "$code/bin" "spawn repaired bin link"
  assert_symlink_to "$mate/CLAUDE.md" 'AGENTS.md' "spawn repaired CLAUDE.md link"
  start_line=$(grep -F 'herdr agent start spawnmate ' "$log" | tail -1)
  assert_contains "$start_line" "--cwd $mate" "spawn did not set herdr cwd to the mate home"
  assert_contains "$start_line" "--env FM_HOME=$mate" "spawn did not pass FM_HOME to the started agent"
  assert_contains "$start_line" "--env FM_CODE_ROOT_OVERRIDE=$code" "spawn did not pass FM_CODE_ROOT_OVERRIDE to the started agent"
  assert_contains "$start_line" "--env FM_ROOT_OVERRIDE=$code" "spawn did not pass FM_ROOT_OVERRIDE to the started agent"
  assert_grep "worktree=$mate" "$active/state/spawnmate.meta" "spawn meta did not record the mate home as worktree"
  assert_grep "home=$mate" "$active/state/spawnmate.meta" "spawn meta did not record the mate home"

  pass "fm-spawn --secondmate repairs links and starts fake herdr in the mate home with home/root env"
}

test_update_repair_links_verifies_symlink_home_without_git() {
  local code active mate out
  code=$(make_code_root update)
  active="$TMP_ROOT/update-active"
  mate="$TMP_ROOT/update-mate"
  mkdir -p "$active/data" "$active/state" "$active/config" "$active/projects"
  make_plain_home "$mate" updatemate
  printf -- '- updatemate - update domain (home: %s; workspace: wUP; name: UpdateMate; scope: update; projects: (none); added 2026-07-08)\n' "$mate" \
    > "$active/data/secondmates.md"
  {
    printf 'pane=wUP:p1\n'
    printf 'kind=secondmate\n'
    printf 'home=%s\n' "$mate"
  } > "$active/state/updatemate.meta"
  ln -s /definitely/missing "$mate/AGENTS.md"
  rm -f "$mate/CLAUDE.md" "$mate/bin"

  out=$(run_with_code_root "$code" "$active" "$UPDATE" --repair-links 2>&1) \
    || fail "update --repair-links failed: $out"

  assert_contains "$out" 'secondmate updatemate: symlink home verified' "update did not verify the symlink home"
  assert_no_git_repo "$mate" "update tried to treat the symlink home as a git checkout"
  assert_symlink_to "$mate/AGENTS.md" "$code/AGENTS.md" "update repaired AGENTS.md link"
  assert_symlink_to "$mate/bin" "$code/bin" "update repaired bin link"
  assert_symlink_to "$mate/CLAUDE.md" 'AGENTS.md' "update repaired CLAUDE.md link"

  pass "fm-update --repair-links repairs and verifies non-git symlink homes without git-updating them"
}

make_migration_world() {
  local name=$1 code active sm_base target
  code=$(make_code_root "$name")
  active="$TMP_ROOT/$name-active"
  sm_base="$TMP_ROOT/$name-mates"
  target="$sm_base/migmate"
  mkdir -p "$active/data" "$active/state" "$active/config" "$active/projects" "$sm_base"
  git -C "$code" worktree add -q --detach "$target" HEAD
  mkdir -p "$target/data" "$target/state" "$target/config" "$target/projects/alpha" "$target/web"
  printf 'migmate\n' > "$target/.fm-secondmate-home"
  printf 'charter before\n' > "$target/data/charter.md"
  printf 'state before\n' > "$target/state/status.txt"
  printf 'identity before\n' > "$target/config/identity"
  printf 'project before\n' > "$target/projects/alpha/file.txt"
  printf 'local message\n' > "$target/msg.md"
  printf 'web artifact\n' > "$target/web/index.html"
  printf 'png artifact\n' > "$target/snap.png"
  printf -- '- migmate - migration domain (home: %s; workspace: wOLD; name: Migrator; scope: migration; projects: alpha; added 2026-07-08)\n' "$target" \
    > "$active/data/secondmates.md"
  {
    printf 'pane=wOLD:p1\n'
    printf 'tab=wOLD:t1\n'
    printf 'kind=secondmate\n'
    printf 'home=%s\n' "$target"
    printf 'workspace=OldMigrator\n'
  } > "$active/state/migmate.meta"
  printf '%s\n%s\n%s\n%s\n' "$code" "$active" "$sm_base" "$target"
}

test_migration_dry_run_execute_and_rollback() {
  local code active sm_base target fakebin log ws out rc ts backup failed_home before_reg before_meta
  ts=20260708T010203Z
  {
    read -r code
    read -r active
    read -r sm_base
    read -r target
  } <<EOF
$(make_migration_world migrate)
EOF
  fakebin=$(make_fake_herdr "$TMP_ROOT/migrate-fake")
  log="$TMP_ROOT/migrate-herdr.log"; : > "$log"
  ws="$TMP_ROOT/migrate-ws.tsv"; : > "$ws"
  before_reg=$(cat "$active/data/secondmates.md")
  before_meta=$(cat "$active/state/migmate.meta")

  rc=0
  out=$(PATH="$fakebin:$PATH" FM_ROOT_OVERRIDE="$code" FM_HOME="$active" FM_HERDR_SM_BASE="$sm_base" \
    FM_FAKE_HERDR_LOG="$log" FM_FAKE_WS="$ws" FM_MIGRATION_TIMESTAMP="$ts" \
    "$MIGRATE" migmate --dry-run 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || fail "dry-run unexpectedly allowed migration with a live pane: $out"
  assert_contains "$out" 'result=blocked:live-pane' "dry-run does not block a live pane without --stop-live"
  assert_present "$target/.git" "dry-run mutated the worktree home"

  out=$(PATH="$fakebin:$PATH" FM_ROOT_OVERRIDE="$code" FM_HOME="$active" FM_HERDR_SM_BASE="$sm_base" \
    FM_FAKE_HERDR_LOG="$log" FM_FAKE_WS="$ws" FM_FAKE_NEW_WSID=wMIGRATED \
    FM_FAKE_REMOVE_HOME="$target" FM_MIGRATION_TIMESTAMP="$ts" \
    "$MIGRATE" migmate --execute --stop-live 2>&1) || fail "execute migration failed: $out"
  assert_contains "$out" 'backup=written' "execute did not write a backup"
  assert_contains "$out" 'workspace=wMIGRATED' "execute did not create or report the new workspace"
  assert_contains "$out" 'execute=ok' "execute did not finish cleanly"
  assert_no_git_repo "$target" "execute left the migrated mate home as a git worktree"
  assert_grep 'charter before' "$target/data/charter.md" "execute did not preserve data dir"
  assert_grep 'state before' "$target/state/status.txt" "execute did not preserve state dir"
  assert_grep 'identity before' "$target/config/identity" "execute did not preserve config dir"
  assert_grep 'project before' "$target/projects/alpha/file.txt" "execute did not preserve projects dir"
  assert_symlink_to "$target/AGENTS.md" "$code/AGENTS.md" "execute linked AGENTS.md to code root"
  assert_symlink_to "$target/bin" "$code/bin" "execute linked bin to code root"
  assert_grep 'workspace: wMIGRATED' "$active/data/secondmates.md" "execute did not update registry workspace"
  assert_grep "home=$target" "$active/state/migmate.meta" "execute did not update meta home"
  assert_grep 'workspace=Migrator' "$active/state/migmate.meta" "execute did not update meta workspace label"
  backup="$active/data/migration-local-files/$ts/migmate"
  assert_present "$backup/msg.md" "execute did not archive msg.md"
  assert_present "$backup/web/index.html" "execute did not archive web artifacts"
  assert_present "$backup/screenshots/snap.png" "execute did not archive screenshots"
  assert_grep "herdr pane close wOLD:p1" "$log" "execute did not stop the live pane through fake herdr"
  assert_grep "herdr worktree remove --workspace wOLD --force" "$log" "execute did not release the old worktree through fake herdr"

  printf 'post-migration only\n' > "$target/data/post-migration.txt"
  out=$(PATH="$fakebin:$PATH" FM_ROOT_OVERRIDE="$code" FM_HOME="$active" FM_HERDR_SM_BASE="$sm_base" \
    FM_FAKE_HERDR_LOG="$log" FM_FAKE_WS="$ws" FM_MIGRATION_TIMESTAMP="$ts" \
    "$MIGRATE" rollback migmate "$ts" 2>&1) || fail "rollback failed: $out"
  assert_contains "$out" 'result=rolled-back' "rollback did not report success"
  failed_home=$(printf '%s\n' "$out" | sed -n 's/^failed_home=//p' | tail -1)
  [ -n "$failed_home" ] || fail "rollback did not report failed_home"
  assert_present "$failed_home/data/post-migration.txt" "rollback did not quarantine the replaced symlink home"
  [ "$(cat "$active/data/secondmates.md")" = "$before_reg" ] || fail "rollback did not restore the registry snapshot"
  [ "$(cat "$active/state/migmate.meta")" = "$before_meta" ] || fail "rollback did not restore the meta snapshot"
  assert_grep 'local message' "$target/msg.md" "rollback did not restore the old home artifact snapshot"
  assert_grep 'charter before' "$target/data/charter.md" "rollback did not restore the old home data snapshot"

  pass "fm-mate-home-migrate blocks live dry-runs, executes to a non-git symlink home, archives artifacts, and rolls back snapshots"
}

omp_session_bucket_for_home() {
  local home=$1 fake_home=$2 rel
  rel=$home
  case "$rel" in
    "$fake_home"/*) rel=${rel#"$fake_home"} ;;
    "$fake_home") rel=/ ;;
  esac
  rel=${rel//\//-}
  printf '%s\n' "$rel"
}

write_omp_session_for_home() {
  local store=$1 home=$2 fake_home=$3 session_id=$4 bucket
  bucket=$(omp_session_bucket_for_home "$home" "$fake_home")
  mkdir -p "$store/$bucket"
  printf '{"session":"%s"}\n' "$session_id" > "$store/$bucket/000_${session_id}.jsonl"
}

last_agent_start_line() {
  local log=$1
  grep -F 'herdr agent start migmate ' "$log" | tail -1
}

test_migration_respawn_resumes_existing_omp_session_by_default() {
  local code active sm_base target fakebin log ws out ts fake_home session_store start_line
  ts=20260708T020304Z
  {
    read -r code
    read -r active
    read -r sm_base
    read -r target
  } <<EOF
$(make_migration_world migrate-resume)
EOF
  fakebin=$(make_fake_herdr "$TMP_ROOT/migrate-resume-fake")
  log="$TMP_ROOT/migrate-resume-herdr.log"; : > "$log"
  ws="$TMP_ROOT/migrate-resume-ws.tsv"; : > "$ws"
  fake_home="$TMP_ROOT/migrate-resume-user"
  session_store="$TMP_ROOT/migrate-resume-sessions"
  mkdir -p "$fake_home" "$session_store"
  write_omp_session_for_home "$session_store" "$target" "$fake_home" "session-default-123"

  out=$(PATH="$fakebin:$PATH" HOME="$fake_home" FM_OMP_SESSION_STORE="$session_store" \
    FM_ROOT_OVERRIDE="$code" FM_HOME="$active" FM_HERDR_SM_BASE="$sm_base" \
    FM_FAKE_HERDR_LOG="$log" FM_FAKE_WS="$ws" FM_FAKE_NEW_WSID=wRESUME \
    FM_FAKE_REMOVE_HOME="$target" FM_MIGRATION_TIMESTAMP="$ts" \
    FM_HUSK_REAP_SETTLE=0 FM_SPAWN_NO_GUARD=1 \
    "$MIGRATE" migmate --execute --stop-live --respawn 2>&1) \
    || fail "execute migration with default resume respawn failed: $out"

  assert_contains "$out" 'respawn=ok' "default resume respawn did not report success"
  start_line=$(last_agent_start_line "$log")
  assert_contains "$start_line" 'omp --auto-approve --approval-mode=write --resume session-default-123' "default respawn did not resume the pre-migration omp session with secondmate omp flags"
  assert_contains "$start_line" "--cwd $target" "default respawn did not launch in the migrated mate home"

  pass "fm-mate-home-migrate --respawn resumes the existing omp session by default"
}

test_migration_respawn_fresh_session_opt_in_starts_from_charter() {
  local code active sm_base target fakebin log ws out ts fake_home session_store start_line
  ts=20260708T030405Z
  {
    read -r code
    read -r active
    read -r sm_base
    read -r target
  } <<EOF
$(make_migration_world migrate-fresh)
EOF
  fakebin=$(make_fake_herdr "$TMP_ROOT/migrate-fresh-fake")
  log="$TMP_ROOT/migrate-fresh-herdr.log"; : > "$log"
  ws="$TMP_ROOT/migrate-fresh-ws.tsv"; : > "$ws"
  fake_home="$TMP_ROOT/migrate-fresh-user"
  session_store="$TMP_ROOT/migrate-fresh-sessions"
  mkdir -p "$fake_home" "$session_store"
  write_omp_session_for_home "$session_store" "$target" "$fake_home" "session-ignored-456"

  out=$(PATH="$fakebin:$PATH" HOME="$fake_home" FM_OMP_SESSION_STORE="$session_store" \
    FM_ROOT_OVERRIDE="$code" FM_HOME="$active" FM_HERDR_SM_BASE="$sm_base" \
    FM_FAKE_HERDR_LOG="$log" FM_FAKE_WS="$ws" FM_FAKE_NEW_WSID=wFRESH \
    FM_FAKE_REMOVE_HOME="$target" FM_MIGRATION_TIMESTAMP="$ts" \
    FM_HUSK_REAP_SETTLE=0 FM_SPAWN_NO_GUARD=1 \
    "$MIGRATE" migmate --execute --stop-live --respawn --fresh-session 2>&1) \
    || fail "execute migration with forced fresh respawn failed: $out"

  assert_contains "$out" 'respawn=ok' "fresh-session respawn did not report success"
  start_line=$(last_agent_start_line "$log")
  assert_not_contains "$start_line" '--resume' "fresh-session respawn unexpectedly resumed an omp session"
  assert_contains "$start_line" "\$(cat '$target/data/charter.md')" "fresh-session respawn did not launch from the migrated charter"

  pass "fm-mate-home-migrate --respawn --fresh-session starts from the charter instead of resuming"
}

test_migration_respawn_blocks_when_default_resume_session_is_missing() {
  local code active sm_base target fakebin log ws out rc ts fake_home session_store
  ts=20260708T040506Z
  {
    read -r code
    read -r active
    read -r sm_base
    read -r target
  } <<EOF
$(make_migration_world migrate-missing-session)
EOF
  fakebin=$(make_fake_herdr "$TMP_ROOT/migrate-missing-session-fake")
  log="$TMP_ROOT/migrate-missing-session-herdr.log"; : > "$log"
  ws="$TMP_ROOT/migrate-missing-session-ws.tsv"; : > "$ws"
  fake_home="$TMP_ROOT/migrate-missing-session-user"
  session_store="$TMP_ROOT/migrate-missing-session-sessions"
  mkdir -p "$fake_home" "$session_store"

  rc=0
  out=$(PATH="$fakebin:$PATH" HOME="$fake_home" FM_OMP_SESSION_STORE="$session_store" \
    FM_ROOT_OVERRIDE="$code" FM_HOME="$active" FM_HERDR_SM_BASE="$sm_base" \
    FM_FAKE_HERDR_LOG="$log" FM_FAKE_WS="$ws" FM_FAKE_NEW_WSID=wMISSING \
    FM_FAKE_REMOVE_HOME="$target" FM_MIGRATION_TIMESTAMP="$ts" \
    FM_HUSK_REAP_SETTLE=0 FM_SPAWN_NO_GUARD=1 \
    "$MIGRATE" migmate --execute --stop-live --respawn 2>&1) || rc=$?

  [ "$rc" -ne 0 ] || fail "default respawn silently started fresh with no resumable session: $out"
  assert_contains "$out" 'execute=blocked:omp-session-missing' "missing default resume session did not produce a clear blocker"
  assert_no_grep 'herdr pane close wOLD:p1' "$log" "missing session blocker stopped the old live pane"
  assert_no_grep 'herdr agent start migmate ' "$log" "missing session blocker started a fresh agent"
  assert_present "$target/.git" "missing session blocker mutated the old worktree home"

  pass "fm-mate-home-migrate --respawn blocks before stopping live work when no omp session can be resumed"
}


test_home_link_repairs_checks_and_refuses_conflicts
test_seed_symlink_mode_creates_non_git_home_and_registry
test_spawn_secondmate_repairs_links_and_starts_in_home_with_root_env
test_update_repair_links_verifies_symlink_home_without_git
test_migration_dry_run_execute_and_rollback
test_migration_respawn_resumes_existing_omp_session_by_default
test_migration_respawn_fresh_session_opt_in_starts_from_charter
test_migration_respawn_blocks_when_default_resume_session_is_missing

printf '# all symlink home migration tests passed\n'
