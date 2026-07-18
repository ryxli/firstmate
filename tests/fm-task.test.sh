#!/usr/bin/env bash
# Behavior tests for the native `fm tasks`/`fm task` backlog verb family: the
# canonical plural dispatcher, its explicit singular alias, content-first
# TOON output, title/body separation, holds, reopen, priority, minting,
# pruning, the live-fleet facet, rigid did-you-mean failures, and the
# recursive scheduler compiled into `fm tasks ready`. Every home here is a
# hermetic tmp dir; the real repo's data/backlog.md is never touched.
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

fm_home() {
	local home
	home=$(mktemp -d "$TMP_ROOT/home.XXXXXX")
	mkdir -p "$home/data"
	# resolveMainHome (bridge/collect.ts) treats FM_HOME as an explicit main
	# home only when AGENTS.md is present (isExplicitMainHome); without it,
	# collectSnapshot() silently falls through past FM_HOME to the invoking
	# shell's cwd and then known clones, leaking the REAL live fleet's data
	# into a test that believes it is hermetic. Every fixture home must be
	# explicitly recognizable as its own main home.
	printf '# fixture main home\n' > "$home/AGENTS.md"
	printf '%s\n' "$home"
}

run_fm() {
	local home=$1; shift
	FM_HOME="$home" "$FM" "$@"
}

run_fm_status() {
	local home=$1; shift
	FM_HOME="$home" "$FM" "$@" >/dev/null 2>&1
	echo $?
}

backlog_of() {
	echo "$1/data/backlog.md"
}

write_backlog() {
	local home=$1; shift
	printf '%s\n' "$@" > "$(backlog_of "$home")"
}

skeleton() {
	write_backlog "$1" "## In flight" "" "## Queued" "" "## Done"
}

# ---------------------------------------------------------------------------
# dashboard + task/tasks alias equivalence
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
out=$(run_fm "$home" tasks)
echo "$out" | grep -qF 'in_flight: 0 tasks' || fail "dashboard: expected empty in_flight line, got: $out"
echo "$out" | grep -qF 'queued: 0 tasks' || fail "dashboard: expected empty queued line, got: $out"
echo "$out" | grep -qF 'done: 0 retained' || fail "dashboard: expected done retained line, got: $out"
pass "bare fm tasks prints a content-first dashboard"

out2=$(run_fm "$home" task)
[ "$out" = "$out2" ] || fail "task alias: bare fm task must be byte-identical to fm tasks, got: $out2"
pass "fm task (singular) is byte-identical to fm tasks for the same invocation"

# ---------------------------------------------------------------------------
# add: id/title, mint, priority, kind/repo tags, blocked-by, duplicate
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
out=$(run_fm "$home" tasks add demo-1 "first demo task" --kind ship --repo firstmate --priority 2)
echo "$out" | grep -q 'ok: added demo-1' || fail "add: expected ok confirmation, got: $out"
grep -qF -- '- [ ] demo-1 - first demo task' "$(backlog_of "$home")" || fail "add: item line not found"
grep -qF -- '(kind: ship)' "$(backlog_of "$home")" || fail "add: kind tag missing"
grep -qF -- '(repo: firstmate)' "$(backlog_of "$home")" || fail "add: repo tag missing"
grep -qF -- '(priority: 2)' "$(backlog_of "$home")" || fail "add: priority tag missing"
pass "add: appends to Queued with kind/repo/priority tags"

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add demo-2 "started task" --start --date 2026-07-17 >/dev/null
grep -A2 '^## In flight' "$(backlog_of "$home")" | grep -qF -- 'demo-2 - started task' \
	|| fail "add --start: item not placed in In flight"
grep -qF -- '(since 2026-07-17)' "$(backlog_of "$home")" || fail "add --start: since date missing"
pass "add --start: places item in In flight with the since date"

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add other-1 "a blocker" >/dev/null
run_fm "$home" tasks add demo-3 "blocked task" --blocked-by other-1 >/dev/null
grep -qF -- 'blocked-by: other-1' "$(backlog_of "$home")" || fail "add --blocked-by: blocker not recorded"
pass "add --blocked-by: records a dependency that must already exist"

home=$(fm_home)
skeleton "$home"
code=$(run_fm_status "$home" tasks add other-1 "blocked task" --blocked-by nonexistent)
[ "$code" -eq 2 ] || fail "add --blocked-by: nonexistent blocker must exit 2, got $code"
pass "add --blocked-by: refuses a blocker that does not exist"

home=$(fm_home)
skeleton "$home"
code=$(run_fm_status "$home" tasks add "bad id with spaces" "text")
[ "$code" -eq 2 ] || fail "add: invalid id syntax must exit nonzero, got $code"
pass "add: rejects malformed id syntax"

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add dup-1 "one" >/dev/null
out=$(run_fm "$home" tasks add dup-1 "two")
code=$?
[ "$code" -eq 0 ] || fail "add: duplicate id must be an idempotent no-op (exit 0), got $code"
echo "$out" | grep -qF 'already exists' || fail "add: duplicate id must report already exists, got: $out"
count=$(grep -c 'dup-1' "$(backlog_of "$home")")
[ "$count" -eq 1 ] || fail "add: duplicate id must not duplicate the line"
pass "add: re-adding an existing id is an idempotent no-op"

home=$(fm_home)
skeleton "$home"
out=$(run_fm "$home" tasks add "Fix Summary Toggle" --mint --prefix lavish --priority 1)
echo "$out" | grep -qE 'lavish-fix-summary-toggle-[0-9a-f]{2}' || fail "add --mint: expected minted slug-xx id, got: $out"
pass "add --mint: generates a slug-xx id from the title with a namespace prefix"

home=$(fm_home)
write_backlog "$home" "## In flight" "" "## Queued"
code=$(run_fm_status "$home" tasks add missing-done "text")
[ "$code" -eq 2 ] || fail "add: malformed file (missing ## Done) must exit nonzero, got $code"
pass "add: malformed backlog file (missing required section) fails closed"

# ---------------------------------------------------------------------------
# start / done / reopen: state transitions, idempotency, closure verbs
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add start-1 "a queued task" --repo app >/dev/null
run_fm "$home" tasks start start-1 --date 2026-07-17 >/dev/null
grep -A2 '^## In flight' "$(backlog_of "$home")" | grep -qF -- 'start-1 - a queued task' \
	|| fail "start: item not moved into In flight"
! grep -A2 '^## Queued' "$(backlog_of "$home")" | grep -q "start-1" \
	|| fail "start: item must be removed from Queued"
pass "start: moves Queued item to In flight, stamping since"

out=$(run_fm "$home" tasks start start-1)
code=$?
[ "$code" -eq 0 ] || fail "start: idempotent re-run must exit 0, got $code"
echo "$out" | grep -q "already in flight" || fail "start: idempotent re-run must say already in flight"
pass "start: re-running on an already-in-flight item is a no-op"

home=$(fm_home)
skeleton "$home"
code=$(run_fm_status "$home" tasks start nonexistent)
[ "$code" -eq 2 ] || fail "start: unknown id must exit nonzero, got $code"
pass "start: unknown id fails closed"

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add done-1 "ship this" >/dev/null
run_fm "$home" tasks done done-1 --pr https://github.com/o/r/pull/9 --date 2026-07-17 >/dev/null
grep -qF -- '- [x] done-1 - ship this - https://github.com/o/r/pull/9 (merged 2026-07-17)' "$(backlog_of "$home")" \
	|| fail "done --pr: unexpected Done line form (expected 'merged' closure verb)"
pass "done --pr: moves item to Done with the merged closure verb"

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add done-2 "scout this" >/dev/null
run_fm "$home" tasks done done-2 --report data/done-2/report.md --date 2026-07-17 >/dev/null
grep -qF -- '- [x] done-2 - scout this - data/done-2/report.md (reported 2026-07-17)' "$(backlog_of "$home")" \
	|| fail "done --report: unexpected Done line form (expected 'reported' closure verb)"
pass "done --report: records the report path with the reported closure verb"

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add done-3 "merge this locally" >/dev/null
run_fm "$home" tasks done done-3 --note "local main" --date 2026-07-17 >/dev/null
grep -qF -- '- [x] done-3 - merge this locally - local main (done 2026-07-17)' "$(backlog_of "$home")" \
	|| fail "done --note: unexpected Done line form (expected 'done' closure verb)"
out=$(run_fm "$home" tasks done done-3 --note "local main" --date 2026-07-17)
code=$?
[ "$code" -eq 0 ] || fail "done: idempotent re-run must exit 0, got $code"
count=$(grep -c "done-3" "$(backlog_of "$home")")
[ "$count" -eq 1 ] || fail "done: idempotent re-run must not duplicate the entry"
pass "done --note: records a free-text note and is idempotent"

home=$(fm_home)
skeleton "$home"
code=$(run_fm_status "$home" tasks done nowhere --note "x")
[ "$code" -eq 2 ] || fail "done: unknown id must exit nonzero, got $code"
pass "done: unknown id fails closed"

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add ambiguous-flags "text" >/dev/null
code=$(run_fm_status "$home" tasks done ambiguous-flags --pr https://x --note "y")
[ "$code" -ne 0 ] || fail "done: two proof flags at once must fail"
pass "done: rejects more than one proof flag"

home=$(fm_home)
skeleton "$home"
for i in $(seq 1 12); do
	run_fm "$home" tasks add "prune-$i" "task $i" >/dev/null
	run_fm "$home" tasks done "prune-$i" --note "n$i" --date 2026-07-17 >/dev/null
done
done_count=$(awk '/^## Done/{f=1;next}/^## /{f=0}f' "$(backlog_of "$home")" | grep -c '^- \[x\]')
[ "$done_count" -eq 10 ] || fail "done: Done section must be pruned to 10 entries, got $done_count"
grep -qF -- "prune-12" "$(backlog_of "$home")" || fail "done: most recent completion must remain in Done"
grep -qF -- "prune-1 -" "$home/data/done-archive.md" || fail "done: oldest pruned entry must land in done-archive.md"
! grep -qF -- "prune-1 -" "$(backlog_of "$home")" || fail "done: pruned entry must be removed from backlog.md"
pass "done: auto-prunes Done to the 10 most recent, archiving the rest"

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add reopen-1 "text" >/dev/null
run_fm "$home" tasks done reopen-1 --note "n" --date 2026-07-17 >/dev/null
run_fm "$home" tasks reopen reopen-1 >/dev/null
grep -A2 '^## Queued' "$(backlog_of "$home")" | grep -qF "reopen-1" || fail "reopen: item not moved back to Queued"
! grep -A5 '^## Done' "$(backlog_of "$home")" | grep -q "reopen-1" || fail "reopen: item still recorded in Done"
out=$(run_fm "$home" tasks reopen reopen-1)
echo "$out" | grep -q "already queued" || fail "reopen: idempotent re-run must say already queued"
pass "reopen: moves a Done item back to Queued and is idempotent"

# ---------------------------------------------------------------------------
# update: title/body separation, --archive-body, priority
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add upd-1 "original title" --repo app >/dev/null
run_fm "$home" tasks update upd-1 --title "replaced title" >/dev/null
grep -qF -- 'upd-1 - replaced title (repo: app)' "$(backlog_of "$home")" \
	|| fail "update --title: text not replaced as expected"
pass "update --title: replaces the one-line title, preserving tags"

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add upd-2 "task with notes" >/dev/null
run_fm "$home" tasks update upd-2 --body "first curated body" >/dev/null
out=$(run_fm "$home" tasks show upd-2 --full)
echo "$out" | grep -qF "first curated body" || fail "update --body: short body not recorded"
grep -qF -- '  first curated body' "$(backlog_of "$home")" || fail "update --body: body must render as an indented continuation line"
listout=$(run_fm "$home" tasks list)
echo "$listout" | grep -qF "first curated body" && fail "list: even a short body must never appear in list output (title/body separation)"
out_show=$(run_fm "$home" tasks show upd-2)
echo "$out_show" | grep -qF "first curated body" && fail "show (non-full): even a short body must never appear without --full"
pass "update --body: stores long-form notes separately; compact rows omit body entirely, --full reveals it"

run_fm "$home" tasks update upd-2 --body "second curated body" --archive-body >/dev/null
grep -qF "first curated body" "$home/data/note-archive.md" || fail "update --archive-body: superseded body not archived"
out=$(run_fm "$home" tasks show upd-2 --full)
echo "$out" | grep -qF "second curated body" || fail "update --archive-body: new body not recorded"
pass "update --archive-body: preserves the superseded body in note-archive.md"

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add upd-3 "x" >/dev/null
run_fm "$home" tasks done upd-3 --note "y" --date 2026-07-17 >/dev/null
code=$(run_fm_status "$home" tasks update upd-3 --title "z")
[ "$code" -eq 2 ] || fail "update: unknown/done-mismatched target must fail, got $code"
pass "update: fails closed against a nonexistent field target"

# ---------------------------------------------------------------------------
# block / unblock / ready (scheduler)
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add blk-a "task a" >/dev/null
run_fm "$home" tasks add blk-b "task b" >/dev/null
run_fm "$home" tasks block blk-b --by blk-a >/dev/null
grep -qF -- "blocked-by: blk-a" "$(backlog_of "$home")" || fail "block: blocker not recorded"
out=$(run_fm "$home" tasks block blk-b --by blk-a)
code=$?
[ "$code" -eq 0 ] || fail "block: idempotent re-block must exit 0, got $code"
echo "$out" | grep -q "already blocked" || fail "block: idempotent re-block must report already blocked"
pass "block: records a blocker and re-blocking is a no-op"

code=$(run_fm_status "$home" tasks block blk-a --by ghost-id)
[ "$code" -eq 2 ] || fail "block: nonexistent blocker must exit 2, got $code"
pass "block: refuses a --by target that does not exist"

out=$(run_fm "$home" tasks ready)
echo "$out" | grep -q 'class: active_command' || fail "ready: unblocked queue must yield active_command, got: $out"
echo "$out" | grep -qF -- 'next_command: fm tasks start blk-a' || fail "ready: expected next_command naming blk-a, got: $out"
echo "$out" | grep -qF -- "blk-a" || fail "ready: unblocked item blk-a must be listed"
echo "$out" | grep -qF -- "blk-b" && fail "ready: blk-b must not be listed while its blocker is unresolved"
pass "ready: scheduler names the highest-priority independent ready work"

run_fm "$home" tasks done blk-a --note "done" --date 2026-07-17 >/dev/null
out=$(run_fm "$home" tasks ready)
echo "$out" | grep -qF -- "blk-b" || fail "ready: blk-b must become ready once its blocker is Done"
pass "ready: an item becomes ready once its blocker is resolved via ## Done (not a live status signal)"

run_fm "$home" tasks unblock blk-b --by blk-a >/dev/null
! grep -q "blocked-by" "$(backlog_of "$home")" || fail "unblock: blocked-by suffix must be removed"
out=$(run_fm "$home" tasks unblock blk-b --by blk-a)
code=$?
[ "$code" -eq 0 ] || fail "unblock: idempotent re-unblock must exit 0, got $code"
echo "$out" | grep -q "not blocked" || fail "unblock: idempotent re-unblock must report not blocked"
pass "unblock: removes a recorded blocker and is idempotent"

# next_command emitted by ready must be a REAL, executable fm command that
# resolves to the intended behavior, not just a plausibly-named string.
home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add exec-check "run this" --priority 4 >/dev/null
out=$(run_fm "$home" tasks ready)
next_cmd=$(echo "$out" | grep '^next_command:' | sed 's/^next_command: //')
[ "$next_cmd" = "fm tasks start exec-check" ] || fail "ready: unexpected next_command: $next_cmd"
run_fm "$home" ${next_cmd#fm } >/dev/null || fail "ready: emitted next_command did not execute successfully"
grep -A2 '^## In flight' "$(backlog_of "$home")" | grep -qF "exec-check" \
	|| fail "ready: executing the emitted next_command did not reach the intended start behavior"
pass "ready: the emitted next_command executes through the real fm parser and reaches its intended command"

# ready with only blocked work: unblock_action names the exact blocker.
home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add root-blocker "root" >/dev/null
run_fm "$home" tasks add root-dependent "dependent" --blocked-by root-blocker >/dev/null
run_fm "$home" tasks start root-blocker >/dev/null
out=$(run_fm "$home" tasks ready)
echo "$out" | grep -q 'class: unblock_action' || fail "ready: fully-blocked queue must yield unblock_action, got: $out"
echo "$out" | grep -qF -- 'id: root-dependent' || fail "ready: unblock_action must name the blocked task"
echo "$out" | grep -qF -- 'blocked_by[1]: root-blocker' || fail "ready: unblock_action must name the unresolved blocker"
action=$(echo "$out" | grep '^action:' | sed 's/^action: //')
inline_cmd=$(echo "$action" | grep -oE '`fm tasks [a-z]+ [a-zA-Z0-9._-]+`' | tr -d '`' | head -1)
[ -n "$inline_cmd" ] || fail "ready: unblock_action's action must embed a runnable fm tasks command, got: $action"
run_fm "$home" ${inline_cmd#fm } >/dev/null || fail "ready: the command embedded in unblock_action's action did not execute"
pass "ready: unblock_action names an explicit, executable unblock command"

# empty local queue with no fleet data at all: completion (idle), the fourth
# and final class, never a fixed wait.
home=$(fm_home)
skeleton "$home"
out=$(run_fm "$home" tasks ready)
echo "$out" | grep -q 'class: completion' || fail "ready: fully idle backlog must yield completion, got: $out"
echo "$out" | grep -qF 'fully reconciled' || fail "ready: idle completion must explain nothing is outstanding"
pass "ready: an idle local queue and idle fleet yields completion (nothing outstanding)"

# malformed backlog -> failure class, evidence-backed.
home=$(fm_home)
write_backlog "$home" "## In flight" "" "## Queued"
out=$(run_fm "$home" tasks ready)
code=$?
echo "$out" | grep -q 'class: failure' || fail "ready: malformed backlog must yield failure, got: $out"
[ "$code" -eq 2 ] || fail "ready: failure class must exit nonzero, got $code"
pass "ready: a malformed local backlog yields an evidence-backed failure class"

# ---------------------------------------------------------------------------
# recursive scheduler + live fleet: a worker-reported completion is never
# treated as delivery-mode landed; a legitimately merged lane is.
# ---------------------------------------------------------------------------

home=$(fm_home)
mkdir -p "$home/data" "$home/state" "$home/sbin"
: > "$home/sbin/fm-spawn.sh"
write_backlog "$home" "## In flight" "- [ ] landed-1 - ship this (repo: demo, since 2026-07-17)" "" "## Queued" "" "## Done"
cat > "$home/state/landed-1.meta" <<'EOF'
kind=ship
worker=self
pane=w1:p1
EOF
cat > "$home/state/landed-1.status" <<'EOF'
done: PR https://github.com/o/r/pull/9 merged
EOF
out=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$home" "$FM" tasks ready)
echo "$out" | grep -q 'class: completion' || fail "ready: a legitimately merged fleet lane must yield completion, got: $out"
echo "$out" | grep -qF -- 'reason: "MERGED' || fail "ready: completion lane must carry the MERGED evidence, got: $out"
fleet_cmd=$(echo "$out" | grep '^next_command:' | sed 's/^next_command: //')
echo "$fleet_cmd" | grep -qE '^fm tasks fleet get ' || fail "ready: completion next_command must be fm tasks fleet get, got: $fleet_cmd"
FM_HOME="$home" FM_ROOT_OVERRIDE="$home" "$FM" ${fleet_cmd#fm } >/dev/null \
	|| fail "ready: emitted fm tasks fleet get command did not execute successfully"
pass "ready: distinguishes delivery-mode landing (MERGED) from a bare worker-done report, emitting a real fleet get command"

home2=$(fm_home)
mkdir -p "$home2/data" "$home2/state" "$home2/sbin"
: > "$home2/sbin/fm-spawn.sh"
write_backlog "$home2" "## In flight" "- [ ] worker-done-1 - ship this (repo: demo, since 2026-07-17)" "" "## Queued" "" "## Done"
cat > "$home2/state/worker-done-1.meta" <<'EOF'
kind=ship
worker=self
pane=w1:p1
EOF
cat > "$home2/state/worker-done-1.status" <<'EOF'
done: PR https://github.com/o/r/pull/9 ready in branch
EOF
out=$(FM_HOME="$home2" FM_ROOT_OVERRIDE="$home2" "$FM" tasks ready)
echo "$out" | grep -q 'class: completion' && echo "$out" | grep -qF 'lane:' \
	&& fail "ready: a worker-reported ready-in-branch (not yet landed) must NOT be treated as a completion lane: $out"
pass "ready: worker completion alone (ready in branch, not merged) never counts as a legitimately closed lane"

# ---------------------------------------------------------------------------
# hold / unhold / ready --include-held, date gates
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add hold-1 "task to hold" >/dev/null
run_fm "$home" tasks hold hold-1 --reason "captain decision pending" --kind captain >/dev/null
grep -qF -- '(hold: captain decision pending)' "$(backlog_of "$home")" || fail "hold: reason not recorded"
grep -qF -- '(hold-kind: captain)' "$(backlog_of "$home")" || fail "hold: kind not recorded"
out=$(run_fm "$home" tasks ready)
echo "$out" | grep -E '^[[:space:]]+hold-1,' && fail "ready: held task must not appear as a row in the plain ready list"
out=$(run_fm "$home" tasks ready --include-held)
echo "$out" | grep -A3 '^held\[' | grep -qF "hold-1" || fail "ready --include-held: held task must appear in the held group"
pass "hold: excludes a task from ready; --include-held surfaces it in a separate group"

out=$(run_fm "$home" tasks hold hold-1 --reason "captain decision pending" --kind captain)
echo "$out" | grep -q "already held" || fail "hold: idempotent re-hold must report already held"
pass "hold: re-holding with the identical reason/kind is a no-op"

run_fm "$home" tasks unhold hold-1 >/dev/null
! grep -q "hold:" "$(backlog_of "$home")" || fail "unhold: hold tags must be removed"
out=$(run_fm "$home" tasks ready)
echo "$out" | grep -qF "hold-1" || fail "unhold: task must become ready again"
pass "unhold: clears the hold and the task becomes ready again"

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add expired-hold "expired hold task" >/dev/null
run_fm "$home" tasks hold expired-hold --reason "wait for launch" --until 2020-01-01 >/dev/null
out=$(run_fm "$home" tasks ready)
echo "$out" | grep -qF "expired-hold" || fail "ready: a hold whose --until date has passed must not block readiness"
pass "hold --until: a date-gated hold becomes inactive on and after its date"

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add paren-reason "x" >/dev/null
code=$(run_fm_status "$home" tasks hold paren-reason --reason "has (parens) in it")
[ "$code" -ne 0 ] || fail "hold: a reason containing parentheses must be rejected"
pass "hold: rejects a reason containing parentheses (reserved for canonical tags)"

# ---------------------------------------------------------------------------
# mv: happy-path smoke (fm-secondmate.test.sh owns the full validated-home
# safety matrix)
# ---------------------------------------------------------------------------

main=$(fm_home)
sub="$TMP_ROOT/mv-sub"
mkdir -p "$sub/data" "$sub/sbin"
touch "$sub/AGENTS.md"
echo "mv-sub" > "$sub/.fm-secondmate-home"
skeleton "$main"
printf -- '- mv-sub - x (home: %s; scope: x; projects: alpha; added 2026-07-18)\n' "$sub" > "$main/data/secondmates.md"
run_fm "$main" tasks add handoff-1 "hand this off" --repo alpha >/dev/null
run_fm "$main" tasks mv handoff-1 --to mv-sub >/dev/null
! grep -qF "handoff-1" "$(backlog_of "$main")" || fail "mv: item must leave the main backlog"
grep -qF -- '- [ ] handoff-1 - hand this off (repo: alpha)' "$sub/data/backlog.md" \
	|| fail "mv: item did not arrive byte-exact in the secondmate backlog"
pass "mv: hands a queued item off to a validated secondmate home byte-exact"

code=$(run_fm_status "$main" tasks mv handoff-1 --to ghost-secondmate)
[ "$code" -ne 0 ] || fail "mv: unregistered secondmate id must be refused"
pass "mv: refuses an unregistered secondmate id"

# ---------------------------------------------------------------------------
# fleet facet: fm tasks fleet === fm fleet tasks (same collector)
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
skeleton "$home"
tasks_fleet=$(run_fm "$home" tasks fleet)
fleet_tasks=$(run_fm "$home" fleet tasks)
tasks_fleet_result=$(echo "$tasks_fleet" | grep -v '^command:')
fleet_tasks_result=$(echo "$fleet_tasks" | grep -v '^command:')
[ "$tasks_fleet_result" = "$fleet_tasks_result" ] || fail "fleet facet: fm tasks fleet result must match fm fleet tasks result byte-for-byte (only the self-identifying command label may differ)"
pass "fm tasks fleet and fm fleet tasks reuse the identical collector"

flag_form=$(run_fm "$home" tasks --fleet)
[ "$flag_form" = "$tasks_fleet" ] || fail "fleet facet: fm tasks --fleet must match fm tasks fleet"
pass "fm tasks --fleet is equivalent to fm tasks fleet"

# ---------------------------------------------------------------------------
# render: normalizes recognized items, leaves free-form lines untouched
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add render-1 "task" --repo app >/dev/null
run_fm "$home" tasks render >/dev/null
grep -qF -- 'render-1 - task (repo: app)' "$(backlog_of "$home")" || fail "render: item not present after normalization"
pass "render: normalizes the backlog without losing recognized items"

# ---------------------------------------------------------------------------
# rigid did-you-mean: unknown subcommands run nothing
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
before=$(cat "$(backlog_of "$home")")
out=$(run_fm "$home" tasks lst)
code=$?
[ "$code" -ne 0 ] || fail "did-you-mean: unknown subcommand must fail"
echo "$out" | grep -qi 'did you mean' || fail "did-you-mean: expected a structured suggestion, got: $out"
echo "$out" | grep -qF 'list' || fail "did-you-mean: expected 'list' to be suggested for 'lst', got: $out"
after=$(cat "$(backlog_of "$home")")
[ "$before" = "$after" ] || fail "did-you-mean: an unknown subcommand must never mutate the backlog"
pass "unknown subcommand gets a structured did-you-mean and mutates nothing"

out=$(FM_HOME="$home" "$FM" tasx)
code=$?
[ "$code" -ne 0 ] || fail "did-you-mean: unknown top-level verb must fail"
echo "$out" | grep -qi 'did you mean' || fail "did-you-mean: top-level unknown verb expected a suggestion, got: $out"
echo "$out" | grep -qF 'tasks' || fail "did-you-mean: expected 'tasks' to be suggested for 'tasx', got: $out"
pass "an unknown top-level verb gets a structured did-you-mean naming tasks/task"

# The cap explicitly rejected a `next` alias: the recursive scheduler lives
# in `ready`, and `next` must not be advertised anywhere nor accepted as a
# subcommand.
home=$(fm_home)
skeleton "$home"
tasks_help=$(run_fm "$home" tasks --help)
echo "$tasks_help" | grep -qw 'next' && fail "fm tasks --help must not advertise a next subcommand, got: $tasks_help"
task_help=$(run_fm "$home" task --help)
echo "$task_help" | grep -qw 'next' && fail "fm task --help must not advertise a next subcommand, got: $task_help"
pass "fm tasks/fm task --help never advertises next; ready is the sole scheduler command"

before=$(cat "$(backlog_of "$home")")
out=$(run_fm "$home" tasks next)
code=$?
[ "$code" -ne 0 ] || fail "fm tasks next must fail (no next alias), got exit $code: $out"
echo "$out" | grep -qF 'UNKNOWN_SUBCOMMAND' || fail "fm tasks next must be a structured UNKNOWN_SUBCOMMAND error, got: $out"
after=$(cat "$(backlog_of "$home")")
[ "$before" = "$after" ] || fail "fm tasks next must never mutate the backlog"
pass "fm tasks next is a structured, non-mutating unknown-command error"

# ---------------------------------------------------------------------------
# free-form line preservation: prose lines and unrelated sections/items must
# survive every mutation byte for byte.
# ---------------------------------------------------------------------------

home=$(fm_home)
write_backlog "$home" \
	"## In flight" \
	"- [ ] keep-inflight - do not touch me (repo: keep) (since 2026-01-01)" \
	"" \
	"## Queued" \
	"- [ ] keep-queued - also untouched" \
	"" \
	"## Parked (future work, revisit later)" \
	"- some free-form prose line about future plans, not a checklist item" \
	"- another prose line with -- dashes and (parentheses) inside it" \
	"" \
	"## Done" \
	"- [x] keep-done - already shipped - local main (done 2025-06-01)"

run_fm "$home" tasks add fresh-1 "new item" --repo app >/dev/null
run_fm "$home" tasks start fresh-1 >/dev/null
run_fm "$home" tasks done fresh-1 --note "n" --date 2026-07-17 >/dev/null

grep -qF -- "- [ ] keep-inflight - do not touch me (repo: keep) (since 2026-01-01)" "$(backlog_of "$home")" \
	|| fail "preservation: pre-existing In flight item must survive unchanged"
grep -qF -- "- [ ] keep-queued - also untouched" "$(backlog_of "$home")" \
	|| fail "preservation: pre-existing Queued item must survive unchanged"
grep -qF -- "## Parked (future work, revisit later)" "$(backlog_of "$home")" \
	|| fail "preservation: non-canonical Parked header text must survive unchanged"
grep -qF -- "- some free-form prose line about future plans, not a checklist item" "$(backlog_of "$home")" \
	|| fail "preservation: free-form prose line must survive unchanged"
grep -qF -- "- another prose line with -- dashes and (parentheses) inside it" "$(backlog_of "$home")" \
	|| fail "preservation: prose line with dashes/parens must survive unchanged"
grep -qF -- "- [x] keep-done - already shipped - local main (done 2025-06-01)" "$(backlog_of "$home")" \
	|| fail "preservation: pre-existing Done item must survive unchanged"
pass "free-form and unrelated lines survive add/start/done unmutated"

# ---------------------------------------------------------------------------
# atomicity + usage errors leave the file untouched
# ---------------------------------------------------------------------------

home=$(fm_home)
skeleton "$home"
run_fm "$home" tasks add atomic-1 "check for stray tmp files" >/dev/null
leftover=$(find "$home/data" -maxdepth 1 -name 'backlog.md.tmp.*' | wc -l | tr -d ' ')
[ "$leftover" -eq 0 ] || fail "atomicity: a tmp file was left behind after a successful write"
pass "atomicity: no stray temp file remains after a successful mutation"

home=$(fm_home)
skeleton "$home"
before=$(cat "$(backlog_of "$home")")
run_fm "$home" tasks add >/dev/null 2>&1
run_fm "$home" tasks done some-id >/dev/null 2>&1
run_fm "$home" tasks bogus-subcommand >/dev/null 2>&1
after=$(cat "$(backlog_of "$home")")
[ "$before" = "$after" ] || fail "usage errors must never mutate the backlog file"
pass "usage errors (missing args, unknown subcommand) never touch the file"

echo "all fm-task tests passed"
