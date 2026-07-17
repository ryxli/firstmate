import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CANONICAL_MISE_TOML = `# Mate home environment (local). Puts the shared fm CLI (symlinked sbin/) and
# this home's personal bin/ on PATH when entering it. Run \`mise trust\` once.
[env]
_.path = ["{{config_root}}/sbin", "{{config_root}}/bin"]
`;

const MISE_CONFIG_NAMES = [".mise.toml", "mise.toml"] as const;
const REQUIRED_PATH_ENTRIES = ["{{config_root}}/sbin", "{{config_root}}/bin"] as const;

export interface MateMiseTomlResult {
	status: string;
	path: string;
	created: boolean;
}

function canonicalPathEntriesPresent(text: string): boolean {
	return REQUIRED_PATH_ENTRIES.every(entry => text.includes(entry));
}

export function ensureMateMiseToml(home: string, write: boolean): MateMiseTomlResult {
	for (const name of MISE_CONFIG_NAMES) {
		const path = join(home, name);
		let st;
		try {
			st = lstatSync(path);
		} catch {
			continue;
		}
		if (st.isSymbolicLink()) return { status: "blocked:symlink", path, created: false };
		if (!st.isFile()) return { status: "blocked:not-file", path, created: false };
		const text = readFileSync(path, "utf8");
		return {
			status: canonicalPathEntriesPresent(text) ? "ok" : "drift-missing-path",
			path,
			created: false,
		};
	}

	const path = join(home, ".mise.toml");
	if (!write) return { status: "missing", path, created: false };
	try {
		writeFileSync(path, CANONICAL_MISE_TOML, { flag: "wx" });
	} catch {
		return { status: "blocked:repair-failed", path, created: false };
	}
	return { status: "repaired", path, created: true };
}
