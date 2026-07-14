#!/usr/bin/env bash
# Verifies shell and in-process supervisor status relevance remain identical.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLASSIFY="$ROOT/sbin/fm-classify-status.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-classify-status.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

assert_shell() {
  local expected=$1 line=$2 out rc
  set +e
  out=$("$CLASSIFY" "$line")
  rc=$?
  set -e
  if [ "$expected" = captain ]; then
    [ "$rc" -eq 0 ] && [ "$out" = captain ] || fail "expected captain for: $line"
  else
    [ "$rc" -eq 1 ] && [ "$out" = internal ] || fail "expected internal for: $line"
  fi
}

positive=(
  '2026-07-05T12:34:56Z done: PR https://github.com/o/r/pull/1'
  'validation complete, PR ready for review'
  'CI finished with checks green on the PR'
  'implementation ready in branch fm/status-precision'
  'PR merged to main'
)
negative=(
  'already working through review notes'
  'still on an unmerged branch'
  'readying branch for a later push'
  'progress update before done: still running checks'
  'working: PR merged in another branch'
)

for line in "${positive[@]}"; do assert_shell captain "$line"; done
for line in "${negative[@]}"; do assert_shell internal "$line"; done
pass 'shell classifier anchors terminal prefixes and phrases'

cat > "$TMP/check.mjs" <<'JS'
const { classifyAndDigest } = await import(`${process.env.ROOT}/.omp/extensions/fm-supervisor.ts`);
const positives = JSON.parse(process.env.POSITIVES);
const negatives = JSON.parse(process.env.NEGATIVES);
let failures = 0;
for (const line of positives) {
  const result = classifyAndDigest([{ t: 1, kind: 'status', pane: 'w:p', task: 'task', status_line: line, relevant: true }]);
  if (result.wakes !== 1 || result.detected !== 1) { console.error(`positive did not wake: ${line}`); failures++; }
}
for (const line of negatives) {
  const result = classifyAndDigest([{ t: 1, kind: 'status', pane: 'w:p', task: 'task', status_line: line, relevant: false }]);
  if (result.wakes !== 0 || result.detected !== 0) { console.error(`negative woke: ${line}`); failures++; }
}
process.exitCode = failures === 0 ? 0 : 1;
JS
POSITIVES="$(printf '%s\n' "${positive[@]}" | bun -e 'const a=await new Response(Bun.stdin.stream()).text(); process.stdout.write(JSON.stringify(a.trimEnd().split("\n")))')" \
NEGATIVES="$(printf '%s\n' "${negative[@]}" | bun -e 'const a=await new Response(Bun.stdin.stream()).text(); process.stdout.write(JSON.stringify(a.trimEnd().split("\n")))')" \
ROOT="$ROOT" bun "$TMP/check.mjs" || fail 'supervisor classifier diverged from shell classifier'
pass 'supervisor classifier matches shell relevance'
