#!/usr/bin/env bash
set -eu

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/data" "$TMP/config" "$TMP/state"

cat > "$TMP/data/projects.md" <<'EOF'
- defaulted - Default project (added 2026-07-16)
- main [direct-main +yolo] - Direct main project (added 2026-07-16)
- local [local-only] - Local project (added 2026-07-16)
EOF

brief_for() {
  id=$1
  repo=$2
  FM_ROOT_OVERRIDE="$ROOT" \
  FM_DATA_OVERRIDE="$TMP/data" \
  FM_CONFIG_OVERRIDE="$TMP/config" \
  FM_STATE_OVERRIDE="$TMP/state" \
    "$ROOT/sbin/fm-brief.sh" "$id" "$repo" >/dev/null
  cat "$TMP/data/$id/brief.md"
}

assert_contains() {
  haystack=$1
  needle=$2
  label=$3
  case "$haystack" in
    *"$needle"*) ;;
    *)
      printf 'FAIL %s: missing <%s>\n' "$label" "$needle" >&2
      exit 1
      ;;
  esac
}

assert_not_contains() {
  haystack=$1
  needle=$2
  label=$3
  case "$haystack" in
    *"$needle"*)
      printf 'FAIL %s: unexpected <%s>\n' "$label" "$needle" >&2
      exit 1
      ;;
    *) ;;
  esac
}

main_brief=$(brief_for task-main main)
assert_contains "$main_brief" 'This project ships **direct-main**' 'direct-main mode text'
assert_contains "$main_brief" 'Do NOT open a PR' 'direct-main forbids PRs'
assert_contains "$main_brief" 'Do NOT force-push' 'direct-main forbids force pushes'
assert_contains "$main_brief" 'The `+yolo` flag never relaxes these safeguards.' 'direct-main yolo safeguard'
assert_contains "$main_brief" 'reviewed by you' 'direct-main requires reviewed branch'
assert_contains "$main_brief" 'test -z "$(git status --porcelain)"' 'direct-main requires clean branch'
assert_contains "$main_brief" 'lock_dir="$(git rev-parse --git-common-dir)/fm-direct-main-delivery.lock"' 'direct-main shared writer lock'
assert_contains "$main_brief" 'git fetch origin main' 'direct-main fetches before delivery'
assert_contains "$main_brief" 'git merge-base --is-ancestor "$base" "$head"' 'direct-main proves ancestry'
assert_contains "$main_brief" 'git push origin "$head:refs/heads/main"' 'direct-main pushes exact head normally'
assert_contains "$main_brief" 'remote=$(git rev-parse origin/main)' 'direct-main fetch-back reads remote SHA'
assert_contains "$main_brief" 'test "$remote" = "$head"' 'direct-main verifies remote SHA'
assert_not_contains "$main_brief" 'open a PR with `gh-axi`' 'direct-main has no PR creation path'
assert_not_contains "$main_brief" 'done: PR {url}' 'direct-main has no PR completion path'
assert_not_contains "$main_brief" '--force' 'direct-main has no force push flag'

pr_brief=$(brief_for task-pr defaulted)
assert_contains "$pr_brief" 'This project ships **direct-PR**' 'direct-PR remains default in brief'
assert_contains "$pr_brief" 'open a PR with `gh-axi`' 'direct-PR still opens PR'

local_brief=$(brief_for task-local local)
assert_contains "$local_brief" 'This project ships **local-only**' 'local-only unchanged in brief'
assert_contains "$local_brief" 'Do NOT push, do NOT open a PR, do NOT merge.' 'local-only still forbids push PR merge'
assert_not_contains "$local_brief" 'This project ships **direct-main**' 'local-only not direct-main'

printf 'ok fm-brief\n'
