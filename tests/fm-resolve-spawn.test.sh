#!/usr/bin/env bash
# Fast prerequisite checks for the resolve-spawn verb (sbin/fm resolve-spawn).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOLVE="$ROOT/sbin/fm"
SPAWN="$ROOT/sbin/fm"
# Resolve bun once, before any test restricts PATH: the cases below narrow
# PATH to exercise the *crew harness* PATH lookup, not bun's own #!/usr/bin/env
# shebang resolution for the fm dispatcher itself.
BUN="$(command -v bun)" || { printf 'not ok - bun not found on PATH\n' >&2; exit 1; }
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-resolve-spawn.XXXXXX")
# A bun-only dir for cases that restrict PATH but exec fm spawn, which
# shells back into sbin/fm: only the real bun binary is exposed (not the mise
# shim dir, which would leak every other shimmed tool into the sandbox).
BUNBIN="$TMP_ROOT/bunbin"
mkdir -p "$BUNBIN"
ln -s "$("$BUN" -e 'console.log(process.execPath)')" "$BUNBIN/bun"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

make_home() {
  local name=$1 home
  home="$TMP_ROOT/$name"
  mkdir -p "$home/data" "$home/worktrees"
  printf '%s\n' '- alpha [no-mistakes] - test project (added 2026-06-25)' > "$home/data/projects.md"
  printf '%s\n' "$home"
}

make_fakebin() {
  local dir=$1 name=$2
  mkdir -p "$dir"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$dir/$name"
  chmod +x "$dir/$name"
}

run_resolve() {
  local home=$1 path=$2; shift 2
  PATH="$path" \
    FM_ROOT_OVERRIDE='' \
    FM_HOME="$home" \
    FM_DATA_OVERRIDE='' \
    FM_WORKTREE_BASE="$home/worktrees" \
    "$BUN" "$RESOLVE" resolve-spawn "$@" 2>&1
}

test_missing_harness_binary_blocks() {
  local home out status
  home=$(make_home missing-harness)
  out=$(run_resolve "$home" /usr/bin:/bin alpha codex)
  status=$?
  [ "$status" -ne 0 ] || fail "missing harness should fail"
  printf '%s\n' "$out" | grep -F "spawn harness binary 'codex' was not found on PATH" >/dev/null \
    || fail "error did not name missing binary: $out"
  printf '%s\n' "$out" | grep -F 'check config/crew-harness' >/dev/null \
    || fail "error did not suggest config/crew-harness: $out"
  pass "missing harness binary blocks before spawn"
}

test_registry_miss_warns_but_allows() {
  local home fakebin out status
  home=$(make_home registry-warn)
  fakebin="$TMP_ROOT/fakebin-registry"
  make_fakebin "$fakebin" omp
  out=$(run_resolve "$home" "$fakebin:/usr/bin:/bin" beta omp)
  status=$?
  [ "$status" -eq 0 ] || fail "registry miss should not fail: $out"
  printf '%s\n' "$out" | grep -F "warn: project 'beta' does not appear" >/dev/null \
    || fail "registry miss did not warn: $out"
  pass "unregistered project warns but does not block"
}

test_registered_project_is_quiet() {
  local home fakebin out status
  home=$(make_home registry-hit)
  fakebin="$TMP_ROOT/fakebin-hit"
  make_fakebin "$fakebin" omp
  out=$(run_resolve "$home" "$fakebin:/usr/bin:/bin" projects/alpha omp)
  status=$?
  [ "$status" -eq 0 ] || fail "registered project should pass: $out"
  [ -z "$out" ] || fail "registered project should not warn: $out"
  pass "registered project passes quietly"
}

test_missing_worktree_parent_blocks() {
  local home fakebin out status missing_base
  home=$(make_home missing-worktree-parent)
  fakebin="$TMP_ROOT/fakebin-worktree"
  make_fakebin "$fakebin" omp
  missing_base="$home/no-such-parent/worktrees"
  out=$(PATH="$fakebin:/usr/bin:/bin" FM_ROOT_OVERRIDE='' FM_HOME="$home" FM_WORKTREE_BASE="$missing_base" "$BUN" "$RESOLVE" resolve-spawn alpha omp 2>&1)
  status=$?
  [ "$status" -ne 0 ] || fail "missing worktree parent should fail"
  printf '%s\n' "$out" | grep -F "worktree base parent" >/dev/null \
    || fail "worktree error was unclear: $out"
  pass "missing worktree base parent blocks"
}

test_spawn_aborts_before_worktree_or_pane() {
  local home out status
  home=$(make_home spawn-preflight)
  mkdir -p "$home/projects/alpha" "$home/data/preflight-z9"
  (
    cd "$home/projects/alpha" || exit 1
    git init -q
    git config user.email t@t
    git config user.name t
    printf 'x\n' > seed.txt
    git add seed.txt
    git commit -qm init
  )
  printf 'brief\n' > "$home/data/preflight-z9/brief.md"
  out=$(PATH="/usr/bin:/bin:$BUNBIN" FM_ROOT_OVERRIDE='' FM_HOME="$home" FM_SPAWN_NO_GUARD=1 "$SPAWN" spawn preflight-z9 projects/alpha codex 2>&1)
  status=$?
  [ "$status" -ne 0 ] || fail "spawn with missing harness should fail"
  printf '%s\n' "$out" | grep -F "spawn harness binary 'codex' was not found on PATH" >/dev/null \
    || fail "spawn did not surface resolver error: $out"
  [ ! -e "$home/worktrees/preflight-z9" ] \
    || fail "spawn created a worktree after resolver failure"
  pass "fm spawn aborts before creating a worktree or pane"
}

test_missing_harness_binary_blocks
test_registry_miss_warns_but_allows
test_registered_project_is_quiet
test_missing_worktree_parent_blocks
test_spawn_aborts_before_worktree_or_pane
