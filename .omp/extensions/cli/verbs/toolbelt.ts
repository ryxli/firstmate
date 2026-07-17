// fm verb: toolbelt - scan the discovered TypeScript verb modules and print
// "<name><TAB><description>" for each, sorted by name.
//
// The migrated CLI has one implementation surface: sbin/fm discovers
// .omp/extensions/cli/verbs/*.ts. Listing deleted sbin wrappers would report a
// stale toolbelt, so this command mirrors dispatcher discovery and uses each
// verb module's exported description.

import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERBS_DIR = fileURLToPath(new URL("./", import.meta.url));

interface Verb {
	name: string;
	describe: string;
}

async function loadVerb(entry: string): Promise<Verb | null> {
	try {
		const mod = await import(pathToFileURL(`${VERBS_DIR}${entry}`).href);
		const verb = mod.default;
		if (verb && typeof verb.name === "string" && typeof verb.describe === "string") {
			return { name: verb.name, describe: verb.describe || "(no description)" };
		}
	} catch {
		// A broken verb should not make toolbelt unusable; dispatcher will report
		// the import failure when that verb is invoked.
	}
	return null;
}

async function run(_argv: string[]): Promise<number> {
	let entries: string[];
	try {
		entries = readdirSync(VERBS_DIR).filter(name => name.endsWith(".ts")).sort();
	} catch {
		entries = [];
	}

	const verbs = (await Promise.all(entries.map(loadVerb))).filter((verb): verb is Verb => verb !== null);
	const lines = verbs.map(verb => `${verb.name}\t${verb.describe}`).sort();

	for (const line of lines) {
		process.stdout.write(`${line}\n`);
	}
	return 0;
}

export default {
	name: "toolbelt",
	describe: "List every discovered fm verb with its description.",
	run,
};
