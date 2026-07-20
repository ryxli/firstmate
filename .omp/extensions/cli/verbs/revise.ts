// fm verb: revise - record a pre-accept correction packet.
// Usage: fm revise <task-id> --reason <text> [--must-change ...] [--must-remain ...] [--bar ...] [--full]

import { ensureArtifact, loadArtifact, revise, saveArtifact } from "../lib/artifact";
import { metaField, readTaskMeta, receiptLine } from "../lib/operator";

function flagVal(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

function takeTaskId(args: string[]): string | undefined {
	const flagNames = new Set(["--reason", "--must-change", "--must-remain", "--bar", "--project"]);
	for (let i = 0; i < args.length; i++) {
		if (flagNames.has(args[i])) {
			i++;
			continue;
		}
		if (args[i] === "--full" || args[i] === "--help" || args[i] === "-h") continue;
		if (args[i].startsWith("-")) continue;
		return args[i];
	}
	return undefined;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const taskId = takeTaskId(args);
	const reason = flagVal(args, "--reason");
	if (!taskId || !reason || args.includes("--help") || args.includes("-h")) {
		process.stderr.write(
			"usage: fm revise <task-id> --reason <text> [--must-change <t>] [--must-remain <t>] [--bar <t>] [--full]\n",
		);
		return taskId && reason ? 0 : 1;
	}

	const meta = readTaskMeta(taskId);
	const projectPath = meta ? metaField(meta.text, "project=") : "";
	const project = projectPath.split("/").filter(Boolean).pop() || flagVal(args, "--project") || "unknown";

	try {
		const record = ensureArtifact(taskId, project);
		revise(record, {
			why: reason,
			mustChange: flagVal(args, "--must-change") ?? "",
			mustRemain: flagVal(args, "--must-remain") ?? "",
			nextAcceptanceBar: flagVal(args, "--bar") ?? reason,
			priorPatchIds: record.revisions.map(r => r.patchId),
		});
		saveArtifact(record);
		receiptLine(`revise ${taskId}: ${reason}`);
		if (args.includes("--full")) {
			process.stdout.write(`${JSON.stringify(loadArtifact(taskId), null, 2)}\n`);
		}
		return 0;
	} catch (err) {
		process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

export default {
	name: "revise",
	describe: "Record a pre-accept correction packet; keep the implementation workspace open.",
	run,
};
