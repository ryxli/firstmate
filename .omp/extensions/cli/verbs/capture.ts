// fm verb: capture - fail-open append of one fleet-plane capture event (steer/redo)
// to the events journal, for future supervision-quality analysis.
// Migrated verbatim (behavior-preserving) out of the former sbin/fm capture.
//
// Schema matches the supervisor plane exactly so a future collector reads one
// schema. Writes are O_APPEND + fsync so a crash never truncates a previously
// flushed line. Fails open: any write error is swallowed and the command
// still exits 0.

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface CaptureEvent {
	ts: number;
	plane: "fleet";
	kind: string;
	author: "captain";
	target: string;
	raw: string;
	corrected: string;
	trace_ref: string;
	session_id: string;
	reachable: null;
}

function defaultEventsPath(): string {
	return join(homedir(), ".omp", "agent", "capture", "events.jsonl");
}

async function run(argv: string[]): Promise<number> {
	// Usage: fm capture <kind> <target> <corrected> [raw]
	//   kind      : steer | redo
	//   target    : mate pane id or name (e.g. fm-riggs)
	//   corrected : the steering message text
	//   raw       : optional prior context (empty string if not available)
	const [kind, target, corrected, raw] = argv.slice(1);
	if (kind === undefined || target === undefined || corrected === undefined) {
		process.stderr.write("fm capture: unbound variable (usage: fm capture <kind> <target> <corrected> [raw])\n");
		return 1;
	}

	try {
		const eventsPath = process.env.CAPTURE_EVENTS_PATH || defaultEventsPath();
		mkdirSync(dirname(eventsPath), { recursive: true });
		const event: CaptureEvent = {
			ts: Date.now(),
			plane: "fleet",
			kind,
			author: "captain",
			target,
			raw: raw ?? "",
			corrected,
			trace_ref: "",
			session_id: "",
			reachable: null,
		};
		const fd = openSync(eventsPath, "a");
		try {
			writeSync(fd, `${JSON.stringify(event)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// fail open - never exit non-zero over a capture write
	}
	return 0;
}

export default {
	name: "capture",
	describe: "Fail-open append of one fleet-plane capture event (steer/redo) to the events journal.",
	run,
};
