// Cap-facing help: opinionated workflow guide for root `fm --help`,
// nested fleet/home/tasks documents, and central top-level verb help rendering.
// Full verb inventory remains `fm toolbelt` (discovery-driven).
//
// Invariant: emitTopLevelVerbHelp renders only passive HelpSpec / pure builders.
// It must never call verb.run or other operational verb code.

import { output } from "./common";

type HelpCommand = { command: string; description: string };

function cmd(command: string, description: string): HelpCommand {
	return { command, description };
}

const SEND_DESCRIBE =
	"Inject operator-style input into a visible pane or invoke narrow pane controls. Not agent messaging.";

const PEER_BUS_NOTE =
	"Normal agent communication uses the peer bus. `fm send` operates the visible operator-input surface.";

export type HelpSpec =
	| {
			format?: "toon";
			usage: string;
			description?: string;
			commands?: HelpCommand[];
			notes?: string[];
			help?: string[];
	  }
	| {
			format: "text";
			body: string;
	  }
	| {
			format: "document";
			document: "fm fleet" | "fm home" | "fm tasks";
	  };

export type HelpableVerb = {
	name: string;
	describe: string;
	usage?: string;
	help?: HelpSpec;
};

const TASKS_SUBCOMMANDS = [
	"add",
	"list",
	"show",
	"start",
	"done",
	"reopen",
	"update",
	"block",
	"unblock",
	"hold",
	"unhold",
	"ready",
	"mv",
	"prune",
	"render",
	"fleet",
	"artifact",
] as const;

/** Pure tasks top-level help; `invokedCommand` is the registry name (`tasks` or alias `task`). */
export function tasksHelpDocument(invokedCommand: string): Record<string, unknown> {
	return {
		command: invokedCommand,
		usage: `fm ${invokedCommand} [--fleet] [add|list|show|start|done|reopen|update|block|unblock|hold|unhold|ready|mv|prune|render|fleet|artifact]`,
		description: "Manage the backlog and live fleet tasks.",
		commands: TASKS_SUBCOMMANDS.map(name => ({
			command: name,
			description: `See \`fm ${invokedCommand} ${name} --help\`.`,
		})),
		notes:
			invokedCommand === "task"
				? ["`task` is an alias of `tasks`; subcommands are identical."]
				: undefined,
	};
}

export function commandHelp(command = "fm"): Record<string, unknown> {
	if (command === "fm" || command === "fm --help") {
		return {
			command: "fm",
			usage: "fm <command> …",
			workflow: [
				cmd("fm spawn …", "Dispatch a worker."),
				cmd("fm peek <mate>", "Inspect current progress."),
				cmd("fm send <mate> …", SEND_DESCRIBE),
				cmd("fm accept <task>", "Approve the candidate."),
				cmd("fm finish <task>", "Integrate and clean up."),
			],
			groups: [
				{
					name: "Dispatch",
					commands: [
						cmd("brief", "Scaffold a crewmate brief or secondmate charter."),
						cmd("spawn", "Spawn a crewmate or secondmate."),
						cmd("tasks", "Manage the backlog and live fleet tasks."),
					],
				},
				{
					name: "Supervise",
					commands: [
						cmd("panes", "List herdr panes and agent status."),
						cmd("peek", "Show a bounded tail of a mate's pane output."),
						cmd("send", SEND_DESCRIBE),
						cmd("revise", "Record a pre-accept correction; keep the workspace open."),
					],
				},
				{
					name: "Complete",
					commands: [
						cmd("accept", "Approve a task's candidate and queue it for integration."),
						cmd("finish", "Integrate, land, and clean up an accepted task."),
						cmd("teardown", "Remove finished worktree/pane state, or retire a secondmate home."),
						cmd("promote", "Promote a scout task to ship."),
						cmd("artifact", "Show a task's durable artifact record."),
					],
				},
				{
					name: "Fleet",
					commands: [
						cmd("fleet", "Show fleet overview and manage persistent-mate lifecycle."),
						cmd("health", "Run a quick local fleet health check."),
						cmd("freeze", "Toggle dispatch-freeze and per-mate focus locks."),
						cmd("afk", "Enter, exit, or report away-mode."),
					],
				},
				{
					name: "Setup",
					commands: [
						cmd("start", "Launch a fresh firstmate OMP session."),
						cmd("home", "Check or repair mate-home layout and skills."),
					],
				},
			],
			notes: [
				"`fm start` launches this firstmate session; `fm tasks start <id>` marks a backlog item in-flight.",
				"`fm health` is a quick local pulse; `fm fleet check` is the resting gate (includes omp-subagents).",
				"`fm finish` integrates and lands an accepted task; `fm teardown` removes worktree/pane after work is done (or retires a secondmate home).",
				"`fm home` checks/repairs mate homes; `fm home seed` provisions a new secondmate home.",
				PEER_BUS_NOTE,
			],
			help: [
				"More: `fm tasks --help`, `fm fleet --help`, `fm home --help`.",
				"Full inventory: `fm toolbelt`.",
			],
		};
	}

	if (command === "fm home") {
		return {
			command,
			usage: "fm home <check|repair> <mate|--all> | fm home skills … | fm home seed …",
			commands: [
				cmd("home check <mate|--all>", "Check mate-home layout and shared-code links."),
				cmd("home repair <mate|--all>", "Repair mate-home layout and shared-code links."),
				cmd("home skills sync <id|path>", "Reconcile isolated OMP skills for one specialist home."),
				cmd("home skills check <id|path>", "Validate specialist skill isolation without mutation."),
				cmd("home skills reconcile <id|--all>", "Materialize shared profiles, sync, validate, and run harness-gated OMP smoke."),
				cmd("home seed <id> <home|-> <project>…", "Provision and route a new secondmate home."),
			],
			notes: [
				"`fm home check|repair` maintains existing homes; `fm home seed` creates and registers a new secondmate home.",
				"`fm home-seed` remains as a compatibility alias for `fm home seed`.",
			],
		};
	}

	if (command === "fm fleet") {
		return {
			command,
			usage: "fm fleet | fm fleet <check|stop|clean|update|tasks|task get|agent get|metrics|snapshot|view> …",
			commands: [
				cmd("fleet", "Show a read-only overview (activation, health, attention, tasks, agents)."),
				cmd("fleet check", "Run the resting health gate, including omp-subagents inventory."),
				cmd("fleet stop <mate|--all>", "Gracefully exit registered persistent secondmate OMP sessions (controller only)."),
				cmd("fleet clean", "Run resting cleanup when active scope and OMP subagents are clear (controller only)."),
				cmd("fleet update", "Fast-forward registered homes and prove live-session reloads (controller only)."),
				cmd("fleet tasks [--state <in-flight|queued|done>]", "List ranked tasks, optionally filtered by state."),
				cmd("fleet task get <id>", "Show a full task record; bare ids must be unique."),
				cmd("fleet agent get <id>", "Show a full agent record; bare ids must be unique."),
				cmd("fleet metrics", "Show optional cost and productivity metrics."),
				cmd("fleet snapshot [--json] [--metrics] [--home <path>]", "Emit raw FleetSnapshot for visual consumers."),
				cmd("fleet view [--no-open]", "Open the read-only visual fleet dashboard."),
			],
			notes: [
				"`fm health` is a quick local pulse; prefer `fm fleet check` when deciding whether the fleet is resting-clean.",
			],
		};
	}

	if (command === "fm tasks") {
		return tasksHelpDocument("tasks");
	}

	return {
		command,
		usage: "fm <command> …",
		commands: [],
		help: ["Run `fm --help` for the Cap-facing workflow guide."],
	};
}

/** Render top-level verb help to stdout only. Never invokes operational verb code. */
export function emitTopLevelVerbHelp(verb: HelpableVerb): number {
	const spec = verb.help;
	if (!spec) {
		output({
			command: verb.name,
			description: verb.describe,
			usage: verb.usage ?? `fm ${verb.name} …`,
		});
		return 0;
	}
	if (spec.format === "text") {
		const body = spec.body.endsWith("\n") ? spec.body : `${spec.body}\n`;
		process.stdout.write(body);
		return 0;
	}
	if (spec.format === "document") {
		if (spec.document === "fm tasks") {
			output(tasksHelpDocument(verb.name));
			return 0;
		}
		output(commandHelp(spec.document));
		return 0;
	}
	const doc: Record<string, unknown> = {
		command: verb.name,
		usage: spec.usage,
		description: spec.description ?? verb.describe,
	};
	if (spec.commands?.length) doc.commands = spec.commands;
	if (spec.notes?.length) doc.notes = spec.notes;
	if (spec.help?.length) doc.help = spec.help;
	output(doc);
	return 0;
}

export const SEND_HELP_DESCRIBE = SEND_DESCRIBE;
export const SEND_PEER_BUS_NOTE = PEER_BUS_NOTE;
