import type { FleetEvent, TaskMeta } from "./types.ts";

// A fixed representative pane tail.  Both models pay this diagnostic cost, so
// stale comparisons isolate supervision overhead rather than hiding diagnosis.
export const PEEK_40 = [
	"Reading src/auth/oauth.ts (1-120)",
	"The callback handler builds the redirect URL from req.query.state.",
	"The staging client secret is absent from this worktree.",
	"$ bun test test/oauth.callback.test.ts",
	"oauth callback > exchanges code for token",
	"expected 200, received 401 { error: 'invalid_client' }",
	"The brief requires a real staging credential before continuing.",
	"I checked data/, config/, and the worktree root.",
	"Waiting on the client secret before I can finish the exchange path.",
	"(idle - no further action possible without the credential)",
	"Last command exited 0; no new output since.",
	"Composer empty; awaiting input.",
].join("\n");

// The previous watcher protocol forced this drain and re-arm text into every
// wake-handling turn.  The model deliberately omits additional banners, making
// the comparison conservative for OLD.
export const RITUAL_TEXT = [
	"bin/fm-wake-drain.sh",
	"bin/fm-watch-arm.sh",
	"watcher: started pid=00000 (beacon fresh)",
].join("\n");

export function queueRecord(
	epoch: number,
	seq: number,
	kind: "signal" | "stale" | "check",
	key: string,
	payload: string,
): string {
	return `${epoch}\t${seq}\t${kind}\t${key}\t${payload}`;
}

export function epochFor(t: number): number {
	return 1_700_000_000 + Math.floor(t / 1000);
}


export type StaleWake = { task: string; pane: string };

// The corpus marks a stale backstop explicitly as idle->idle.  The live
// supervisor excludes healthy secondmates and completed PRs, as does this replay.
export function detectStaleWakes(events: readonly FleetEvent[], metas: Record<string, TaskMeta>): StaleWake[] {
	const wakes: StaleWake[] = [];
	const seen = new Set<string>();
	const lastStatus = new Map<string, string>();
	for (const event of events) {
		if (event.kind === "status" && event.status_line) lastStatus.set(event.task, event.status_line);
		if (event.kind !== "herdr" || event.herdr_from !== "idle" || event.herdr_to !== "idle") continue;
		if (seen.has(event.pane)) continue;
		const meta = metas[event.task];
		const terminalStatus = lastStatus.get(event.task);
		if (meta?.kind === "secondmate" || Boolean(meta?.pr && terminalStatus && (/^done:.* PR /i.test(terminalStatus) || /PR ready/i.test(terminalStatus)))) continue;
		seen.add(event.pane);
		wakes.push({ task: event.task, pane: event.pane });
	}
	return wakes;
}
