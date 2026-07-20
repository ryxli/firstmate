// fm verb: fleet - overview plus persistent-mate lifecycle (stop/clean/check).
// Mutating commands (stop/clean/update) require controller/firstmate home.
// Read-only commands discover the controller via resolveFleetControllerHome.

import {
	actionableFleetView,
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
import { requireControllerMutationAuthority, resolveFleetControllerHome } from "../lib/fleet-authority";
import { fleetCheck, fleetClean, fleetStop } from "../lib/fleet-lifecycle";
import { runFleetView } from "../lib/fleet-view";

const MUTATING = new Set(["stop", "clean", "update"]);

function refuseAuth(reason: string): number {
	process.stderr.write(`error: fleet authority: ${reason}\n`);
	process.stdout.write("result=failed reason=authority\n");
	return 1;
}

async function run(argv: string[]): Promise<number> {
	if (argv.length === 1 || (argv.length === 2 && argv[1] === "--full")) {
		const auth = resolveFleetControllerHome();
		if (!auth.ok) return refuseAuth(auth.reason);
		const saved = process.env.FM_HOME;
		process.env.FM_HOME = auth.controllerHome;
		try {
			const snapshot = await collectSnapshot(undefined, auth.controllerHome);
			const full = argv[1] === "--full";
			output({ command: "fleet", result: full ? snapshot : actionableFleetView(snapshot) });
			return 0;
		} catch (error) {
			return operationalError("fleet", error);
		} finally {
			if (saved !== undefined) process.env.FM_HOME = saved;
			else delete process.env.FM_HOME;
		}
	}
	if (argv[1] === "--help" || argv[1] === "-h") {
		output(commandHelp("fm fleet"));
		return 0;
	}
	// Removed transitional alias: use `fm fleet check`.
	if (argv[1] === "--check") {
		return validationError("Unknown flag --check", ["Use `fm fleet check` (no alias)."]);
	}

	const command = argv[1];
	if (!command) {
		return validationError("Missing fleet command", ["Run `fm fleet --help` for available commands."]);
	}

	if (MUTATING.has(command)) {
		const auth = requireControllerMutationAuthority();
		if (!auth.ok) return refuseAuth(auth.reason);
		const saved = process.env.FM_HOME;
		process.env.FM_HOME = auth.controllerHome;
		try {
			if (command === "stop") {
				const sel = argv[2];
				if (!sel || argv.length !== 3) {
					return validationError("Usage: fm fleet stop <mate|--all>", ["Provide one mate id or --all."]);
				}
				return await fleetStop(auth.controllerHome, sel);
			}
			if (command === "clean") {
				if (argv.length !== 2) return validationError("Usage: fm fleet clean", ["No flags; resting only when active scope is empty."]);
				return await fleetClean(auth.controllerHome);
			}
			if (argv.length === 3 && (argv[2] === "--help" || argv[2] === "-h")) {
				output({ command: "fleet update", usage: "fm fleet update", description: "Selectively fast-forward registered homes and prove live-session reloads." });
				return 0;
			}
			if (argv.length > 2) return validationError(`Unexpected argument: ${argv.slice(2).join(" ")}`, ["Use `fm fleet update` without arguments."]);
			const update = await updateFleet();
			output({ command: "fleet update", result: update });
			if (update.results.some(target => target.status === "failed")) return 1;
			return update.results.some(target => target.status === "pending") ? 1 : 0;
		} catch (error) {
			return operationalError(`fleet ${command}`, error);
		} finally {
			if (saved !== undefined) process.env.FM_HOME = saved;
			else delete process.env.FM_HOME;
		}
	}

	const readAuth = resolveFleetControllerHome();
	if (!readAuth.ok) return refuseAuth(readAuth.reason);
	const saved = process.env.FM_HOME;
	process.env.FM_HOME = readAuth.controllerHome;

	try {
		if (command === "check") {
			if (argv.length !== 2) return validationError("Usage: fm fleet check", ["No additional arguments."]);
			return await fleetCheck(readAuth.controllerHome);
		}
		if (command === "view") return runFleetView(argv.slice(1));
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
			const snapshot = await collectSnapshot(undefined, readAuth.controllerHome);
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
			const snapshot = await collectSnapshot(undefined, readAuth.controllerHome);
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
			const snapshot = await collectSnapshot(new Date().toISOString(), readAuth.controllerHome, { includeMetrics: true });
			output({ command: "fleet metrics", result: snapshot.metrics ?? null });
			return 0;
		}
		if (command === "snapshot") {
			const rest = argv.slice(2);
			let asJson = false;
			let includeMetrics = false;
			let home: string | undefined;
			let statsFile: string | undefined;
			let startingMain = false;
			for (let index = 0; index < rest.length; index += 1) {
				const arg = rest[index];
				if (arg === "--json") asJson = true;
				else if (arg === "--metrics") includeMetrics = true;
				else if (arg === "--starting-main") startingMain = true;
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
					output({ command: "fleet snapshot", usage: "fm fleet snapshot [--json] [--metrics] [--starting-main] [--home <path>] [--stats-file <path>]", description: "Raw FleetSnapshot for visual consumers; --starting-main treats the launching firstmate pane as OMP." });
					return 0;
				} else {
					return validationError(`Unexpected argument: ${arg}`, ["Use `fm fleet snapshot [--json] [--metrics] [--starting-main] [--home <path>] [--stats-file <path>]`."]);
				}
			}
			const snapshot = await collectSnapshot(new Date().toISOString(), home ?? readAuth.controllerHome, { includeMetrics, statsFile, startingMain });
			if (asJson) {
				process.stdout.write(`${JSON.stringify(snapshot)}\n`);
				return 0;
			}
			output({ command: "fleet snapshot", result: snapshot });
			return 0;
		}
		return validationError(`Unknown fleet command: ${command}`, ["Run `fm fleet --help` for available commands."]);
	} catch (error) {
		return operationalError(`fleet ${command}`, error);
	} finally {
		if (saved !== undefined) process.env.FM_HOME = saved;
		else delete process.env.FM_HOME;
	}
}

export default {
	name: "fleet",
	describe: "Show fleet overview and manage persistent-mate lifecycle.",
	surface: "captain",
	run,
};
