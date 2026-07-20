// Shared path and symlink helpers for mate-home link management.
// Extracted from home-link semantics: normalize without following a leaf symlink,
// compare link targets after parent realpath normalization.

import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

export function existsLstat(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

export function existsFollow(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

export function isDirectoryFollow(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function isFileFollow(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export function isRealDirectory(path: string): boolean {
	try {
		const st = lstatSync(path);
		return st.isDirectory() && !st.isSymbolicLink();
	} catch {
		return false;
	}
}

export function isRealFile(path: string): boolean {
	try {
		const st = lstatSync(path);
		return st.isFile() && !st.isSymbolicLink();
	} catch {
		return false;
	}
}

export function cdPhysical(dir: string): string {
	const st = statSync(dir);
	if (!st.isDirectory()) throw new Error(`not a directory: ${dir}`);
	return realpathSync(dir);
}

/** Normalize path by realpath'ing existing parents; leaf is not dereferenced. */
export function normalizePath(path: string): string | null {
	try {
		return `${cdPhysical(dirname(path))}/${basename(path)}`;
	} catch {
		return null;
	}
}

export function normalizeExistingDir(path: string): string | null {
	try {
		const st = statSync(path);
		if (!st.isDirectory()) return null;
		return realpathSync(path);
	} catch {
		return null;
	}
}

export function resolveLinkTarget(link: string): string | null {
	let target: string;
	try {
		target = readlinkSync(link);
	} catch {
		return null;
	}
	if (target.startsWith("/")) return normalizePath(target);
	return normalizePath(join(dirname(link), target));
}

/** Absolute form of a symlink's raw target (relative targets resolved against link dir). */
export function rawLinkTarget(link: string): string | null {
	try {
		const target = readlinkSync(link);
		return target.startsWith("/") ? target : resolve(dirname(link), target);
	} catch {
		return null;
	}
}

export function linkPointsTo(link: string, expected: string): boolean {
	if (!isSymlink(link)) return false;
	const actual = resolveLinkTarget(link);
	if (actual === null) return false;
	const expectedReal = normalizePath(expected);
	if (expectedReal === null) return false;
	return actual === expectedReal;
}
