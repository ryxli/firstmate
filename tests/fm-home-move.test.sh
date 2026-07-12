#!/usr/bin/env bash
# Behavior tests for safe secondmate-home relocation.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

cleanup() {
  [ -z "${TMP_ROOT:-}" ] || rm -rf "$TMP_ROOT"
}

trap cleanup EXIT
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-home-move-tests.XXXXXX")

make_fake_herdr() {
  local dir=$1 fakebin
  fakebin="$dir/fakebin"
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'herdr %s\n' "$*" >> "${FM_FAKE_HERDR_LOG:?}"
case "${1:-}:${2:-}" in
  worktree:move)
    path=
    shift 2
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --workspace) shift ;;
        --path) shift; path=${1:?} ;;
      esac
      shift
    done
    [ -n "$path" ]
    mv "${FM_FAKE_HERDR_HOME:?}" "$path"
    printf '{"id":"cli:worktree:move","result":{"worktree":{"checkout_path":"%s"}}}\n' "$path"

    ;;
  *) exit 2 ;;
esac
SH
  chmod +x "$fakebin/herdr"
  printf '%s\n' "$fakebin"
}

canonical_new_path() {
  local path=$1
  printf '%s/%s\n' "$(cd "$(dirname "$path")" && pwd -P)" "$(basename "$path")"
}

make_seeded_home() {
  local home=$1 id=$2
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects"
  printf '%s\n' "$id" > "$home/.fm-secondmate-home"
}

make_fixture() {
  local name=$1 id=$2 main home
  main="$TMP_ROOT/$name-main"
  home="$TMP_ROOT/$name-home"
  mkdir -p "$main/data" "$main/state" "$main/config" "$main/projects"
  make_seeded_home "$home" "$id"
  printf '%s\n' "- $id - test domain (home: $home; workspace: ws-$id; name: Test; scope: test; projects: (none); added 2026-07-12)" > "$main/data/secondmates.md"
  cat > "$main/state/$id.meta" <<EOF
pane=ws-$id:p1
worktree=$home
project=$home
kind=secondmate
mode=secondmate
home=$home
workspace=ws-$id
EOF
  printf '%s\n%s\n' "$main" "$home"
}
run_move() {
  local main=$1 home=$2 id=$3 target=$4 fakebin=$5 log=$6
  PATH="$fakebin:$PATH" FM_HOME="$main" FM_FAKE_HERDR_HOME="$home" FM_FAKE_HERDR_LOG="$log" \
    "$ROOT/sbin/fm-home-move.sh" "$id" "$target"
}

test_relocates_managed_home_end_to_end() {
  local fixture main home target fakebin log out
  fixture=$(make_fixture managed design)
  main=$(printf '%s\n' "$fixture" | sed -n '1p')
  home=$(printf '%s\n' "$fixture" | sed -n '2p')
  target=$(canonical_new_path "$TMP_ROOT/managed-moved")
  fakebin=$(make_fake_herdr "$TMP_ROOT/managed-herdr")
  log="$TMP_ROOT/managed-herdr.log"
  : > "$log"

  out=$(run_move "$main" "$home" design "$target" "$fakebin" "$log") || fail "managed home relocation failed"
  [ ! -e "$home" ] || fail "old managed home remained after relocation"
  [ -d "$target" ] || fail "managed home was not moved to target"
  grep -F "home: $target;" "$main/data/secondmates.md" >/dev/null || fail "registry home was not repointed"
  grep -F 'workspace:' "$main/data/secondmates.md" >/dev/null && fail "stale workspace registry field was retained"
  grep -Fx "home=$target" "$main/state/design.meta" >/dev/null || fail "meta home was not repointed"
  grep -Fx "worktree=$target" "$main/state/design.meta" >/dev/null || fail "meta worktree was not repointed"
  grep -F '^workspace=' "$main/state/design.meta" >/dev/null && fail "stale meta workspace field was retained"
  grep -F "herdr worktree move --workspace ws-design --path $target" "$log" >/dev/null || fail "managed relocation did not use herdr worktree move"
  printf '%s\n' "$out" | grep -F 'cleared stale herdr workspace record: ws-design' >/dev/null || fail "move did not document stale workspace cleanup"
  printf '%s\n' "$out" | grep -F "restart when safe: $ROOT/sbin/fm-spawn.sh design --secondmate" >/dev/null || fail "move did not print restart command"
  pass "managed seeded home relocates and repoints durable records"
}

test_relocates_plain_clone_home() {
  local main home target
  main="$TMP_ROOT/plain-main"
  home="$TMP_ROOT/plain-home"
  target=$(canonical_new_path "$TMP_ROOT/plain-moved")
  mkdir -p "$main/data" "$main/state" "$main/config" "$main/projects"
  make_seeded_home "$home" plain
  printf '%s\n' "- plain - plain domain (home: $home; name: Plain; scope: test; projects: (none); added 2026-07-12)" > "$main/data/secondmates.md"
  cat > "$main/state/plain.meta" <<EOF
worktree=$home
kind=secondmate
home=$home
EOF

  FM_HOME="$main" "$ROOT/sbin/fm-home-move.sh" plain "$target" >/dev/null || fail "plain clone relocation failed"
  [ ! -e "$home" ] || fail "old plain home remained after relocation"
  [ -d "$target" ] || fail "plain home was not moved to target"
  grep -F "home: $target;" "$main/data/secondmates.md" >/dev/null || fail "plain registry home was not repointed"
  grep -Fx "home=$target" "$main/state/plain.meta" >/dev/null || fail "plain meta home was not repointed"
  grep -Fx "worktree=$target" "$main/state/plain.meta" >/dev/null || fail "plain meta worktree was not repointed"
  pass "plain clone home relocates with a directory move"
}

test_refuses_unregistered_id() {
  local fixture main home target fakebin log
  fixture=$(make_fixture unregistered registered)
  main=$(printf '%s\n' "$fixture" | sed -n '1p')
  home=$(printf '%s\n' "$fixture" | sed -n '2p')
  target="$TMP_ROOT/unregistered-target"
  fakebin=$(make_fake_herdr "$TMP_ROOT/unregistered-herdr")
  log="$TMP_ROOT/unregistered-herdr.log"
  : > "$log"

  if run_move "$main" "$home" missing "$target" "$fakebin" "$log" >/dev/null 2>&1; then
    fail "unregistered secondmate was accepted"
  fi
  [ -d "$home" ] || fail "unregistered-id refusal moved the home"
  [ ! -e "$target" ] || fail "unregistered-id refusal created target"
  pass "unregistered secondmate is refused"
}

test_refuses_existing_target() {
  local fixture main home target fakebin log
  fixture=$(make_fixture existing existing)
  main=$(printf '%s\n' "$fixture" | sed -n '1p')
  home=$(printf '%s\n' "$fixture" | sed -n '2p')
  target="$TMP_ROOT/existing-target"
  mkdir -p "$target"
  fakebin=$(make_fake_herdr "$TMP_ROOT/existing-herdr")
  log="$TMP_ROOT/existing-herdr.log"
  : > "$log"

  if run_move "$main" "$home" existing "$target" "$fakebin" "$log" >/dev/null 2>&1; then
    fail "existing target was accepted"
  fi
  [ -d "$home" ] || fail "existing-target refusal moved the home"
  grep -F "home: $home;" "$main/data/secondmates.md" >/dev/null || fail "existing-target refusal changed registry"
  pass "existing target is refused"
}

test_refuses_in_flight_work() {
  local fixture main home target fakebin log
  fixture=$(make_fixture inflight inflight)
  main=$(printf '%s\n' "$fixture" | sed -n '1p')
  home=$(printf '%s\n' "$fixture" | sed -n '2p')
  target="$TMP_ROOT/inflight-target"
  printf 'kind=ship\n' > "$home/state/child.meta"
  fakebin=$(make_fake_herdr "$TMP_ROOT/inflight-herdr")
  log="$TMP_ROOT/inflight-herdr.log"
  : > "$log"

  if run_move "$main" "$home" inflight "$target" "$fakebin" "$log" >/dev/null 2>&1; then
    fail "home with in-flight work was accepted"
  fi
  [ -d "$home" ] || fail "in-flight refusal moved the home"
  [ ! -e "$target" ] || fail "in-flight refusal created target"
  pass "in-flight work blocks home relocation"
}

test_relocates_managed_home_end_to_end
test_relocates_plain_clone_home
test_refuses_unregistered_id
test_refuses_existing_target
test_refuses_in_flight_work
