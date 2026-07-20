// OMP overlay helpers for home-skills: YAML parse, legacy merge, skills subtree.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertRealLocalFileOrAbsent, MateHomePathError } from "./mate-home-layout";
import { existsLstat, isSymlink } from "./path-links";

export class HomeSkillsConfigError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HomeSkillsConfigError";
	}
}

function fail(code: string, message: string): never {
	throw new HomeSkillsConfigError(code, message);
}

export function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function parseYamlObject(path: string, label: string): Record<string, unknown> {
	if (!existsLstat(path)) return {};
	assertRealLocalFileOrAbsent(path, label);
	try {
		const parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
		if (parsed === null || parsed === undefined) return {};
		if (typeof parsed !== "object" || Array.isArray(parsed)) fail("malformed-yaml", `${label}: root must be a mapping`);
		return parsed as Record<string, unknown>;
	} catch (err) {
		if (err instanceof HomeSkillsConfigError || err instanceof MateHomePathError) throw err;
		fail("malformed-yaml", `${label}: ${err}`);
	}
}

/** Merge nonconflicting legacy overlay settings into omp.yml (skills excluded). */
export function migrateLegacy(ompDoc: Record<string, unknown>, home: string): Record<string, unknown> {
	const out = { ...ompDoc };
	const legacyPaths = [join(home, "config", "omp-overlay.yml"), join(home, ".omp", "config.yml")];
	const union = new Map<string, { value: unknown; path: string }>();
	for (const path of legacyPaths) {
		if (!existsLstat(path) || isSymlink(path)) continue;
		const doc = parseYamlObject(path, path);
		for (const [key, value] of Object.entries(doc)) {
			if (key === "skills") continue;
			const prev = union.get(key);
			if (prev && !deepEqual(prev.value, value)) {
				fail("legacy-conflict", `conflicting legacy setting '${key}' between ${prev.path} and ${path}`);
			}
			union.set(key, { value, path });
		}
	}
	for (const [key, { value, path }] of union) {
		if (!(key in out)) out[key] = value;
		else if (!deepEqual(out[key], value)) {
			fail("legacy-conflict", `conflicting legacy setting '${key}' between config/omp.yml and ${path}`);
		}
	}
	return out;
}

export function desiredSkillsSubtree(names: string[]): Record<string, unknown> {
	const sorted = [...names].sort();
	return {
		enabled: sorted.length > 0,
		enableCodexUser: false,
		enableClaudeUser: false,
		enableClaudeProject: false,
		enablePiUser: false,
		enablePiProject: true,
		enableAgentsUser: false,
		enableAgentsProject: false,
		includeSkills: sorted,
	};
}
