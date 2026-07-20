// Ownership-safe managed symlink helpers for reconciler-owned links.
// A receipt owns a link only when the current raw symlink target normalizes
// exactly to the recorded canonical target (broken/retargeted links fail closed).

import { renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isSymlink, normalizePath, rawLinkTarget } from "./path-links";

export function atomicWriteFile(path: string, contents: string, mode = 0o644): void {
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, contents, { mode });
	renameSync(tmp, path);
}

/** True when link is a symlink whose raw target normalizes to recordedTarget. */
export function linkOwnedByTarget(linkPath: string, recordedTarget: string): boolean {
	if (!isSymlink(linkPath)) return false;
	const raw = rawLinkTarget(linkPath);
	if (raw === null) return false;
	const actual = normalizePath(raw);
	const expected = normalizePath(recordedTarget);
	if (actual === null || expected === null) return false;
	return actual === expected;
}

export type ManagedLinkAction = "ok" | "create" | "refresh" | "remove";

/**
 * Classify a managed symlink relative to a desired target and optional receipt.
 * Foreign / retargeted links throw via the provided fail callback rather than
 * mutating.
 *
 * Convergence: a symlink that already points exactly at the desired canonical
 * target is `ok` even when the receipt is missing or stale. That recovers from
 * partial sync failure (links written, receipt/config not) without a rollback
 * framework. Receipt ownership still gates remove/refresh of non-desired links.
 */
export function classifyManagedLink(opts: {
	linkPath: string;
	desiredTarget: string | null; // null => should not exist as managed
	recordedTarget: string | undefined;
	exists: boolean;
	fail: (code: string, message: string) => never;
}): ManagedLinkAction {
	const { linkPath, desiredTarget, recordedTarget, exists, fail } = opts;
	if (!exists) {
		return desiredTarget ? "create" : "ok";
	}
	if (!isSymlink(linkPath)) {
		if (desiredTarget) fail("local-collision", `managed link collides with real local material at ${linkPath}`);
		return "ok"; // real local material for a non-desired name is unrestricted
	}
	if (desiredTarget && linkOwnedByTarget(linkPath, desiredTarget)) {
		return "ok";
	}
	const owned = recordedTarget ? linkOwnedByTarget(linkPath, recordedTarget) : false;
	if (desiredTarget) {
		if (!recordedTarget) fail("foreign-link", `unrecorded symlink at ${linkPath}; refuse to overwrite`);
		if (!owned) fail("retargeted-link", `managed link no longer points at its recorded target: ${linkPath}`);
		return "refresh";
	}
	if (owned) return "remove";
	if (recordedTarget) fail("retargeted-link", `stale recorded link is no longer owned: ${linkPath}`);
	fail("foreign-link", `foreign symlink is not receipt-owned: ${linkPath}`);
}

/** Create or replace a symlink after ownership was preflighted. */
export function writeManagedSymlink(linkPath: string, target: string): void {
	if (isSymlink(linkPath)) rmSync(linkPath, { force: true });
	symlinkSync(target, linkPath);
}

export function removeManagedSymlink(linkPath: string): void {
	rmSync(linkPath, { force: true });
}
