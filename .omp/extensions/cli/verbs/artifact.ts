// fm verb: artifact - diagnostic show for durable artifact records.
// Usage: fm artifact show <task-id> [--full]
// Operator judgment/drain lives on fm accept / fm revise / fm finish.

import { loadArtifact } from "../lib/artifact";
import { receiptLine, shortSha } from "../lib/operator";

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const op = args[0];
	const id = args[1];
	if (!op || op === "--help" || op === "-h") {
		process.stderr.write("usage: fm artifact show <task-id> [--full]\n");
		return 0;
	}
	if (op !== "show") {
		process.stderr.write(`error: unknown artifact op '${op}'; use show (or fm accept / fm revise / fm finish)\n`);
		return 1;
	}
	if (!id) {
		process.stderr.write("usage: fm artifact show <task-id> [--full]\n");
		return 1;
	}
	const record = loadArtifact(id);
	if (!record) {
		process.stderr.write(`error: no artifact for ${id}\n`);
		return 1;
	}
	if (args.includes("--full")) {
		process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
		return 0;
	}
	const sha = shortSha(record.acceptedRevision?.candidateSha ?? record.revisions.at(-1)?.candidateSha ?? "-");
	receiptLine(
		`${id} review=${record.reviewState} delivery=${record.delivery?.state ?? "none"} mode=${record.delivery?.mode ?? "-"} sha=${sha}`,
	);
	return 0;
}

export default {
	name: "artifact",
	describe: "Show a task's durable artifact record.",
	surface: "captain",
	run,
};
