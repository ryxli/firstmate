// Legacy fm help contract, shared by the root dispatcher (in legacy mode) and the
// fleet/home verb modules so `fm`, `fm fleet --help`, and `fm home --help`
// keep emitting byte-identical TOON to the pre-split monolith.

export function commandHelp(command = "fm"): Record<string, unknown> {
	const home = command === "fm home";
	const root = command === "fm";
	const fleetCommands = [
		{ command: "fleet", description: "Compact activation, health, attention, task, and agent overview." },
		{ command: "fleet update", description: "Selectively fast-forward registered homes and prove live-session reloads." },
		{ command: "fleet tasks", description: "Ranked task list, optionally filtered by state." },
		{ command: "fleet task get <id>", description: "Full task record; bare ids must be unique." },
		{ command: "fleet agent get <id>", description: "Full agent record; bare ids must be unique." },
		{ command: "fleet metrics", description: "Optional cost and productivity metrics." },
		{ command: "fleet snapshot", description: "Raw FleetSnapshot JSON for visual consumers (--json), optionally with metrics." },
	];
	return {
		command,
		usage: home ? "fm home <check|repair> <mate|--all>" : root ? "fm fleet [--check] [update|tasks [--state <in-flight|queued|done>]|task get <id>|agent get <id>|metrics|snapshot [--json] [--metrics] [--home <path>]] | home <check|repair> <mate|--all>" : "fm fleet [--check] [update|tasks [--state <in-flight|queued|done>]|task get <id>|agent get <id>|metrics|snapshot [--json] [--metrics] [--home <path>]]",
		commands: home
			? [
				{ command: "home check <mate|--all>", description: "Check shared-code links for one registered mate or every registered mate." },
				{ command: "home repair <mate|--all>", description: "Repair shared-code links for one registered mate or every registered mate." },
			]
			: root
				? [...fleetCommands, { command: "home", description: "Check or repair shared-code links for registered mates." }]
				: fleetCommands,
	};
}
