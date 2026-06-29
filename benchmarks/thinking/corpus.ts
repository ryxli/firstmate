// Pure corpus loader + validator. Reads the fixed task set from a directory of
// JSON files and fails LOUD on any malformed task, so a broken corpus can never
// silently skew a verdict. Deterministic: tasks are returned sorted by id.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Oracle, Task } from "./types.ts";

// Validate one parsed oracle object, throwing a precise error. Returns it typed.
export function validateOracle(o: unknown, where: string): Oracle {
	if (o === null || typeof o !== "object") throw new Error(`${where}: oracle must be an object`);
	const rec = o as Record<string, unknown>;
	switch (rec.kind) {
		case "equals":
			if (typeof rec.expected !== "string") throw new Error(`${where}: equals.expected must be a string`);
			return { kind: "equals", expected: rec.expected, ci: rec.ci as boolean | undefined };
		case "contains":
			if (!Array.isArray(rec.needles) || rec.needles.length === 0 || !rec.needles.every((n) => typeof n === "string"))
				throw new Error(`${where}: contains.needles must be a non-empty string array`);
			return { kind: "contains", needles: rec.needles as string[], ci: rec.ci as boolean | undefined };
		case "regex":
			if (typeof rec.pattern !== "string") throw new Error(`${where}: regex.pattern must be a string`);
			try {
				new RegExp(rec.pattern, rec.flags as string | undefined);
			} catch (e) {
				throw new Error(`${where}: regex.pattern is invalid: ${(e as Error).message}`);
			}
			return { kind: "regex", pattern: rec.pattern, flags: rec.flags as string | undefined };
		case "numeric":
			if (typeof rec.expected !== "number" || Number.isNaN(rec.expected))
				throw new Error(`${where}: numeric.expected must be a number`);
			return { kind: "numeric", expected: rec.expected, tol: rec.tol as number | undefined };
		default:
			throw new Error(`${where}: unknown oracle kind ${JSON.stringify(rec.kind)}`);
	}
}

// Validate one parsed task object into a typed Task, throwing on any defect.
export function validateTask(parsed: unknown, where: string): Task {
	if (parsed === null || typeof parsed !== "object") throw new Error(`${where}: task must be an object`);
	const rec = parsed as Record<string, unknown>;
	for (const field of ["id", "title", "prompt"] as const) {
		if (typeof rec[field] !== "string" || (rec[field] as string).length === 0)
			throw new Error(`${where}: task.${field} must be a non-empty string`);
	}
	if (rec.context !== undefined && typeof rec.context !== "string") throw new Error(`${where}: task.context must be a string`);
	return {
		id: rec.id as string,
		title: rec.title as string,
		prompt: rec.prompt as string,
		context: rec.context as string | undefined,
		oracle: validateOracle(rec.oracle, `${where} oracle`),
	};
}

// Load and validate every *.json task under `dir`. Throws on a malformed task or
// a duplicate id. Returns tasks sorted by id (deterministic order).
export function loadCorpus(dir: string): Task[] {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort();
	if (files.length === 0) throw new Error(`corpus dir has no .json tasks: ${dir}`);
	const tasks: Task[] = [];
	const seen = new Set<string>();
	for (const f of files) {
		const path = join(dir, f);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (e) {
			throw new Error(`${f}: invalid JSON: ${(e as Error).message}`);
		}
		const task = validateTask(parsed, f);
		if (seen.has(task.id)) throw new Error(`${f}: duplicate task id ${task.id}`);
		seen.add(task.id);
		tasks.push(task);
	}
	tasks.sort((a, b) => a.id.localeCompare(b.id));
	return tasks;
}
