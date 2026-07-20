// Legacy fm help contract, shared by the root dispatcher (in legacy mode) and the
// fleet/home verb modules so `fm`, `fm fleet --help`, and `fm home --help`
// keep emitting byte-identical TOON to the pre-split monolith.

export function commandHelp(command = "fm", options: { secondmate?: boolean } = {}): Record<string, unknown> {
	const home = command === "fm home";
	const root = command === "fm";
	const fleetCommands = [
		{ command: "fleet", description: "Compact activation, health, attention, task, and agent overview (read-only)." },
		{ command: "fleet stop <mate|--all>", description: "Gracefully exit registered persistent secondmate OMP sessions (controller only)." },
		{ command: "fleet clean", description: "Resting cleanup when active scope and OMP subagents are clear (controller only)." },
		{ command: "fleet check", description: "Read-only resting health gate including omp-subagents inventory." },
		{ command: "fleet update", description: "Selectively fast-forward registered homes and prove live-session reloads (controller only)." },
		{ command: "fleet tasks", description: "Ranked task list, optionally filtered by state." },
		{ command: "fleet task get <id>", description: "Full task record; bare ids must be unique." },
		{ command: "fleet agent get <id>", description: "Full agent record; bare ids must be unique." },
		{ command: "fleet metrics", description: "Optional cost and productivity metrics." },
		{ command: "fleet snapshot", description: "Raw FleetSnapshot JSON for visual consumers (--json), optionally with metrics." },
		{ command: "fleet view", description: "Read-only visual fleet dashboard rendered from the shared FleetSnapshot collector." },
	];
	const fleetUsage =
		"fleet [check|stop <mate|--all>|clean|update|tasks [--state <in-flight|queued|done>]|task get <id>|agent get <id>|metrics|snapshot [--json] [--metrics] [--home <path>]|view [--no-open]]";
	return {
		command,
		usage: home
			? "fm home <check|repair> <mate|--all> | home skills <sync|check|reconcile> …"
			: root
				? options.secondmate
					? `fm ${fleetUsage}`
					: `fm ${fleetUsage} | home <check|repair> <mate|--all> | home skills …`
				: `fm ${fleetUsage}`,
		commands: home
			? [
				{ command: "home check <mate|--all>", description: "Check mate-home layout and shared-code links for one registered mate or every registered mate." },
				{ command: "home repair <mate|--all>", description: "Repair mate-home layout and shared-code links for one registered mate or every registered mate." },
				{ command: "home skills sync <id|path>", description: "Reconcile isolated OMP skills for one specialist home." },
				{ command: "home skills check <id|path>", description: "Validate specialist skill isolation without mutation." },
				{ command: "home skills reconcile <id|--all>", description: "Materialize shared profiles, sync, validate, and run harness-gated OMP smoke." },
			]
			: root
				? options.secondmate
					? fleetCommands
					: [...fleetCommands, { command: "home", description: "Mate-home layout, links, and specialist skill isolation." }]
				: fleetCommands,
	};
}
