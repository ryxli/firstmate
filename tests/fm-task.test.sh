#!/usr/bin/env bash
# Behavior tests for the native `fm task` backlog verb family: add, start,
# done, update, block, unblock, ready, show, plus idempotency and the
# free-form-line-preservation rule. Every home here is a hermetic tmp dir;
# the real repo's data/backlog.md is never touched.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FM="$ROOT/sbin/fm"
TMP_ROOT=

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

pass() {
	printf 'ok - %s\n' "$1"
}

cleanup() {
	if [ -n "${TMP_ROOT:-}" ]; then
		rm -rf "$TMP_ROOT"
	fi
}
trap cleanup EXIT

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-task-tests.XXXXXX")

# Each test case gets its own home dir under TMP_ROOT so state never bleeds
# across cases; $home/data/backlog.md is written fresh per case with
# fm_home().
home_n=0
fm_home() {
	home_n=$((home_n + 1))
	local home="$TMP_ROOT/home-$home_n"
	mkdir -p "$home/data"
	echo "$home"
}

run_fm() {
	local home="$1"
	shift
	FM_HOME="$home" FM_ROOT_OVERRIDE='' FM_DATA_OVERRIDE='' "$FM" task "$@"
}

run_fm_status() {
	local home="$1"
	shift
	FM_HOME="$home" FM_ROOT_OVERRIDE='' FM_DATA_OVERRIDE='' "$FM" task "$@" >/tmp/fm-task-test-out.$$ 2>/tmp/fm-task-test-err.$$
	echo $?
}

backlog_of() {
	echo "$1/data/backlog.md"
}

write_backlog() {
	local home="$1"
	shift
	printf '%s\n' "$@" > "$(backlog_of "$home")"
}

skeleton() {
	write_backlog "$1" \
		"## In flight" \
		"" \
		"## Queued" \
		"" \
		"## Parked" \
		"" \
		"## Done"
}

# ---------------------------------------------------------------------------
# add: Queued placement, --start placement, annotations, blocked-by
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
out=$(run_fm "$home" add demo-1 "first demo task" --kind ship --repo firstmate)
[ $? -eq 0 ] || fail "add: expected exit 0, got nonzero ($out)"
echo "$out" | grep -q "added demo-1 to Queued" || fail "add: unexpected stdout: $out"
grep -qF -- "- [ ] demo-1 - first demo task (kind: ship, repo: firstmate)" "$(backlog_of "$home")" \
	|| fail "add: item line not found in expected form"
pass "add: appends to Queued with kind/repo annotations"

home=$(fm_home)
skeleton "$home"
run_fm "$home" add demo-2 "started task" --start --date 2026-07-17 >/dev/null
grep -A2 '^## In flight' "$(backlog_of "$home")" | grep -qF -- "- [ ] demo-2 - started task (since 2026-07-17)" \
	|| fail "add --start: item not placed in In flight with since date"
pass "add --start: places item in In flight with the since date"

home=$(fm_home)
skeleton "$home"
run_fm "$home" add demo-3 "blocked task" --blocked-by other-1 --blocked-by other-2 >/dev/null
grep -qF -- "blocked-by: other-1,other-2" "$(backlog_of "$home")" \
	|| fail "add --blocked-by: blockers not recorded"
pass "add --blocked-by: records repeatable blockers"

home=$(fm_home)
skeleton "$home"
code=$(run_fm_status "$home" add "bad id with spaces" "text")
[ "$code" -eq 1 ] || fail "add: invalid id syntax must exit 1, got $code"
pass "add: rejects malformed id syntax with exit 1"

home=$(fm_home)
skeleton "$home"
run_fm "$home" add dup-1 "one" >/dev/null
code=$(run_fm_status "$home" add dup-1 "two")
[ "$code" -eq 2 ] || fail "add: duplicate id must exit 2, got $code"
before=$(cat "$(backlog_of "$home")")
run_fm "$home" add dup-1 "two" >/dev/null 2>&1
after=$(cat "$(backlog_of "$home")")
[ "$before" = "$after" ] || fail "add: duplicate id must leave file untouched"
pass "add: rejects a duplicate id, exit 2, file untouched"

home=$(fm_home)
write_backlog "$home" "## In flight" "" "## Queued"
code=$(run_fm_status "$home" add missing-done "text")
[ "$code" -eq 2 ] || fail "add: missing ## Done section must exit 2, got $code"
pass "add: malformed file (missing required section) exits 2"

# ---------------------------------------------------------------------------
# start: Queued -> In flight, idempotency, wrong-section rejection
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
run_fm "$home" add start-1 "a queued task" --repo app >/dev/null
run_fm "$home" start start-1 --date 2026-07-17 >/dev/null
grep -A2 '^## In flight' "$(backlog_of "$home")" | grep -qF -- "- [ ] start-1 - a queued task (repo: app, since 2026-07-17)" \
	|| fail "start: item not moved into In flight with repo preserved and since stamped"
! grep -A2 '^## Queued' "$(backlog_of "$home")" | grep -q "start-1" \
	|| fail "start: item must be removed from Queued"
pass "start: moves Queued item to In flight, preserving repo, stamping since"

out=$(run_fm "$home" start start-1 --date 2026-07-17)
code=$?
[ $code -eq 0 ] || fail "start: idempotent re-run must exit 0, got $code"
echo "$out" | grep -q "already in flight" || fail "start: idempotent re-run must say already in flight, got: $out"
lines_before=$(grep -c "start-1" "$(backlog_of "$home")")
[ "$lines_before" -eq 1 ] || fail "start: idempotent re-run must not duplicate the item line"
pass "start: re-running on an already-in-flight item is a no-op"

home=$(fm_home)
skeleton "$home"
code=$(run_fm_status "$home" start nonexistent)
[ "$code" -eq 2 ] || fail "start: unknown id must exit 2, got $code"
pass "start: unknown id exits 2"

home=$(fm_home)
write_backlog "$home" "## In flight" "" "## Queued" "" "## Parked" "- [ ] parked-2 - a parked task" "" "## Done"
code=$(run_fm_status "$home" start parked-2)
[ "$code" -eq 2 ] || fail "start: item outside Queued must exit 2, got $code"
pass "start: refuses to start an item that is not in Queued"

# ---------------------------------------------------------------------------
# done: proof variants, date stamping, idempotency, pruning + archive
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
run_fm "$home" add done-1 "ship this" >/dev/null
run_fm "$home" done done-1 --pr https://github.com/o/r/pull/9 --date 2026-07-17 >/dev/null
grep -A2 '^## Done' "$(backlog_of "$home")" | grep -qF -- "- [x] done-1 - ship this - https://github.com/o/r/pull/9 (2026-07-17)" \
	|| fail "done --pr: unexpected Done line form"
pass "done --pr: moves item to Done in the exact literal format"

home=$(fm_home)
skeleton "$home"
run_fm "$home" add done-2 "scout this" >/dev/null
run_fm "$home" done done-2 --report data/done-2/report.md --date 2026-07-17 >/dev/null
grep -qF -- "- [x] done-2 - scout this - data/done-2/report.md (2026-07-17)" "$(backlog_of "$home")" \
	|| fail "done --report: unexpected Done line form"
pass "done --report: records the report path as proof"

home=$(fm_home)
skeleton "$home"
run_fm "$home" add done-3 "merge this locally" >/dev/null
run_fm "$home" done done-3 --note "local main" --date 2026-07-17 >/dev/null
grep -qF -- "- [x] done-3 - merge this locally - local main (2026-07-17)" "$(backlog_of "$home")" \
	|| fail "done --note: unexpected Done line form"
pass "done --note: records a free-text note as proof"

code=$(run_fm_status "$home" done done-3 --note "local main" --date 2026-07-17)
[ "$code" -eq 0 ] || fail "done: idempotent re-run on an already-done item must exit 0, got $code"
count=$(grep -c "done-3" "$(backlog_of "$home")")
[ "$count" -eq 1 ] || fail "done: idempotent re-run must not duplicate the Done entry"
pass "done: re-running on an already-done item is a no-op"

home=$(fm_home)
skeleton "$home"
code=$(run_fm_status "$home" done nowhere --note "x")
[ "$code" -eq 2 ] || fail "done: unknown id must exit 2, got $code"
pass "done: unknown id exits 2"

home=$(fm_home)
skeleton "$home"
run_fm "$home" add ambiguous-flags "text" >/dev/null
code=$(run_fm_status "$home" done ambiguous-flags --pr https://x --note "y")
[ "$code" -eq 1 ] || fail "done: two proof flags at once must be a usage error (1), got $code"
pass "done: rejects more than one proof flag as a usage error"

home=$(fm_home)
skeleton "$home"
for i in $(seq 1 12); do
	run_fm "$home" add "prune-$i" "task number $i" >/dev/null
	run_fm "$home" done "prune-$i" --note "note $i" --date "2026-01-$(printf '%02d' "$i")" >/dev/null
done
done_count=$(awk '/^## Done/{f=1;next}/^## /{f=0}f' "$(backlog_of "$home")" | grep -c '^- \[x\]')
[ "$done_count" -eq 10 ] || fail "done: Done section must be pruned to 10 entries, got $done_count"
grep -qF -- "prune-12" "$(backlog_of "$home")" || fail "done: most recent completion must remain in Done"
grep -qF -- "prune-1" "$home/data/done-archive.md" || fail "done: oldest pruned entry must land in done-archive.md"
grep -qF -- "prune-2" "$home/data/done-archive.md" || fail "done: second-oldest pruned entry must land in done-archive.md"
! grep -qF -- "prune-1 -" "$(backlog_of "$home")" || fail "done: pruned entry must be removed from backlog.md"
pass "done: prunes Done to the 10 most recent, archiving pruned entries verbatim"

# ---------------------------------------------------------------------------
# update: --append and --title
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
run_fm "$home" add upd-1 "original text" --repo app >/dev/null
run_fm "$home" update upd-1 --append "extra note" >/dev/null
grep -qF -- "- [ ] upd-1 - original text; extra note (repo: app)" "$(backlog_of "$home")" \
	|| fail "update --append: expected appended note with repo annotation preserved"
pass "update --append: appends a note and preserves existing annotations"

run_fm "$home" update upd-1 --title "replaced text" >/dev/null
grep -qF -- "- [ ] upd-1 - replaced text (repo: app)" "$(backlog_of "$home")" \
	|| fail "update --title: text not replaced as expected"
pass "update --title: replaces the one-line text"

home=$(fm_home)
skeleton "$home"
run_fm "$home" add upd-2 "x" >/dev/null
run_fm "$home" done upd-2 --note "y" --date 2026-07-17 >/dev/null
code=$(run_fm_status "$home" update upd-2 --append "z")
[ "$code" -eq 2 ] || fail "update: updating a done item must exit 2, got $code"
pass "update: refuses to update a completed item"

# ---------------------------------------------------------------------------
# block / unblock / ready
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
run_fm "$home" add blk-a "task a" >/dev/null
run_fm "$home" add blk-b "task b" >/dev/null
run_fm "$home" block blk-b --by blk-a >/dev/null
grep -qF -- "blocked-by: blk-a" "$(backlog_of "$home")" || fail "block: blocker not recorded"
pass "block: records a blocker on the target item"

out=$(run_fm "$home" block blk-b --by blk-a)
code=$?
[ $code -eq 0 ] || fail "block: idempotent re-block must exit 0, got $code"
echo "$out" | grep -q "already blocked" || fail "block: idempotent re-block must report already blocked, got: $out"
count=$(grep -o "blk-a" "$(backlog_of "$home")" | wc -l | tr -d ' ')
[ "$count" -eq 2 ] || fail "block: idempotent re-block must not duplicate the blocker (expected 2 occurrences: item + blocked-by, got $count)"
pass "block: re-blocking by the same id is a no-op"

# ready: blk-b is blocked by blk-a (not done) -> not ready. blk-a has no
# blockers -> ready.
out=$(run_fm "$home" ready)
echo "$out" | grep -qF -- "blk-a" || fail "ready: unblocked item blk-a must be listed"
echo "$out" | grep -qF -- "blk-b" && fail "ready: blk-b must not be listed while its blocker is unresolved"
pass "ready: lists only Queued items with no unresolved blockers"

run_fm "$home" done blk-a --note "done" --date 2026-07-17 >/dev/null
out=$(run_fm "$home" ready)
echo "$out" | grep -qF -- "blk-b" || fail "ready: blk-b must become ready once its blocker is done"
pass "ready: an item becomes ready once its blocker is marked done"

run_fm "$home" unblock blk-b --by blk-a >/dev/null
! grep -q "blocked-by" "$(backlog_of "$home")" || fail "unblock: blocked-by suffix must be removed"
pass "unblock: removes a recorded blocker"

out=$(run_fm "$home" unblock blk-b --by blk-a)
code=$?
[ $code -eq 0 ] || fail "unblock: idempotent re-unblock must exit 0, got $code"
echo "$out" | grep -q "not blocked" || fail "unblock: idempotent re-unblock must report not blocked, got: $out"
pass "unblock: re-unblocking an already-unblocked id is a no-op"

# ---------------------------------------------------------------------------
# show
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
run_fm "$home" add show-1 "showable task" --repo app >/dev/null
out=$(run_fm "$home" show show-1)
[ "$out" = "- [ ] show-1 - showable task (repo: app)" ] || fail "show: unexpected output: $out"
pass "show: prints the item's full line"

code=$(run_fm_status "$home" show nope)
[ "$code" -eq 2 ] || fail "show: unknown id must exit 2, got $code"
pass "show: unknown id exits 2"

# ---------------------------------------------------------------------------
# free-form line preservation: prose lines and unrelated sections/items must
# survive every mutation byte for byte.
# ---------------------------------------------------------------------------

home=$(fm_home)
write_backlog "$home" \
	"## In flight" \
	"- [ ] keep-inflight - do not touch me (repo: keep, since 2026-01-01)" \
	"" \
	"## Queued" \
	"- [ ] keep-queued - also untouched" \
	"" \
	"## Parked (future work, revisit later)" \
	"- some free-form prose line about future plans, not a checklist item" \
	"- another prose line with -- dashes and (parentheses) inside it" \
	"" \
	"## Done" \
	"- [x] keep-done - already shipped - local main (2025-06-01)"

before_hash=$(shasum "$(backlog_of "$home")" | awk '{print $1}')

run_fm "$home" add fresh-1 "new item" --repo app >/dev/null
run_fm "$home" start fresh-1 >/dev/null
run_fm "$home" done fresh-1 --note "n" --date 2026-07-17 >/dev/null

grep -qF -- "- [ ] keep-inflight - do not touch me (repo: keep, since 2026-01-01)" "$(backlog_of "$home")" \
	|| fail "preservation: pre-existing In flight item must survive unchanged"
grep -qF -- "- [ ] keep-queued - also untouched" "$(backlog_of "$home")" \
	|| fail "preservation: pre-existing Queued item must survive unchanged"
grep -qF -- "## Parked (future work, revisit later)" "$(backlog_of "$home")" \
	|| fail "preservation: non-canonical Parked header text must survive unchanged"
grep -qF -- "- some free-form prose line about future plans, not a checklist item" "$(backlog_of "$home")" \
	|| fail "preservation: free-form prose line must survive unchanged"
grep -qF -- "- another prose line with -- dashes and (parentheses) inside it" "$(backlog_of "$home")" \
	|| fail "preservation: prose line with dashes/parens must survive unchanged"
grep -qF -- "- [x] keep-done - already shipped - local main (2025-06-01)" "$(backlog_of "$home")" \
	|| fail "preservation: pre-existing Done item must survive unchanged"
pass "free-form and unrelated lines survive add/start/done unmutated"

# ---------------------------------------------------------------------------
# atomicity: the backlog file is never left as a half-written temp artifact
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
run_fm "$home" add atomic-1 "check for stray tmp files" >/dev/null
leftover=$(find "$home/data" -maxdepth 1 -name 'backlog.md.tmp.*' | wc -l | tr -d ' ')
[ "$leftover" -eq 0 ] || fail "atomicity: a tmp file was left behind after a successful write"
pass "atomicity: no stray temp file remains after a successful mutation"

# ---------------------------------------------------------------------------
# usage errors leave the file untouched
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
before=$(cat "$(backlog_of "$home")")
run_fm "$home" add >/dev/null 2>&1
run_fm "$home" done some-id >/dev/null 2>&1
run_fm "$home" bogus-subcommand >/dev/null 2>&1
after=$(cat "$(backlog_of "$home")")
[ "$before" = "$after" ] || fail "usage errors must never mutate the backlog file"
pass "usage errors (missing args, unknown subcommand) never touch the file"

rm -f /tmp/fm-task-test-out.$$ /tmp/fm-task-test-err.$$

echo "all fm-task tests passed"
