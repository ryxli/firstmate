// fm verb: report - append one status line to a crewmate/secondmate status
// file, with a dependency-delivery contract layered on top.
// Ported verbatim (behavior-preserving) from the former sbin/fm report.
//
// Agents invoke this instead of `echo "<line>" >> <file>` directly: the omp
// bash tool blocks a direct echo/cat redirection in an agent's own command,
// but it allows invoking a helper that does the redirection internally. The
// supervising firstmate watches the status file (state/<id>.status) via
// fs.watch, so each appended line wakes it.
//
// Dependency-delivery contract (added 2026-07-15 after the witness-handoff
// incident: a producer's terminal event reached only its parent while the
// named consumer stayed blocked ~1h on an artifact that already existed):
//
//   Terminal fan-out. A line carrying `consumers=<file>[,<file>...]` is
//   appended to the primary status file AND to every named consumer status
//   file, so each consumer's own fs.watch fires. "Report to parent only"
//   can no longer suppress delivery to named consumers. Dependency-bearing
//   lines should also carry `producer=`, `artifact=`, and `event=<id>`.
//
//   Exactly-once. When a line carries `event=<id>`, delivery is idempotent
//   per destination file: a replayed event never appends twice, so duplicate
//   terminal events and replayed BLOCKED reports cannot storm a watcher.
//
//   BLOCKED validation. A line whose first token is BLOCKED must carry
//   `waiting_on=<artifact>`, `owner=`, and `callback=`; anything less is
//   rejected with exit 3 and nothing is recorded. If the awaited artifact
//   already exists, an `ARTIFACT_READY` wake line is appended in the same
//   invocation (before any other work can run), so a consumer blocked on an
//   existing artifact is woken immediately. Optional `waiting_on_sha=<sha256>`
//   pins artifact identity: a mismatch appends `ARTIFACT_STALE` and never a
//   ready wake.
//
// Plain lines without this grammar pass through byte-identical to the
// original single-append behavior.
// Usage: fm report <status-file> <status-line>

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

// Extract a `key=value` token from the line (first match; empty if absent).
function token(line: string, key: string): string {
	for (const part of line.split(" ")) {
		if (part.startsWith(`${key}=`)) return part.slice(key.length + 1);
	}
	return "";
}

function markerOf(line: string): string {
	if (line.startsWith("ARTIFACT_READY")) return "ARTIFACT_READY";
	if (line.startsWith("ARTIFACT_STALE")) return "ARTIFACT_STALE";
	if (line.startsWith("BLOCKED")) return "BLOCKED";
	return "";
}

// Idempotent append: with an event id, never append the same marker+event to
// the same destination twice; without one, preserve original append semantics.
function appendOnce(dest: string, line: string, eventId: string): void {
	mkdirSync(dirname(dest), { recursive: true });
	if (eventId && existsSync(dest)) {
		const contents = readFileSync(dest, "utf8");
		const marker = markerOf(line);
		const eventNeedle = `event=${eventId}`;
		const matchingLines = contents.split("\n").filter(l => l.includes(eventNeedle));
		let alreadyDelivered: boolean;
		if (marker) {
			alreadyDelivered = matchingLines.some(l => l.includes(marker));
		} else {
			alreadyDelivered = matchingLines.some(l => !/^ARTIFACT_(READY|STALE)/.test(l));
		}
		if (alreadyDelivered) return;
	}
	appendFileSync(dest, `${line}\n`);
}

// BLOCKED reports must reach their primary destination and every dependency
// consumer. Validation always happens before this function is called.
// consumers comes from the ORIGINAL BLOCKED line, not the wake line being fanned
// out: ARTIFACT_READY/ARTIFACT_STALE lines carry no consumers= token, yet must
// still reach every consumer named by the BLOCKED report that triggered them.
function fanOutBlocked(primary: string, reportLine: string, eventId: string, consumers: string): void {
	appendOnce(primary, reportLine, eventId);
	if (consumers) {
		for (const dest of consumers.split(",")) {
			if (dest) appendOnce(dest, reportLine, eventId);
		}
	}
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	if (args.length !== 2) {
		process.stderr.write("usage: fm report <status-file> <status-line>\n");
		return 2;
	}

	const [primary, line] = args;
	const eventId = token(line, "event");

	// --- BLOCKED contract ---------------------------------------------------
	if (line.startsWith("BLOCKED")) {
		const waitingOn = token(line, "waiting_on");
		const owner = token(line, "owner");
		const callback = token(line, "callback");
		if (!waitingOn || !owner || !callback) {
			process.stderr.write("fm-report: malformed BLOCKED line: waiting_on=, owner=, and callback= are required\n");
			return 3;
		}
		const consumers = token(line, "consumers");
		fanOutBlocked(primary, line, eventId, consumers);
		if (existsSync(waitingOn)) {
			const pinnedSha = token(line, "waiting_on_sha");
			if (pinnedSha) {
				const actualSha = createHash("sha256").update(readFileSync(waitingOn)).digest("hex");
				if (actualSha !== pinnedSha) {
					fanOutBlocked(primary, `ARTIFACT_STALE waiting_on=${waitingOn} expected=${pinnedSha} actual=${actualSha} event=${eventId}`, eventId, consumers);
					return 0;
				}
			}
			// The awaited artifact already exists: wake the blocked consumer now.
			fanOutBlocked(primary, `ARTIFACT_READY waiting_on=${waitingOn} owner=${owner} callback=${callback} event=${eventId}`, eventId, consumers);
		}
		return 0;
	}

	// --- ordinary append + terminal fan-out ---------------------------------
	appendOnce(primary, line, eventId);

	const consumers = token(line, "consumers");
	if (consumers) {
		for (const dest of consumers.split(",")) {
			if (dest) appendOnce(dest, line, eventId);
		}
	}
	return 0;
}

export default {
	name: "report",
	describe: "Append one status line to a crewmate/secondmate status file, with dependency-delivery fan-out.",
	run,
};
