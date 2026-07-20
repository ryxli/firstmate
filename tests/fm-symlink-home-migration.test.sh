#!/usr/bin/env bash
# Tests for symlink-backed secondmate homes, link repair, non-git update repair,
# and migration respawn continuity. All fixtures are temp-local and use fake herdr.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_LINK="$ROOT/sbin/fm"
UPDATE="$ROOT/sbin/fm"
TMP_ROOT=
# fm spawn's link-repair path now shells out to the bun-based `fm` CLI, so the
# sanitized spawn-lifecycle PATH below must still resolve bun even though it
# otherwise excludes the host PATH.
BUN_DIR=""
command -v bun >/dev/null 2>&1 && BUN_DIR=$(dirname "$(command -v bun)")
BASE_PATH=${FM_TEST_BASE_PATH:-${BUN_DIR:+$BUN_DIR:}/usr/bin:/bin:/usr/sbin:/sbin}

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
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-symlink-home-migration.XXXXXX")

assert_contains() {
  case "$1" in
    *"$2"*) : ;;
    *) fail "$3 (missing: $2)"$'\n'"--- text ---"$'\n'"$1" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "$3 (unexpected: $2)"$'\n'"--- text ---"$'\n'"$1" ;;
    *) : ;;
  esac
}

canonical() {
  cd "$1" && pwd -P
}

require_slice_scripts() {
  [ -x "$HOME_LINK" ] || fail "missing executable $HOME_LINK"
}

spawn() {
  "$ROOT/sbin/fm" spawn "$@"
}

make_code_root() {
  local dir=$1
  mkdir -p "$dir/.agents/skills" "$dir/.claude" "$dir/.omp/extensions"
  printf '# Test code root\n' > "$dir/AGENTS.md"
  printf 'Compatibility link target\n' > "$dir/CLAUDE.md"
  ln -s "$ROOT/sbin" "$dir/sbin"
  printf 'skill\n' > "$dir/.agents/skills/test.md"
  printf 'ext\n' > "$dir/.omp/extensions/test-ext.ts"
}

make_main_home() {
  local home=$1
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects"
  printf 'omp\n' > "$home/config/crew-harness"
  printf '%s\n' '- alpha [pr] - alpha project (added 2026-07-08)' > "$home/data/projects.md"
}

make_git_project_with_origin() {
  local dir=$1 remote=$2 remote_abs
  mkdir -p "$dir"
  git -C "$dir" init -q
  printf '# %s\n' "$(basename "$dir")" > "$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" -c user.name='Firstmate Tests' -c user.email='tests@example.invalid' commit -qm initial
  mkdir -p "$(dirname "$remote")"
  git clone --quiet --bare "$dir" "$remote"
  remote_abs=$(canonical "$remote")
  git -C "$dir" remote add origin "file://$remote_abs"
}

make_fake_toolchain() {
  local dir=$1 fakebin log
  fakebin="$dir/fakebin"
  log="$dir/herdr.log"
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -u
LOG=${FM_FAKE_HERDR_LOG:-/dev/null}
printf 'herdr' >> "$LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$LOG"; done
printf '\n' >> "$LOG"
case "${1:-}" in
  pane)
    case "${2:-}" in
      list)
        if [ -n "${FM_FAKE_HERDR_PANE_LIST:-}" ]; then
          printf '%s\n' "$FM_FAKE_HERDR_PANE_LIST"
        else
          printf '{"id":"cli:pane:list","result":{"panes":[]}}\n'
        fi
        exit 0 ;;
      get)
        printf '{"id":"cli:pane:get","result":{"pane":{"pane_id":"%s","agent":"%s","cwd":"%s"}}}\n' \
          "${3:-w1:p1}" "${FM_FAKE_HERDR_AGENT:-omp}" "${FM_FAKE_HERDR_CWD:-}"
        exit 0 ;;
      read)
        if [ -n "${FM_FAKE_HERDR_SESSION:-}" ]; then
          printf 'session ready\nomp --resume %s\n' "$FM_FAKE_HERDR_SESSION"
        else
          printf 'session ready\n'
        fi
        exit 0 ;;
      close|run)
        exit 0 ;;
    esac ;;
  agent)
    case "${2:-}" in
      start)
        printf '{"id":"cli:agent:start","result":{"agent":{"pane_id":"%s"},"pane":{"pane_id":"%s"}}}\n' \
          "${FM_FAKE_HERDR_PANE:-wT:p1}" "${FM_FAKE_HERDR_PANE:-wT:p1}"
        exit 0 ;;
      get)
        printf '{"error":{"code":"agent_not_found"}}\n'
        exit 0 ;;
    esac ;;
  tab)
    case "${2:-}" in
      create)
        printf '{"id":"cli:tab:create","result":{"tab":{"tab_id":"%s"},"root_pane":{"pane_id":"%s"}}}\n' \
          "${FM_FAKE_HERDR_TAB:-tT}" "${FM_FAKE_HERDR_ROOT_PANE:-wT:root}"
        exit 0 ;;
      close)
        exit 0 ;;
    esac ;;
  workspace)
    case "${2:-}" in
      list)
        printf '{"id":"cli:workspace:list","result":{"workspaces":[]}}\n'
        exit 0 ;;
      create)
        cwd=
        label="${FM_FAKE_HERDR_WORKSPACE_LABEL:-test-sm}"
        shift 2
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --cwd) shift; cwd=${1:-} ;;
            --label) shift; label=${1:-} ;;
          esac
          shift || break
        done
        printf '{"id":"cli:workspace:create","result":{"workspace":{"workspace_id":"%s","label":"%s","cwd":"%s"}}}\n' \
          "${FM_FAKE_HERDR_WORKSPACE_ID:-wT}" "$label" "$cwd"
        exit 0 ;;
    esac ;;
  worktree)
    case "${2:-}" in
      create)
        path=
        shift 2
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --path) shift; path=${1:-} ;;
          esac
          shift || break
        done
        [ -n "$path" ] && mkdir -p "$path"
        printf '{"id":"cli:worktree:create","result":{"workspace":{"workspace_id":"%s","name":"%s","worktree":{"checkout_path":"%s"}}}}\n' \
          "${FM_FAKE_HERDR_WORKSPACE_ID:-wT}" "${FM_FAKE_HERDR_WORKSPACE_NAME:-test-sm}" "${path:-/tmp/fake-sm}"
        exit 0 ;;
      remove)
        [ -n "${FM_FAKE_HERDR_REMOVE_PATH:-}" ] && rm -rf -- "$FM_FAKE_HERDR_REMOVE_PATH"
        exit 0 ;;
    esac ;;
esac
exit 0
SH
  chmod +x "$fakebin/herdr"

  cat > "$fakebin/no-mistakes" <<'SH'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  init) touch .no-mistakes-init; exit 0 ;;
  *) exit 0 ;;
esac
SH
  chmod +x "$fakebin/no-mistakes"
  : > "$log"
  printf '%s\n' "$fakebin"
}

make_link_home() {
  local code=$1 home=$2 id=$3
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects" "$home/.omp"
  printf '%s\n' "$id" > "$home/.fm-secondmate-home"
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --repair >/dev/null
  # Isolated skill exposure: empty manifests until a caller selects shared skills.
  : > "$home/config/shared-skills"
  : > "$home/config/local-skills"
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home skills sync "$home" >/dev/null \
    || fail "home skills sync failed while preparing link home $home"
}

make_current_home() {
  local code=$1 home=$2 id=$3 entry name
  code=$(canonical "$code")
  make_link_home "$code" "$home" "$id"
  # Real local .omp is the current layout; never replace it with a whole-tree link.
  rm -f "$home/.agents" "$home/.claude"
  mkdir -p "$home/.omp/extensions"
  for entry in "$code/.omp/extensions"/*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    [ -e "$home/.omp/extensions/$name" ] || ln -s "$entry" "$home/.omp/extensions/$name"
  done
}

assert_link_points() {
  local link=$1 target=$2 label=$3 actual
  [ -L "$link" ] || fail "$label is not a symlink: $link"
  actual=$(readlink "$link")
  [ "$actual" = "$target" ] || fail "$label points to $actual, expected $target"
}

test_current_layout_home_link_check_passes() {
  require_slice_scripts
  local code="$TMP_ROOT/current-pass-code" home="$TMP_ROOT/current-pass-home" out
  make_code_root "$code"
  make_current_home "$code" "$home" currentpass
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --repair >/dev/null \
    || fail "current-layout repair failed before check"
  out=$(FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --check 2>&1) \
    || fail "current-layout check failed: $out"
  assert_contains "$out" "result=ok" "current-layout check did not report result=ok"
  pass "current per-extension .omp layout passes home-link check"
}

# Contract: persistent homes no longer require a CLAUDE.md compatibility link.
test_home_link_allows_missing_claude_link() {
  require_slice_scripts
  local code="$TMP_ROOT/missing-claude-code" home="$TMP_ROOT/missing-claude-home" out
  make_code_root "$code"
  make_link_home "$code" "$home" missingclaude
  [ ! -e "$home/CLAUDE.md" ] && [ ! -L "$home/CLAUDE.md" ] \
    || fail "home-link repair created CLAUDE.md"
  out=$(FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --check 2>&1) \
    || fail "home-link check rejected a missing CLAUDE.md: $out"
  assert_contains "$out" "link.CLAUDE.md=ok" "missing CLAUDE.md was not healthy"
  pass "home-link check accepts a missing CLAUDE.md"
}

# Contract: repair removes a legacy CLAUDE.md symlink but never recreates it.
test_home_link_removes_legacy_claude_symlink() {
  require_slice_scripts
  local code="$TMP_ROOT/legacy-claude-code" home="$TMP_ROOT/legacy-claude-home" out
  make_code_root "$code"
  make_link_home "$code" "$home" legacyclaude
  ln -s "$code/CLAUDE.md" "$home/CLAUDE.md"
  if FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --check >/dev/null 2>&1; then
    fail "home-link check accepted a legacy CLAUDE.md symlink"
  fi
  out=$(FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --repair 2>&1) \
    || fail "home-link repair failed to remove legacy CLAUDE.md symlink: $out"
  [ ! -e "$home/CLAUDE.md" ] && [ ! -L "$home/CLAUDE.md" ] \
    || fail "home-link repair left or recreated CLAUDE.md symlink"
  pass "home-link repair removes a legacy CLAUDE.md symlink"
}

# Contract: non-symlink CLAUDE.md objects are user-owned and survive repair.
test_home_link_preserves_non_symlink_claude_objects() {
  require_slice_scripts
  local code="$TMP_ROOT/object-claude-code" file_home="$TMP_ROOT/object-claude-file-home"
  local dir_home="$TMP_ROOT/object-claude-dir-home"
  make_code_root "$code"

  make_link_home "$code" "$file_home" claudeFile
  printf 'user-owned instructions\n' > "$file_home/CLAUDE.md"
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$file_home" --repair >/dev/null \
    || fail "home-link repair rejected a user-owned CLAUDE.md file"
  [ -f "$file_home/CLAUDE.md" ] || fail "home-link repair removed a user-owned CLAUDE.md file"
  [ "$(cat "$file_home/CLAUDE.md")" = 'user-owned instructions' ] \
    || fail "home-link repair changed a user-owned CLAUDE.md file"

  make_link_home "$code" "$dir_home" claudeDir
  mkdir "$dir_home/CLAUDE.md"
  printf 'keep\n' > "$dir_home/CLAUDE.md/owned"
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$dir_home" --repair >/dev/null \
    || fail "home-link repair rejected a user-owned CLAUDE.md directory"
  [ -d "$dir_home/CLAUDE.md" ] || fail "home-link repair removed a user-owned CLAUDE.md directory"
  [ "$(cat "$dir_home/CLAUDE.md/owned")" = keep ] \
    || fail "home-link repair changed a user-owned CLAUDE.md directory"
  pass "home-link repair preserves non-symlink CLAUDE.md objects"
}

test_current_layout_broken_extension_link_fails() {
  require_slice_scripts
  local code="$TMP_ROOT/current-broken-code" home="$TMP_ROOT/current-broken-home"
  make_code_root "$code"
  make_current_home "$code" "$home" currentbroken
  rm -f "$home/.omp/extensions/test-ext.ts"
  ln -s "$TMP_ROOT/missing-extension" "$home/.omp/extensions/test-ext.ts"
  if FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --check >/dev/null 2>&1; then
    fail "current-layout check accepted a broken extension link"
  fi
  pass "current per-extension broken link fails home-link check"
}

test_current_layout_repairs_extension_link() {
  require_slice_scripts
  local code="$TMP_ROOT/current-repair-code" home="$TMP_ROOT/current-repair-home"
  make_code_root "$code"
  code=$(canonical "$code")
  make_current_home "$code" "$home" currentrepair
  rm -f "$home/.omp/extensions/test-ext.ts"
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --repair >/dev/null \
    || fail "current-layout repair failed"
  assert_link_points "$home/.omp/extensions/test-ext.ts" "$code/.omp/extensions/test-ext.ts" \
    "repaired extension link"
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --check >/dev/null \
    || fail "current-layout check failed after repair"
  pass "current per-extension broken link is repaired"
}
# Contract: home-link never recreates a whole-catalog .agents link; selected
# shared skills are exposed only through `fm home skills` into .omp/skills.
test_current_layout_repair_discovers_shared_skills() {
  require_slice_scripts
  local code="$TMP_ROOT/current-skills-code" home="$TMP_ROOT/current-skills-home" out
  local skill skill_file
  make_code_root "$code"
  code=$(canonical "$code")
  for skill in fm-operate-crew-harness fm-manage-project-work; do
    mkdir -p "$code/.agents/skills/$skill"
    printf -- '---\nname: %s\ndescription: test\n---\n' "$skill" > "$code/.agents/skills/$skill/SKILL.md"
  done
  make_current_home "$code" "$home" currentskills

  out=$(FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --check 2>&1) \
    || fail "current-layout check failed without .agents: $out"
  assert_contains "$out" "link..agents=skipped" "home-link still treats .agents as required"
  assert_contains "$out" "result=ok" "current-layout check did not report result=ok"
  [ ! -e "$home/.agents" ] && [ ! -L "$home/.agents" ] \
    || fail "home-link created a whole-catalog .agents link"

  printf '%s\n' fm-operate-crew-harness > "$home/config/shared-skills"
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home skills sync "$home" >/dev/null \
    || fail "home skills sync failed to expose selected shared skill"
  [ -d "$home/.omp" ] && [ ! -L "$home/.omp" ] \
    || fail "home skills replaced the home-owned .omp directory"
  assert_link_points "$home/.omp/extensions/test-ext.ts" "$code/.omp/extensions/test-ext.ts" \
    "current-layout extension link after skill sync"
  assert_link_points "$home/.omp/skills/fm-operate-crew-harness" "$code/.agents/skills/fm-operate-crew-harness" \
    "managed shared skill link"
  [ ! -e "$home/.omp/skills/fm-manage-project-work" ] \
    || fail "unselected shared skill was exposed"
  skill_file="$home/.omp/skills/fm-operate-crew-harness/SKILL.md"
  [ -f "$skill_file" ] || fail "selected shared skill is not discoverable via .omp/skills"
  assert_contains "$(cat "$skill_file")" "name: fm-operate-crew-harness" \
    "synced home discovered the wrong content for selected skill"
  pass "home-link skips .agents; home skills exposes only selected shared skills"
}




test_legacy_whole_omp_link_still_passes() {
  require_slice_scripts
  local code="$TMP_ROOT/legacy-pass-code" home="$TMP_ROOT/legacy-pass-home"
  make_code_root "$code"
  make_link_home "$code" "$home" legacypass
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --check >/dev/null \
    || fail "legacy whole-directory .omp link no longer passes"
  pass "legacy whole-directory .omp symlink still passes home-link check"
}

# Contract: a non-git mate home can be repaired into a shared-code home while
# data, state, config, and projects remain local directories, and a script run
# through the linked sbin reads operational data from FM_HOME rather than code root.
test_home_link_repairs_shared_code_without_moving_operational_dirs() {
  require_slice_scripts
  local code home conflict out before
  code="$TMP_ROOT/link-code"
  home="$TMP_ROOT/link-home"
  conflict="$TMP_ROOT/link-conflict-home"
  make_code_root "$code"
  code=$(canonical "$code")
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects"
  printf '%s\n' linksm > "$home/.fm-secondmate-home"
  mkdir -p "$TMP_ROOT/stale-sbin"
  ln -s "$TMP_ROOT/stale-sbin" "$home/sbin"
  : > "$home/AGENTS.md"

  if FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --check >/dev/null 2>&1; then
    fail "fm-home-link --check accepted a stale unlinked home before repair"
  fi

  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --repair >/dev/null \
    || fail "fm-home-link --repair failed"
  assert_link_points "$home/sbin" "$code/sbin" "sbin link"
  assert_link_points "$home/AGENTS.md" "$code/AGENTS.md" "AGENTS.md link"
  assert_link_points "$home/.omp" "$code/.omp" ".omp link"
  for d in data state config projects; do
    [ -d "$home/$d" ] || fail "$d is not a local directory after repair"
    [ ! -L "$home/$d" ] || fail "$d was symlinked out of the mate home"
  done

  before=$(readlink "$home/sbin")
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$home" --repair >/dev/null \
    || fail "second fm-home-link --repair failed"
  [ "$(readlink "$home/sbin")" = "$before" ] || fail "idempotent repair changed sbin target"

  printf '%s\n' '- alpha [trunk +yolo] - alpha project (added 2026-07-08)' > "$home/data/projects.md"
  out=$(FM_HOME="$home" FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$home/sbin/fm" project-mode alpha 2>&1) \
    || fail "project mode through symlinked sbin failed: $out"
  [ "$out" = 'trunk on' ] || fail "symlinked sbin did not read mate-home data/projects.md: $out"

  mkdir -p "$conflict/data" "$conflict/state" "$conflict/config" "$conflict/projects"
  printf '%s\n' conflict > "$conflict/.fm-secondmate-home"
  printf 'local instructions must survive\n' > "$conflict/AGENTS.md"
  if FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$conflict" --repair >/dev/null 2>&1; then
    fail "fm-home-link clobbered a non-empty AGENTS.md conflict"
  fi
  out=$(cat "$conflict/AGENTS.md")
  [ "$out" = 'local instructions must survive' ] || fail "conflict content was modified: $out"
  pass "fm-home-link repairs shared-code links, keeps operational dirs local, and refuses conflicts"
}

# Contract: repair removes only the obsolete broken legacy bin link (then layout
# recreates bin/ as a local directory). A user-owned regular file at bin/
# blocks layout repair without modification.
test_home_link_removes_broken_legacy_bin_without_clobbering_user_file() {
  require_slice_scripts
  local code broken_home user_home out
  code="$TMP_ROOT/legacy-bin-code"
  broken_home="$TMP_ROOT/broken-bin-home"
  user_home="$TMP_ROOT/user-bin-home"
  make_code_root "$code"
  code=$(canonical "$code")

  make_link_home "$code" "$broken_home" brokenbin
  rm -rf "$broken_home/bin"
  ln -s "$TMP_ROOT/missing-bin-target" "$broken_home/bin"
  if FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$broken_home" --check >/dev/null 2>&1; then
    fail "fm-home-link --check accepted an obsolete broken bin link"
  fi
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$broken_home" --repair >/dev/null \
    || fail "fm-home-link --repair failed to remove obsolete broken bin link"
  [ ! -L "$broken_home/bin" ] || fail "repair left obsolete broken bin symlink"
  [ -d "$broken_home/bin" ] || fail "repair did not recreate bin/ as a local directory"
  if FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$broken_home" --check >/dev/null 2>&1; then
    :
  else
    fail "fm-home-link --check rejected the repaired home"
  fi

  make_link_home "$code" "$user_home" userbin
  rm -rf "$user_home/bin"
  printf 'user-owned bin content\n' > "$user_home/bin"
  if FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$HOME_LINK" home-link "$user_home" --repair >/dev/null 2>&1; then
    fail "fm-home-link --repair accepted a conflicting regular file at bin/"
  fi
  [ -f "$user_home/bin" ] || fail "repair removed the user-owned bin file"
  [ "$(cat "$user_home/bin")" = 'user-owned bin content' ] \
    || fail "repair changed the user-owned bin file"
  pass "fm-home-link removes broken legacy bin links without touching user files"
}


# Contract: current secondmate spawn repairs shared-code links in a prepared
# non-git mate home before launch.
test_symlink_home_spawn_lifecycle() {
  require_slice_scripts
  local case_dir main_home mate_home fakebin out log
  case_dir="$TMP_ROOT/spawn"
  main_home="$case_dir/main-home"
  mate_home="$case_dir/mates/design"
  make_main_home "$main_home"
  fakebin=$(make_fake_toolchain "$case_dir")
  make_link_home "$ROOT" "$mate_home" design
  mate_home=$(canonical "$mate_home")
  printf 'design charter\n' > "$mate_home/data/charter.md"
  rm -f "$mate_home/sbin"

  log="$case_dir/herdr.log"
  out=$(PATH="$fakebin:$BASE_PATH" \
    FM_HOME="$main_home" \
    FM_CODE_ROOT_OVERRIDE="$ROOT" \
    FM_ROOT_OVERRIDE="$ROOT" \
    FM_FAKE_HERDR_LOG="$log" \
    spawn design "$mate_home" omp --secondmate 2>&1) || fail "secondmate spawn failed after broken link: $out"
  assert_link_points "$mate_home/sbin" "$ROOT/sbin" "spawn-repaired sbin link"
  assert_contains "$(cat "$log")" "--cwd> <$mate_home" "spawn did not launch in the mate home"
  assert_contains "$(cat "$log")" "FM_HOME" "spawn did not pass mate-home environment to herdr"
  assert_contains "$out" "kind=secondmate" "spawn output did not report secondmate kind"
  [ -f "$main_home/state/design.meta" ] || fail "spawn did not write secondmate meta"
  assert_contains "$(cat "$main_home/state/design.meta")" "home=$mate_home" "spawn meta did not preserve home path"
  pass "symlink home spawn repairs links before launch"
}

# Contract: fm-update --repair-links repairs and verifies non-git mate homes
# without trying to run git inside them.
test_update_repairs_non_git_symlink_home() {
  require_slice_scripts
  local case_dir code main_home mate_home out
  case_dir="$TMP_ROOT/update-repair"
  code="$case_dir/code-root"
  main_home="$case_dir/main-home"
  mate_home="$case_dir/mate-home"
  make_code_root "$code"
  code=$(canonical "$code")
  make_main_home "$main_home"
  make_link_home "$code" "$mate_home" repairsm
  rm -f "$mate_home/sbin"
  printf -- '- repairsm - repair test (home: %s; scope: repair; projects: alpha; added 2026-07-08)\n' \
    "$mate_home" > "$main_home/data/secondmates.md"
  {
    printf 'pane=w1:p1\n'
    printf 'kind=secondmate\n'
    printf 'home=%s\n' "$mate_home"
    printf 'harness=omp\n'
  } > "$main_home/state/repairsm.meta"

  out=$(FM_HOME="$main_home" FM_ROOT_OVERRIDE="$code" FM_CODE_ROOT_OVERRIDE="$code" "$UPDATE" update --repair-links 2>&1) \
    || fail "fm-update --repair-links failed: $out"
  assert_contains "$out" "secondmate repairsm: symlink home verified" "update did not report symlink home verification"
  assert_link_points "$mate_home/sbin" "$code/sbin" "update-repaired sbin link"
  [ ! -d "$mate_home/.git" ] || fail "update converted non-git mate home into a git checkout"
  pass "fm-update --repair-links repairs and verifies non-git symlink homes without git-updating them"
}

test_home_link_allows_missing_claude_link
test_home_link_removes_legacy_claude_symlink
test_home_link_preserves_non_symlink_claude_objects

test_current_layout_home_link_check_passes
test_current_layout_broken_extension_link_fails
test_current_layout_repairs_extension_link
test_current_layout_repair_discovers_shared_skills
test_legacy_whole_omp_link_still_passes
test_home_link_repairs_shared_code_without_moving_operational_dirs
test_home_link_removes_broken_legacy_bin_without_clobbering_user_file

test_symlink_home_spawn_lifecycle
test_update_repairs_non_git_symlink_home

echo "# all symlink home migration tests passed"
