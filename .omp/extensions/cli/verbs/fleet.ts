// fm verb: fleet - compact activation, health, attention, task, and agent overview.
// Migrated verbatim (behavior-preserving) out of the former sbin/fm monolith.

import {
	collectSnapshot,
	findAgent,
	findTask,
	normalizeTaskState,
	rankedTasks,
} from "../../bridge/collect";
import type { TaskRow } from "../../bridge/fleet";
import { updateFleet } from "../../bridge/update";
import { ambiguous, missing, operationalError, output, validationError } from "../common";
import { commandHelp } from "../help";

async function run(argv: string[]): Promise<number> {
	if (argv.length === 1) {
		try {
			const snapshot = await collectSnapshot();
			output({ command: "fleet", result: snapshot });
			return 0;
		} catch (error) {
			return operationalError("fleet", error);
		}
	}
	if (argv[1] === "--help" || argv[1] === "-h") {
		output(commandHelp("fm fleet"));
		return 0;
	}
	if (argv[1] === "--check") {
		if (argv.length !== 2) return validationError(`Unexpected argument: ${argv.slice(2).join(" ")}`, ["Use `fm fleet --check` without additional arguments."]);
		try {
			const snapshot = await collectSnapshot();
			output({ command: "fleet", result: snapshot });
			return snapshot.activation?.state === "fresh" && snapshot.health?.state === "healthy" ? 0 : 1;
		} catch (error) {
			return operationalError("fleet --check", error);
		}
	}

	const command = argv[1];
	if (command === "fleet") return validationError(`Unexpected argument: ${argv.slice(1).join(" ")}`, ["Run `fm fleet --help` for available commands."]);
	try {
		if (command === "update") {
			if (argv.length === 3 && (argv[2] === "--help" || argv[2] === "-h")) {
				output({ command: "fleet update", usage: "fm fleet update", description: "Selectively fast-forward registered homes and prove live-session reloads." });
				return 0;
			}
			if (argv.length > 2) return validationError(`Unexpected argument: ${argv.slice(2).join(" ")}`, ["Use `fm fleet update` without arguments."]);
			const update = await updateFleet();
			output({ command: "fleet update", result: update });
			if (update.results.some(target => target.status === "failed")) return 1;
			return update.results.some(target => target.status === "pending") ? 1 : 0;
		}
		if (command === "tasks") {
			let state: TaskRow["state"] | undefined;
			if (argv.length === 3 && (argv[2] === "--help" || argv[2] === "-h")) {
				output({ command: "fleet tasks", usage: "fm fleet tasks [--state <in-flight|queued|done>]", description: "Ranked task list." });
				return 0;
			}
			if (argv.length === 3 || argv.length > 4 || (argv.length === 2 && argv[2])) {
				return validationError("Invalid fleet tasks arguments", ["Use `fm fleet tasks [--state <in-flight|queued|done>]`."]);
			}
			if (argv.length === 4) {
				if (argv[2] !== "--state") return validationError(`Unexpected argument: ${argv[2]}`, ["Use `--state` to filter tasks."]);
				state = normalizeTaskState(argv[3]);
				if (!state) return validationError(`Invalid task state: ${argv[3]}`, ["Choose in-flight, queued, or done."]);
			}
			const snapshot = await collectSnapshot();
			output({ command: "fleet tasks", result: rankedTasks(snapshot, state) });
			return 0;
		}
		if (command === "task" || command === "agent") {
			if (argv[2] === "--help" || argv[2] === "-h") {
				if (argv.length !== 3) return validationError(`Unexpected argument: ${argv.slice(3).join(" ")}`, [`Use \`fm fleet ${command} --help\` without additional arguments.`]);
				output({ command: `fleet ${command} get`, usage: `fm fleet ${command} get <id>`, description: `Full ${command} record.` });
				return 0;
			}
			if (argv.length !== 4 || argv[2] !== "get" || !argv[3]) return validationError(`Usage: fm fleet ${command} get <id>`, ["Provide one canonical owner-qualified key or a unique bare id."]);
			const snapshot = await collectSnapshot();
			if (command === "task") {
				const found = findTask(snapshot, argv[3]);
				if (found.candidates.length > 1) return ambiguous("task", argv[3], found.candidates);
				if (!found.task) return missing("task", argv[3]);
				output({ command: "fleet task get", result: found.task });
				return 0;
			}
			const found = findAgent(snapshot, argv[3]);
			if (found.candidates.length > 1) return ambiguous("agent", argv[3], found.candidates);
			if (!found.agent) return missing("agent", argv[3]);
			output({ command: "fleet agent get", result: found.agent });
			return 0;
		}
		if (command === "metrics") {
			if (argv[2] === "--help" || argv[2] === "-h") {
				if (argv.length !== 3) return validationError(`Unexpected argument: ${argv.slice(3).join(" ")}`, ["Use `fm fleet metrics --help` without additional arguments."]);
				output({ command: "fleet metrics", usage: "fm fleet metrics", description: "Optional cost and productivity metrics." });
			}
			if (argv.length > 2) return validationError(`Unexpected argument: ${argv.slice(2).join(" ")}`, ["Use `fm fleet metrics` without arguments."]);
			const snapshot = await collectSnapshot(new Date().toISOString(), undefined, { includeMetrics: true });
			output({ command: "fleet metrics", result: snapshot.metrics ?? null });
			return 0;
		}
		if (command === "snapshot") {
			const rest = argv.slice(2);
			let asJson = false;
			let includeMetrics = false;
			let home: string | undefined;
			let statsFile: string | undefined;
			for (let index = 0; index < rest.length; index += 1) {
				const arg = rest[index];
				if (arg === "--json") asJson = true;
				else if (arg === "--metrics") includeMetrics = true;
				else if (arg === "--home") {
					const value = rest[index + 1];
					if (!value || value.startsWith("-")) return validationError("--home requires a value", ["Provide a firstmate home path after --home."]);
					home = value;
					index += 1;
				} else if (arg === "--stats-file") {
					const value = rest[index + 1];
					if (!value || value.startsWith("-")) return validationError("--stats-file requires a value", ["Provide a stats JSON path after --stats-file."]);
					statsFile = value;
					index += 1;
				} else if (arg === "--help" || arg === "-h") {
					output({ command: "fleet snapshot", usage: "fm fleet snapshot [--json] [--metrics] [--home <path>] [--stats-file <path>]", description: "Raw FleetSnapshot for visual consumers; --json emits raw JSON, otherwise TOON." });
					return 0;
				} else {
					return validationError(`Unexpected argument: ${arg}`, ["Use `fm fleet snapshot [--json] [--metrics] [--home <path>] [--stats-file <path>]`."]);
				}
			}
			const snapshot = await collectSnapshot(new Date().toISOString(), home, { includeMetrics, statsFile });
			if (asJson) {
				process.stdout.write(`${JSON.stringify(snapshot)}\n`);
				return 0;
			}
			output({ command: "fleet snapshot", result: snapshot });
			return 0;
		}
		if (!["fleet", "update", "tasks", "task", "agent", "metrics", "snapshot"].includes(command)) {
			return validationError(`Unknown fleet command: ${command}`, ["Run `fm fleet --help` for available commands."]);
		}
		if (command !== "fleet" || argv.length > 2) return validationError(`Unexpected argument: ${argv.slice(2).join(" ")}`, ["Run `fm fleet --help` for available commands."]);
		const snapshot = await collectSnapshot();
		output({ command: "fleet", result: snapshot });
		return 0;
	} catch (error) {
		return operationalError(`fleet ${command}`, error);
	}
}

export default {
	name: "fleet",
	describe: "Compact activation, health, attention, task, and agent overview.",
	run,
};
