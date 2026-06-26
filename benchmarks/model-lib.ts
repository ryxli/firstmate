// Shared modeling primitives for the OLD and NEW replays: the constants that
// represent the LLM-facing artifacts each system forces the supervisor to
// ingest, plus the stale-detection both systems share.

import type { FleetEvent, TaskMeta } from "./types.ts";

// ---------------------------------------------------------------------------
// 40-line pane peek (bin/fm-peek.sh default). On a STALE wake the supervisor
// must peek the pane to diagnose the stuck crewmate - the reason/digest alone
// cannot tell you WHY it stalled. This cost is charged to BOTH systems, so the
// stale comparison isolates the drain/re-arm ceremony, not the diagnosis.
// A representative, deterministic tail of a crewmate agent pane (constant, so
// re-runs are identical).
export const PEEK_40 = [
	"  Reading src/auth/oauth.ts (1-120)",
	"  The callback handler builds the redirect URL from req.query.state,",
	"  then exchanges the code at the token endpoint. I need the client",
	"  secret to sign the exchange request, but it is not in the env I can",
	"  see. Let me check the config loader for where secrets are sourced.",
	"  $ rg -n CLIENT_SECRET src/ config/",
	"  src/config/env.ts:42:  const clientSecret = process.env.OAUTH_CLIENT_SECRET",
	"  config/env.example:8:OAUTH_CLIENT_SECRET=",
	"  The example file has an empty value and process.env does not define",
	"  it in this worktree. Without the secret the token exchange returns",
	"  401 invalid_client, so the integration test cannot pass.",
	"  $ bun test test/oauth.callback.test.ts",
	"  oauth callback > exchanges code for token",
	"  expected 200, received 401 { error: 'invalid_client' }",
	"   at test/oauth.callback.test.ts:31:5",
	"  1 fail, 0 pass [412.00ms]",
	"  I tried sourcing a local .env but the key is genuinely absent from",
	"  this environment. Generating a throwaway secret would not match the",
	"  registered OAuth app, so the exchange would still be rejected.",
	"  Options I can see: (a) the captain provisions a staging client",
	"  secret, (b) I stub the token endpoint behind a flag for the test,",
	"  (c) I skip the live exchange and assert only the redirect URL shape.",
	"  Option (b) changes production code paths for a test, which the brief",
	"  warns against. Option (c) reduces coverage of the exact bug we are",
	"  fixing. Option (a) is the clean path but needs a credential I do not",
	"  have. I do not want to pick (b) or (c) unilaterally because both",
	"  trade away correctness, so this is a genuine decision point.",
	"  Re-reading the brief for any credential-provisioning guidance...",
	"  The brief says 'use the staging OAuth app' but does not say where",
	"  its secret lives. I checked data/, config/, and the worktree root.",
	"  $ ls -a config/",
	"  .  ..  env.example  identity",
	"  No secret file present. I have exhausted the local options.",
	"  Waiting on the client secret before I can finish the exchange path.",
	"  I will hold here rather than guess at a value that cannot work.",
	"  (idle - no further action possible without the credential)",
	"  Last command exited 0; no new output since.",
	"  Composer empty; awaiting input.",
	"  ----",
	"  context: 31% used",
].join("\n");

// ---------------------------------------------------------------------------
// The per-cycle drain -> handle -> re-arm ceremony the OLD supervisor MUST emit
// and read every wake-handling turn (AGENTS.md "On wake" step 1 drain +
// "After handling drained wakes, re-arm bin/fm-watch.sh"). This is the literal
// instruction overhead the redesign removes: the agent emits the drain command,
// emits the re-arm (the one-shot watcher relaunched as a tracked background
// task), and reads the arm-confirmation line.
//
// Deliberately CONSERVATIVE (favors OLD): it omits the fm-guard.sh banners, the
// status-reporting protocol reminders, and the full run_in_background invocation
// the agent actually retypes, so the measured NEW win is a lower bound.
export const RITUAL_TEXT = [
	"bin/fm-wake-drain.sh",
	"bin/fm-watch-arm.sh",
	"watcher: started pid=00000 (beacon fresh)",
].join("\n");

// A durable wake-queue record exactly as fm-wake-lib.sh appends and
// fm-wake-drain.sh prints it back to the agent: epoch<TAB>seq<TAB>kind<TAB>key<TAB>payload.
// Epoch/seq are synthetic-but-deterministic (derived from event offset + a
// per-run counter) so re-runs are identical.
export function queueRecord(
	epoch: number,
	seq: number,
	kind: "signal" | "stale" | "check" | "heartbeat",
	key: string,
	payload: string,
): string {
	return `${epoch}\t${seq}\t${kind}\t${key}\t${payload}`;
}

// Synthetic deterministic epoch for a record at event offset `t` (ms).
export function epochFor(t: number): number {
	return 1700000000 + Math.floor(t / 1000);
}

// A ship task parked on a green PR: its meta records a pr= AND its status file's
// last non-empty line is a terminal done-PR / PR-ready state. Mirrors
// fm-watch.sh awaiting_merge(): case "$last" in done:*" PR "*|*"PR ready"*).
export function isParkedOnGreenPR(
	meta: TaskMeta | undefined,
	lastStatusLine: string | undefined,
): boolean {
	if (!meta?.pr || !lastStatusLine) return false;
	return /^done:.* PR /i.test(lastStatusLine) || /PR ready/i.test(lastStatusLine);
}

// A stale condition detected from the replay: a pane re-observed still idle
// (idle->idle) without a status update, past the stale threshold. Shared by
// both systems so the peek diagnosis cost is identical; only the surrounding
// ceremony differs.
export type StaleWake = { task: string; pane: string };

// Detect stale wakes from the corpus. Keys off explicit idle->idle
// re-observations (the corpus marker for "went idle and stayed idle"). Skips
// kind=secondmate panes (an idle secondmate is healthy) and ship tasks parked
// on a green PR (idle by design while awaiting merge) - exactly fm-watch.sh's
// two narrow stale-skips. One stale wake per eligible pane.
export function detectStaleWakes(
	events: readonly FleetEvent[],
	metas: Record<string, TaskMeta>,
): StaleWake[] {
	const out: StaleWake[] = [];
	const seenPane = new Set<string>();
	// running last-status-line per task, to evaluate parked-on-PR at the time.
	const lastStatus = new Map<string, string>();
	for (const e of events) {
		if (e.kind === "status" && e.status_line) lastStatus.set(e.task, e.status_line);
		if (e.kind !== "herdr") continue;
		if (!(e.herdr_from === "idle" && e.herdr_to === "idle")) continue;
		if (seenPane.has(e.pane)) continue;
		const meta = metas[e.task];
		if (meta?.kind === "secondmate") continue;
		if (isParkedOnGreenPR(meta, lastStatus.get(e.task))) continue;
		seenPane.add(e.pane);
		out.push({ task: e.task, pane: e.pane });
	}
	return out;
}
