// Shared OMP system-context injection for secondmate launchers.
// Charter bytes are read once through a safe regular-file primitive, validated
// as fatal UTF-8 without NULs, then injected and hashed from those same bytes.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { shellQuote } from "./spawn";

export const CHARTER_REL_PATH = "data/charter.md";
export const FM_INJECTED_CHARTER_PATH_ENV = "FM_INJECTED_CHARTER_PATH";
export const FM_INJECTED_CHARTER_SHA256_ENV = "FM_INJECTED_CHARTER_SHA256";

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

export class CharterLoadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CharterLoadError";
	}
}

export interface LoadedCharter {
	relativePath: string;
	/** Untrimmed UTF-8 text of the charter file. */
	text: string;
	/** sha256 of the raw file bytes (same bytes that produce `text`). */
	digest: string;
}

export interface ParsedOmpLaunch {
	/** Text before the omp executable (env assigns and whitespace). */
	prefix: string;
	/** The omp executable token as written (`omp` or a path ending in `/omp`). */
	executable: string;
	/** Remainder after the executable (leading whitespace preserved). */
	rest: string;
}

/**
 * Locate the omp executable in a launch command, skipping leading VAR=value
 * assignments. Shared by classification and `--append-system-prompt` injection.
 */
export function parseOmpLaunchCommand(command: string): ParsedOmpLaunch | null {
	let pos = 0;
	const len = command.length;
	while (pos < len) {
		while (pos < len && /\s/.test(command[pos]!)) pos++;
		if (pos >= len) return null;
		const start = pos;
		while (pos < len && !/\s/.test(command[pos]!)) pos++;
		const token = command.slice(start, pos);
		if (ENV_ASSIGN.test(token)) continue;
		const base = token.split("/").pop() ?? "";
		if (base === "omp") {
			return {
				prefix: command.slice(0, start),
				executable: token,
				rest: command.slice(pos),
			};
		}
		return null;
	}
	return null;
}

export function isOmpLaunchCommand(command: string): boolean {
	return parseOmpLaunchCommand(command) !== null;
}

/** Safe charter bytes: regular file only, no symlink, fatal UTF-8, no NUL. */
export function readSafeCharterFile(home: string): { absolute: string; bytes: Buffer; text: string } {
	const relativePath = CHARTER_REL_PATH;
	const absolute = join(home, relativePath);
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(absolute);
	} catch {
		throw new CharterLoadError(`missing or unreadable ${relativePath}`);
	}
	if (st.isSymbolicLink()) {
		throw new CharterLoadError(`${relativePath} must not be a symlink`);
	}
	if (!st.isFile()) {
		throw new CharterLoadError(`${relativePath} must be a regular file`);
	}
	let fd: number;
	try {
		fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		throw new CharterLoadError(`missing or unreadable ${relativePath}`);
	}
	let bytes: Buffer;
	try {
		if (!fstatSync(fd).isFile()) {
			throw new CharterLoadError(`${relativePath} must be a regular file`);
		}
		bytes = readFileSync(fd);
	} finally {
		closeSync(fd);
	}
	if (bytes.includes(0)) {
		throw new CharterLoadError(`${relativePath} contains NUL bytes`);
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new CharterLoadError(`${relativePath} is not valid UTF-8`);
	}
	if (text.trim().length === 0) {
		throw new CharterLoadError(`${relativePath} is empty`);
	}
	return { absolute, bytes, text };
}

/** Read `data/charter.md` once; reject unsafe, empty, invalid UTF-8, or NUL. */
export function loadRequiredCharter(home: string): LoadedCharter {
	const { bytes, text } = readSafeCharterFile(home);
	return {
		relativePath: CHARTER_REL_PATH,
		text,
		digest: createHash("sha256").update(bytes).digest("hex"),
	};
}

/** Current charter digest using the same safe-read rules, or null if unusable. */
export function currentSafeCharterDigest(home: string): string | null {
	try {
		const { bytes } = readSafeCharterFile(home);
		return createHash("sha256").update(bytes).digest("hex");
	} catch {
		return null;
	}
}

/** Labeled charter section from untrimmed charter text. */
export function charterSystemBlock(text: string): string {
	if (!text) throw new Error("empty charter system block");
	return `## Local charter\n\n${text}`;
}

/**
 * Join ordered system-context blocks for OMP's single-value
 * `--append-system-prompt` CLI option.
 */
export function joinOmpSystemPromptBlocks(blocks: string[]): string {
	for (const block of blocks) {
		if (!block) throw new Error("empty append-system-prompt block");
	}
	return blocks.join("\n\n");
}

/**
 * Inject one `--append-system-prompt=` containing all blocks in caller order
 * after the omp executable. OMP's Pi-compatible CLI option is single-value, so
 * repeating the flag would keep only the last block. Preserves env-assign
 * prefixes and path-form executables. Returns the original command when it is
 * not OMP.
 */
export function injectOmpAppendSystemPrompts(command: string, blocks: string[]): string {
	const parsed = parseOmpLaunchCommand(command);
	if (!parsed) return command;
	const prompt = joinOmpSystemPromptBlocks(blocks);
	const injected = ` --append-system-prompt=${shellQuote(prompt)}`;
	return `${parsed.prefix}${parsed.executable}${injected}${parsed.rest}`;
}

/** Env markers proving the launcher injected a specific charter digest. */
export function charterInjectionEnv(digest: string): Record<string, string> {
	return {
		[FM_INJECTED_CHARTER_PATH_ENV]: CHARTER_REL_PATH,
		[FM_INJECTED_CHARTER_SHA256_ENV]: digest,
	};
}

/**
 * Validate launcher markers against the live charter file via safe-read.
 * Returns both fields together, or undefined (omit both). Never one field.
 */
export function resolveValidatedCharterClaim(operationalHome: string, env: NodeJS.ProcessEnv = process.env): {
	charter_path: string;
	charter_digest: string;
} | undefined {
	const pathRaw = env[FM_INJECTED_CHARTER_PATH_ENV];
	const digestRaw = env[FM_INJECTED_CHARTER_SHA256_ENV];
	const pathPresent = pathRaw !== undefined && pathRaw !== "";
	const digestPresent = digestRaw !== undefined && digestRaw !== "";
	if (!pathPresent && !digestPresent) return undefined;
	const path = typeof pathRaw === "string" ? pathRaw.trim() : "";
	const digest = typeof digestRaw === "string" ? digestRaw.trim().toLowerCase() : "";
	if (path !== CHARTER_REL_PATH) return undefined;
	if (!/^[0-9a-f]{64}$/.test(digest)) return undefined;
	const current = currentSafeCharterDigest(operationalHome);
	if (!current || current !== digest) return undefined;
	return { charter_path: CHARTER_REL_PATH, charter_digest: digest };
}
