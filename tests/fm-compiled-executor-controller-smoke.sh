#!/usr/bin/env bash
#
# Fresh-process smoke for the compiled-executor deadline controller.
#
# Proves end-to-end, in a brand-new OMP process, that a DETACHED compiled-executor
# action carrying a valid near deadline is automatically canceled at that
# deadline - no manual `hub wait` / `hub cancel` - its slow side effect never
# lands, and Firstmate receives exactly one structured reclaim event.
# The real compiled-executor is deadline-aware and self-stops, so in normal
# operation the controller is only a backstop. To exercise that backstop
# deterministically this smoke overrides the agent with a minimal stand-in named
# `compiled-executor` that blocks in the slow op and never self-stops - i.e. a
# wedged/deadline-ignoring lane - so the CONTROLLER is the party that cancels it.
#
# It exercises the real OMP `ctx.asyncJobs` control surface, so it is GATED on
# an OMP source/build that ships that API (the deterministic unit suite in
# fm-compiled-executor-controller.test.mjs covers the controller logic without
# it). Point FM_OMP_SRC at that CLI entry; the smoke SKIPs cleanly otherwise, so
# it never fails a stock CI that lacks the API build.
#
# Usage: tests/fm-compiled-executor-controller-smoke.sh
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
omp_src=${FM_OMP_SRC:-/Users/ryan/code/harness/firstmate/worktrees/extension-async-jobs-api/packages/coding-agent/src/cli.ts}
controller="$repo_root/.omp/extensions/fm-compiled-executor-controller.ts"

if [ ! -f "$omp_src" ]; then
	echo "SKIP: OMP source with ctx.asyncJobs not found at $omp_src (set FM_OMP_SRC)"
	exit 0
fi
if ! command -v bun >/dev/null 2>&1; then
	echo "SKIP: bun not on PATH"
	exit 0
fi

sleep_secs=90
deadline_secs=18
wall_budget=75
attempts=3

run_once() {
	local tmp sentinel deadline prompt start end wall reclaims
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/ce-smoke.XXXXXX")
	sentinel="${tmp}/action-completed.sentinel"
	mkdir -p "$tmp/sessions" "$tmp/.omp/extensions" "$tmp/.omp/agents"
	cp "$controller" "$tmp/.omp/extensions/"
	# Stand-in `compiled-executor` that never self-stops: it just runs the slow
	# op and blocks, so only the controller's deadline cancel can end it.
	cat >"$tmp/.omp/agents/compiled-executor.md" <<-'AGENT'
		---
		name: compiled-executor
		description: smoke stand-in that runs a slow op and blocks until canceled
		tools: bash, yield
		thinkingLevel: low
		---
		You are a smoke-test stand-in. Immediately call the `bash` tool once with
		the exact command on the `op-sleep` line of your assignment. Ignore the
		deadline. Do not stop early, do not call any other tool. Just issue that one
		bash command and let it run to completion.
	AGENT
	deadline=$(bun -e "console.log(new Date(Date.now()+${deadline_secs}000).toISOString())")

	# One detached compiled-executor spawn with the canonical header and a slow
	# op that only touches the sentinel if it runs to completion.
	prompt="Call the task tool exactly once, then stop and do nothing else. Use exactly these arguments:
agent: compiled-executor
id: smoke-slow
assignment: |
  action_id: SMOKE-SLOW-1
  deadline: ${deadline}
  exact scope: ${tmp} only
  ordered operations:
    1. op-sleep - run this exact bash command now: sleep ${sleep_secs} && touch ${sentinel}
  preconditions: none
  prohibited surfaces: everything outside ${tmp}
  verification steps: none
Do not call any other tool yourself. After the task tool call returns, stop."

	local -a runner=(bun "$omp_src" -p "$prompt"
		--cwd "$tmp" --session-dir "$tmp/sessions"
		--no-lsp --no-skills --no-title --auto-approve)
	if command -v timeout >/dev/null 2>&1; then
		runner=(timeout 180 "${runner[@]}")
	elif command -v gtimeout >/dev/null 2>&1; then
		runner=(gtimeout 180 "${runner[@]}")
	fi
	start=$(date +%s)
	"${runner[@]}" >"$tmp/run.log" 2>&1 || true
	end=$(date +%s)
	wall=$((end - start))

	local main late
	main=$(find "$tmp/sessions" -maxdepth 1 -name '*.jsonl' 2>/dev/null | head -1)
	reclaims=$(grep -aoc "compiled-executor-reclaim" "$main" 2>/dev/null || true)
	# A cancelled job's completion delivery is suppressed natively, so no
	# async-result entry should ever be written for the reclaimed lane.
	late=$(grep -aoc '"customType":"async-result"' "$main" 2>/dev/null || true)

	echo "  deadline=${deadline} wall=${wall}s reclaim=${reclaims} late-completion=${late} sentinel=$([ -e "$sentinel" ] && echo present || echo absent)"

	# 1) exactly one reclaim event delivered by the controller
	# 2) no async-result: the late completion of the cancelled job was suppressed
	# 3) the slow action's side effect never landed (canceled mid-flight)
	# 4) wall clock well under the slow op, so the deadline actually cut it short
	if [ "$reclaims" -eq 1 ] && [ "$late" -eq 0 ] && [ ! -e "$sentinel" ] && [ "$wall" -lt "$wall_budget" ]; then
		echo "  PASS (session: $tmp/sessions)"
		return 0
	fi
	echo "  attempt did not satisfy all conditions (log: $tmp/run.log)"
	return 1
}

echo "compiled-executor deadline controller smoke (sleep=${sleep_secs}s deadline=+${deadline_secs}s)"
for attempt in $(seq 1 "$attempts"); do
	echo "attempt ${attempt}/${attempts}:"
	if run_once; then
		echo "SMOKE PASS: detached compiled action auto-canceled at deadline; one reclaim event; no late completion."
		exit 0
	fi
done

echo "SMOKE FAIL: no attempt met all conditions."
exit 1
