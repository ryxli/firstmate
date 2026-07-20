// Canonical mate-home local directory contract.
// One typed source of truth for required roots and data/ children.
// Shared-code links (AGENTS.md, sbin, .agents, .omp extensions) stay elsewhere.

import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

/** Required top-level local directories in every mate home. */
export const MATE_HOME_ROOT_DIRS = [
	"bin",
	"config",
	"state",
	"data",
	"projects",
	"worktrees",
	"work",
	"tmp",
	".lavish",
] as const;

/** Required children under `data/`. */
export const MATE_HOME_DATA_CHILD_DIRS = ["knowledge", "reports", "evidence", "archive"] as const;

export type MateHomeRootDir = (typeof MATE_HOME_ROOT_DIRS)[number];
export type MateHomeDataChildDir = (typeof MATE_HOME_DATA_CHILD_DIRS)[number];

export type MateHomeLayoutIssueCode =
	| "missing"
	| "conflicting-file"
	| "unsafe-symlink"
	| "not-directory"
	| "escapes-home";

export interface MateHomeLayoutIssue {
	rel: string;
	code: MateHomeLayoutIssueCode;
	detail: string;
}

export interface MateHomeLayoutCheck {
	ok: boolean;
	issues: MateHomeLayoutIssue[];
}

export interface MateHomeLayoutRepair {
	ok: boolean;
	created: string[];
	issues: MateHomeLayoutIssue[];
}

/** Every required relative path exactly once (roots then data children). */
export function mateHomeRequiredRelPaths(): string[] {
	return [...MATE_HOME_ROOT_DIRS, ...MATE_HOME_DATA_CHILD_DIRS.map(name => `data/${name}`)];
}

function pathIsDescendant(root: string, path: string): boolean {
	if (root === path) return false;
	return path.startsWith(`${root}/`);
}

function homeReal(home: string): string {
	return realpathSync(home);
}

function inspectAnyDir(home: string, rel: string): MateHomeLayoutIssue | null {
	const absHome = homeReal(home);
	const path = join(home, rel);
	try {
		const lst = lstatSync(path);
		if (lst.isSymbolicLink()) {
			let followed;
			try {
				followed = statSync(path);
			} catch {
				return { rel, code: "unsafe-symlink", detail: `${rel} is a broken or unreadable symlink` };
			}
			if (!followed.isDirectory()) return { rel, code: "unsafe-symlink", detail: `${rel} symlink does not resolve to a directory` };
			const real = realpathSync(path);
			if (real !== absHome && !pathIsDescendant(absHome, real)) {
				return { rel, code: "unsafe-symlink", detail: `${rel} symlink escapes the home` };
			}
			return null;
		}
		if (lst.isFile()) return { rel, code: "conflicting-file", detail: `${rel} is a regular file, not a directory` };
		if (!lst.isDirectory()) return { rel, code: "not-directory", detail: `${rel} exists but is not a directory` };
		const real = realpathSync(path);
		if (real !== absHome && !pathIsDescendant(absHome, real)) {
			return { rel, code: "escapes-home", detail: `${rel} resolves outside the home` };
		}
		return null;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		if (code === "ENOTDIR") return { rel, code: "conflicting-file", detail: `${rel} is a regular file, not a directory` };
		return { rel, code: "not-directory", detail: `${rel} exists but cannot be inspected as a directory` };
	}
}

function inspectRequiredDir(home: string, rel: string): MateHomeLayoutIssue | null {
	const path = join(home, rel);
	try {
		lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { rel, code: "missing", detail: `${rel} is missing` };
		}
		throw error;
	}
	return inspectAnyDir(home, rel);
}

/** Report every missing/conflicting required directory. Never mutates. */
export function checkMateHomeLayout(home: string): MateHomeLayoutCheck {
	if (!existsSync(home) || !statSync(home).isDirectory()) {
		return {
			ok: false,
			issues: [{ rel: ".", code: "missing", detail: `home is missing or not a directory: ${home}` }],
		};
	}
	const issues: MateHomeLayoutIssue[] = [];
	for (const rel of mateHomeRequiredRelPaths()) {
		const issue = inspectRequiredDir(home, rel);
		if (issue) issues.push(issue);
	}
	return { ok: issues.length === 0, issues };
}

/**
 * Create missing required directories only.
 * Never deletes, relocates, overwrites, or empties existing content.
 * Conflicting files and unsafe symlinks block repair without modification.
 */
export function repairMateHomeLayout(home: string): MateHomeLayoutRepair {
	if (!existsSync(home)) {
		mkdirSync(home, { recursive: true });
	} else if (!statSync(home).isDirectory()) {
		return {
			ok: false,
			created: [],
			issues: [{ rel: ".", code: "conflicting-file", detail: `home path is not a directory: ${home}` }],
		};
	}

	const missingRoots: string[] = [];
	const issues: MateHomeLayoutIssue[] = [];
	for (const rel of MATE_HOME_ROOT_DIRS) {
		const issue = inspectRequiredDir(home, rel);
		if (issue?.code === "missing") missingRoots.push(rel);
		else if (issue) issues.push(issue);
	}
	if (issues.length > 0) {
		return { ok: false, created: [], issues };
	}
	const missingChildren: string[] = [];
	for (const child of MATE_HOME_DATA_CHILD_DIRS) {
		const rel = `data/${child}`;
		const issue = inspectRequiredDir(home, rel);
		if (issue?.code === "missing") missingChildren.push(rel);
		else if (issue) issues.push(issue);
	}
	if (issues.length > 0) {
		return { ok: false, created: [], issues };
	}
	const missing = [...missingRoots, ...missingChildren];
	for (const rel of missing) {
		mkdirSync(join(home, rel), { recursive: true });
	}
	return { ok: true, created: missing, issues: [] };
}

/** Provisioning helper: create the complete required structure (idempotent). */
export function ensureMateHomeLayout(home: string): MateHomeLayoutRepair {
	return repairMateHomeLayout(home);
}
