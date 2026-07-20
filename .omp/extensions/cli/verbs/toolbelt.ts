// fm verb: toolbelt - list every discovered fm verb with its description.
// Uses the shared loadVerbs() registry inside run() only (no module-init load)
// to avoid a loadVerbs ↔ toolbelt initialization cycle.

async function run(_argv: string[]): Promise<number> {
	const { loadVerbs } = await import("../lib/verb-registry");
	const verbs = await loadVerbs();
	const lines = verbs.map(verb => `${verb.name}\t${verb.describe}`).sort();
	for (const line of lines) {
		process.stdout.write(`${line}\n`);
	}
	return 0;
}

export default {
	name: "toolbelt",
	describe: "List every discovered fm verb.",
	surface: "captain" as const,
	run,
};
