#!/usr/bin/env bash
# Verifies fm-pr-check registers gh-axi polling and preserves merged/silent output.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR_CHECK="$ROOT/sbin/fm-pr-check.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-pr-check.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

mkdir -p "$TMP/home/state" "$TMP/bin"
printf 'project=example\n' > "$TMP/home/state/task-a1.meta"
cat > "$TMP/bin/gh-axi" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FM_FAKE_GH_AXI_LOG:?}"
[ "${FM_FAKE_GH_AXI_FAIL:-0}" -eq 0 ] || exit 1
printf 'pull_request:\n  state: %s\n' "${FM_FAKE_PR_STATE:-open}"
SH
chmod +x "$TMP/bin/gh-axi"

URL=https://github.com/example/repo/pull/42
FM_HOME="$TMP/home" "$PR_CHECK" task-a1 "$URL" >/dev/null \
  || fail "fm-pr-check failed"
CHECK="$TMP/home/state/task-a1.check.sh"
[ -f "$CHECK" ] || fail "fm-pr-check did not write the check script"
grep -qF "gh-axi pr view \"\$PR_NUMBER\" --repo \"\$PR_REPO\"" "$CHECK" \
  || fail "check script did not use the gh-axi pr view contract"
! grep -qF 'gh pr view' "$CHECK" \
  || fail "check script still uses the raw gh pr view poll"
grep -qF "pr=$URL" "$TMP/home/state/task-a1.meta" \
  || fail "PR URL was not recorded in task metadata"
pass "PR check uses gh-axi pr view with repository targeting"

export FM_FAKE_GH_AXI_LOG="$TMP/gh-axi.log"
export PATH="$TMP/bin:$PATH"
output=$(FM_FAKE_PR_STATE=merged FM_FAKE_GH_AXI_FAIL=0 bash "$CHECK")
[ "$output" = merged ] || fail "merged check output was not exactly merged: $output"
grep -qF 'pr view 42 --repo example/repo' "$FM_FAKE_GH_AXI_LOG" \
  || fail "gh-axi did not receive parsed PR number and repository"
pass "merged PR check emits one merged line"

: > "$FM_FAKE_GH_AXI_LOG"
output=$(FM_FAKE_PR_STATE=open FM_FAKE_GH_AXI_FAIL=0 bash "$CHECK" || :)
[ -z "$output" ] || fail "open PR check was not silent: $output"
pass "unmerged PR check stays silent"

: > "$FM_FAKE_GH_AXI_LOG"
output=$(FM_FAKE_GH_AXI_FAIL=1 bash "$CHECK" || :)
[ -z "$output" ] || fail "failed PR check was not silent: $output"
pass "poll errors stay silent"
