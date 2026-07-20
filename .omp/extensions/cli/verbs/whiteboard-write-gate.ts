// fm verb: whiteboard-write-gate - decide whether a lane event should write the board.
// Behavioral contract for skill://fm-supervise-lanes (change-gated writes).

import { applyWhiteboardWrite, shouldWriteWhiteboard, type WhiteboardEvent } from "../lib/whiteboard-write-gate";

const USAGE = `usage: fm whiteboard-write-gate [--json] <event-json>
       fm whiteboard-write-gate --self-test

Event JSON fields: kind, duplicate?, disposition?, priorAccepted?
Kinds that write: new-rejection, worker-working-to-ready, wake-condition-changed,
cap-decision, lane-state-changed, evidence-changed, disposition-changed.
Kinds that do not: duplicate-reviewer-completion, noop-system-notice.
`;

function selfTest(): number {
	const cases: Array<{ name: string; event: WhiteboardEvent; expectWrite: boolean }> = [
		{ name: "duplicate reviewer completion", event: { kind: "duplicate-reviewer-completion" }, expectWrite: false },
		{ name: "noop system notice", event: { kind: "noop-system-notice" }, expectWrite: false },
		{
			name: "new rejection",
			event: { kind: "new-rejection", disposition: "REJECT: missing proof", priorAccepted: ["accepted: scope frozen"] },
			expectWrite: true,
		},
		{ name: "working to ready", event: { kind: "worker-working-to-ready", priorAccepted: ["accepted: scope frozen"] }, expectWrite: true },
		{ name: "wake changed", event: { kind: "wake-condition-changed" }, expectWrite: true },
		{ name: "cap decision", event: { kind: "cap-decision", disposition: "ship it" }, expectWrite: true },
	];

	let board = "## OPERATOR VIEW\naccepted: scope frozen\n";
	let failed = 0;
	for (const c of cases) {
		const decision = shouldWriteWhiteboard(c.event);
		if (decision.write !== c.expectWrite) {
			process.stderr.write(`FAIL ${c.name}: write=${decision.write} want=${c.expectWrite}\n`);
			failed += 1;
			continue;
		}
		const line =
			c.event.kind === "new-rejection"
				? `disposition: ${c.event.disposition}`
				: c.event.kind === "cap-decision"
					? `decision: ${c.event.disposition}`
					: `event: ${c.event.kind}`;
		try {
			const applied = applyWhiteboardWrite(board, decision, line);
			if (applied.wrote) board = applied.board;
			if (c.expectWrite && c.event.priorAccepted) {
				for (const a of c.event.priorAccepted) {
					if (!board.includes(a)) {
						process.stderr.write(`FAIL ${c.name}: lost prior accepted state\n`);
						failed += 1;
					}
				}
			}
			process.stdout.write(`ok ${c.name} write=${decision.write}\n`);
		} catch (error) {
			process.stderr.write(`FAIL ${c.name}: ${(error as Error).message}\n`);
			failed += 1;
		}
	}
	if (failed > 0) {
		process.stderr.write(`whiteboard-write-gate self-test: ${failed} failed\n`);
		return 1;
	}
	process.stdout.write("whiteboard-write-gate self-test: pass\n");
	return 0;
}

async function run(argv: string[]): Promise<number> {
	if (argv[1] === "--self-test") return selfTest();

	let jsonMode = false;
	const args = argv.slice(1);
	if (args[0] === "--json") {
		jsonMode = true;
		args.shift();
	}
	const raw = args[0];
	if (!raw) {
		process.stderr.write(USAGE);
		return 2;
	}
	let event: WhiteboardEvent;
	try {
		event = JSON.parse(raw) as WhiteboardEvent;
	} catch {
		process.stderr.write("error: event must be JSON\n");
		return 2;
	}
	const decision = shouldWriteWhiteboard(event);
	if (jsonMode) {
		process.stdout.write(`${JSON.stringify(decision)}\n`);
	} else {
		process.stdout.write(`write=${decision.write ? "yes" : "no"} reason=${decision.reason}\n`);
	}
	return 0;
}

export default {
	name: "whiteboard-write-gate",
	describe: "Decide whether a lane event should write the whiteboard (change-gated).",
	run,
};
