// Shared fm verb discovery. sbin/fm, toolbelt (inside run), and contract tests
// all import loadVerbs from here - there is no second registry implementation.

import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HelpSpec } from "../help";

export type { HelpSpec };

export interface Verb {
	name: string;
	describe: string;
	surface?: "captain" | "internal";
	/** Optional one-line usage for default top-level help. */
	usage?: string;
	/** Passive help document rendered by the dispatcher; never operational code. */
	help?: HelpSpec;
	run(argv: string[]): number | Promise<number>;
}

const VERBS_DIR = fileURLToPath(new URL("../verbs/", import.meta.url));

export async function loadVerbs(): Promise<Verb[]> {
	let entries: string[] = [];
	try {
		entries = readdirSync(VERBS_DIR).filter(name => name.endsWith(".ts")).sort();
	} catch {
		entries = [];
	}
	const verbs: Verb[] = [];
	for (const entry of entries) {
		const mod = await import(pathToFileURL(`${VERBS_DIR}${entry}`).href);
		const verb = mod.default;
		if (verb && typeof verb.name === "string" && typeof verb.describe === "string" && typeof verb.run === "function") {
			verbs.push(verb as Verb);
		}
	}
	return verbs.sort((a, b) => a.name.localeCompare(b.name));
}
