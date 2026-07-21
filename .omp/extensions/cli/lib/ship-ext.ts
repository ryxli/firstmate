// fm lib: ship-ext - shared ship omp-extension symlink logic.
// Ported behavior-preserving from sbin/fm-ship-ext-lib.sh.
//
// Real caller (grepped): fm home-seed calls fm_link_ship_extensions with
// FM_SHIP_EXT_VERBOSE=0 and FM_SHIP_EXT_TRACK_FILE set to its transactional
// rollback file. (The `fm link-ship-ext` CLI verb inlines its own,
// deliberately simpler copy of this logic that always prints and never
// tracks - a different use case, not a call to this bash function - so this
// port stays faithful to the fm home-seed caller's env-gated semantics.)

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, rmdirSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";

export interface ShipExtOptions {
	/** Mirrors FM_SHIP_EXT_VERBOSE=1: print a per-entry line to stdout. */
	verbose?: boolean;
	/** Mirrors FM_SHIP_EXT_TRACK_FILE: append every created/refreshed link path, for transactional rollback. */
	trackFile?: string;
}

export interface ShipExtResult {
	srcMissing: boolean;
	dstExisted: boolean;
	changed: number;
	skipped: number;
	noop: number;
}

function isDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

// linkShipExtensions(home, extSrc, opts?): install a symlink per entry under
// extSrc (the canonical .omp/extensions/ dir) into <home>/.omp/extensions/<name>.
// Idempotent: a correct symlink is a no-op, a stale/wrong symlink is
// refreshed, and a real file the home provides itself is left untouched.
// Callers own their own canonical-path resolution of extSrc so each keeps its
// resolution semantics.
export function linkShipExtensions(home: string, extSrc: string, opts: ShipExtOptions = {}): ShipExtResult {
	const result: ShipExtResult = { srcMissing: false, dstExisted: false, changed: 0, skipped: 0, noop: 0 };

	if (!isDirectory(extSrc)) {
		result.srcMissing = true;
		return result;
	}

	const extDst = join(home, ".omp", "extensions");
	result.dstExisted = isDirectory(extDst);
	if (!result.dstExisted) mkdirSync(extDst, { recursive: true });

	const track = (path: string) => {
		if (opts.trackFile) appendFileSync(opts.trackFile, `${path}\n`);
	};

	// bash's `for entry in "$ext_src"/*` glob skips dotfiles by default (no
	// dotglob); readdirSync does not, so filter to match.
	const entries = readdirSync(extSrc).filter(name => !name.startsWith("."));
	for (const entry of entries) {
		const canonical = join(extSrc, entry);
		const name = basename(entry);
		const linkPath = join(extDst, name);

		let st: ReturnType<typeof lstatSync> | null = null;
		try {
			st = lstatSync(linkPath);
		} catch {
			st = null;
		}

		if (st !== null && !st.isSymbolicLink()) {
			if (opts.verbose) process.stdout.write(`ship-ext: skip real file ${name}\n`);
			result.skipped += 1;
			continue;
		}

		if (st !== null && st.isSymbolicLink()) {
			const existingTarget = readlinkSync(linkPath);
			if (existingTarget === canonical) {
				result.noop += 1;
				continue;
			}
			rmSync(linkPath, { force: true });
			symlinkSync(canonical, linkPath);
			track(linkPath);
			if (opts.verbose) process.stdout.write(`ship-ext: refreshed ${name} -> ${canonical}\n`);
			result.changed += 1;
		} else {
			symlinkSync(canonical, linkPath);
			track(linkPath);
			if (opts.verbose) process.stdout.write(`ship-ext: linked ${name} -> ${canonical}\n`);
			result.changed += 1;
		}
	}

	return result;
}

function isEmptyDirectory(path: string): boolean {
	try {
		const st = lstatSync(path);
		return st.isDirectory() && readdirSync(path).length === 0;
	} catch {
		return false;
	}
}

export function hasLifecycleGuard(path: string): boolean {
	try {
		return lstatSync(join(path, "fm-lifecycle-guard.ts")).isFile();
	} catch {
		return false;
	}
}

export function isTrackedPreHooks(home: string): boolean {
	const result = spawnSync("git", ["-C", home, "ls-files", "--error-unmatch", "--", ".omp/hooks/pre/fm-lifecycle-guard.ts"], {
		stdio: "ignore",
	});
	return result.status === 0 && !result.error;
}

// linkShipPreHooks(home, source, opts?): install the native fleet hook
// directory as one symlink under <home>/.omp/hooks/pre. A tracked real
// directory containing the lifecycle guard is authoritative; all other real
// material is preserved.
export function linkShipPreHooks(home: string, source: string, opts: ShipExtOptions = {}): ShipExtResult {
	const result: ShipExtResult = { srcMissing: false, dstExisted: false, changed: 0, skipped: 0, noop: 0 };

	if (!isDirectory(source) || !hasLifecycleGuard(source)) {
		result.srcMissing = true;
		return result;
	}
	const ompDir = join(home, ".omp");
	const hooksDir = join(ompDir, "hooks");
	const preDst = join(hooksDir, "pre");
	let hooksSt: ReturnType<typeof lstatSync> | null = null;
	try {
		hooksSt = lstatSync(hooksDir);
	} catch {
		hooksSt = null;
	}
	if (hooksSt !== null && (!hooksSt.isDirectory() || hooksSt.isSymbolicLink())) {
		if (opts.verbose) process.stdout.write("ship-ext: skip hooks directory conflict\n");
		result.skipped += 1;
		return result;
	}
	result.dstExisted = isDirectory(preDst);

	if (isDirectory(preDst) && hasLifecycleGuard(preDst) && isTrackedPreHooks(home)) {
		if (opts.verbose) process.stdout.write("ship-ext: preserve authoritative real pre hooks\n");
		result.noop += 1;
		return result;
	}
	let st: ReturnType<typeof lstatSync> | null = null;
	try {
		st = lstatSync(preDst);
	} catch {
		st = null;
	}

	if (st !== null && st.isSymbolicLink()) {
		if (readlinkSync(preDst) === source) {
			result.noop += 1;
			return result;
		}
		rmSync(preDst, { force: true });
		mkdirSync(hooksDir, { recursive: true });
		symlinkSync(source, preDst);
		if (opts.trackFile) appendFileSync(opts.trackFile, `${preDst}\n`);
		if (opts.verbose) process.stdout.write(`ship-ext: refreshed pre -> ${source}\n`);
		result.changed += 1;
		return result;
	}

	if (st !== null) {
		if (!st.isDirectory() || !isEmptyDirectory(preDst)) {
			if (opts.verbose) process.stdout.write("ship-ext: skip real pre hooks conflict\n");
			result.skipped += 1;
			return result;
		}
		rmdirSync(preDst);
	}

	mkdirSync(hooksDir, { recursive: true });
	symlinkSync(source, preDst);
	if (opts.trackFile) appendFileSync(opts.trackFile, `${preDst}\n`);
	if (opts.verbose) process.stdout.write(`ship-ext: linked pre -> ${source}\n`);
	result.changed += 1;
	return result;
}
