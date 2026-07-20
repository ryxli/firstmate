// fm verb: finish - resumable per-task drain: integrate → land → backlog → cleanup.
// Usage: fm finish <task-id>
// Bare global drain is intentionally unsupported until this path is proven.

import { finishTask, receiptLine } from "../lib/operator";

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const id = args.find(a => !a.startsWith("-"));
	if (!id || args.includes("--help") || args.includes("-h")) {
		process.stderr.write("usage: fm finish <task-id>\n");
		return id ? 0 : 1;
	}
	if (args.filter(a => !a.startsWith("-")).length !== 1) {
		process.stderr.write("error: fm finish requires exactly one <task-id> (no global drain)\n");
		return 1;
	}

	const result = finishTask(id);
	for (const line of result.lines) receiptLine(line);
	if (result.next) receiptLine(`next: ${result.next}`);
	return result.ok ? 0 : 1;
}

export default {
	name: "finish",
	describe: "Integrate, land, and clean up an accepted task.",
	surface: "captain",
	run,
};
