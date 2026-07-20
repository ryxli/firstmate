// whiteboard core.
//
// The file IS the state: every read hits disk, there is no cache, and the core
// stays free of omp imports so it is easy to unit-test. Every operation accepts a
// file path while defaulting to the global board for compatibility.

import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { boardPath } from "./config.ts";

export const HEADER = "# Whiteboard\n";
export const MAX_BYTES = 64 * 1024;

function sizeError(): Error {
	return new Error("whiteboard size cap exceeded (64 KB)");
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function ensureParentDir(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}

function appendSeparator(current: string): string {
	if (current.length === 0) return "";
	if (current.endsWith("\n\n")) return "";
	if (current.endsWith("\n")) return "\n";
	return "\n\n";
}

function writeAtomically(path: string, content: string): void {
	ensureParentDir(path);
	const tempPath = join(dirname(path), `.whiteboard.${process.pid}.${Date.now()}.tmp`);
	let fileDescriptor: number | undefined;

	try {
		fileDescriptor = openSync(tempPath, "w");
		writeFileSync(fileDescriptor, content, "utf8");
		fsyncSync(fileDescriptor);
		closeSync(fileDescriptor);
		fileDescriptor = undefined;
		renameSync(tempPath, path);
	} catch (error) {
		if (fileDescriptor !== undefined) {
			try {
				closeSync(fileDescriptor);
			} catch {
				// best effort cleanup
			}
		}
		try {
			unlinkSync(tempPath);
		} catch {
			// best effort cleanup
		}
		throw error;
	}
}

export function read(filePath: string = boardPath()): string {
	try {
		return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
	} catch {
		return "";
	}
}

export function append(text: string, filePath: string = boardPath()): string {
	if (text.trim().length === 0) {
		throw new Error("whiteboard append requires non-empty text");
	}

	const fileExists = existsSync(filePath);
	const current = read(filePath);
	const base = fileExists ? current : HEADER;
	const chunk = `${appendSeparator(base)}${text.endsWith("\n") ? text : `${text}\n`}`;
	const next = `${base}${chunk}`;
	if (byteLength(next) > MAX_BYTES) {
		throw sizeError();
	}

	ensureParentDir(filePath);
	if (!fileExists) {
		writeFileSync(filePath, HEADER, "utf8");
	}
	appendFileSync(filePath, chunk, "utf8");
	return read(filePath);
}

export function replace(text: string, filePath: string = boardPath()): string {
	const content = String(text ?? "");
	if (byteLength(content) > MAX_BYTES) {
		throw sizeError();
	}
	writeAtomically(filePath, content);
	return read(filePath);
}

export function clear(filePath: string = boardPath()): string {
	writeAtomically(filePath, HEADER);
	return read(filePath);
}

// Line model: line N is exactly what you count reading the file. Split on "\n"
// with the single trailing newline stripped, so a 3-line board has 3 lines, and
// join back with one trailing newline. This pair is the whole line contract the
// range primitives share; everything else is a direct splice.
function toLines(content: string): string[] {
	if (content === "") return [];
	const body = content.endsWith("\n") ? content.slice(0, -1) : content;
	return body.split("\n");
}

// Render the board with a 1-based line-number gutter, over the SAME line model
// the range primitives use, so a number the caller reads here is exactly the
// `from`/`to` that removeLines/replaceRange consume. The gutter and the ops can
// never drift because they split identically.
export function numberLines(content: string): string {
	const lines = toLines(content);
	const width = String(lines.length).length;
	return lines.map((line, i) => `${String(i + 1).padStart(width)}  ${line}`).join("\n");
}

export function diffSince(previous: string, current: string = read()): string {
	if (previous === current) return "(no whiteboard changes since last read)";
	const before = toLines(previous);
	const after = toLines(current);
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) suffix++;
	const removed = before.slice(prefix, before.length - suffix);
	const added = after.slice(prefix, after.length - suffix);
	const start = prefix + 1;
	const addedEnd = added.length ? prefix + added.length : prefix;
	const removedEnd = removed.length ? prefix + removed.length : prefix;
	const addedText = added.length ? added.map((line, i) => `${String(start + i)}  ${line}`).join("\n") : "(none)";
	const removedText = removed.length ? removed.map((line, i) => `${String(start + i)}  ${line}`).join("\n") : "(none)";
	return [
		`changed new lines ${start}-${addedEnd}; replaced old lines ${start}-${removedEnd}`,
		"added/current:",
		addedText,
		"removed/previous:",
		removedText,
	].join("\n");
}

// Validate a 1-based inclusive [from, to] against the line count; clamp `to`
// down to the last line so "to the end" needs no line-counting by the caller.
function clampRange(from: number, to: number, count: number): [number, number] {
	if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error("line numbers must be integers");
	if (from < 1 || from > count) throw new Error(`line ${from} out of range (board has ${count} line${count === 1 ? "" : "s"})`);
	const hi = Math.min(to, count);
	if (hi < from) throw new Error(`invalid range ${from}-${to}`);
	return [from, hi];
}

// Size-check, write atomically, return the fresh board. If a mutation emptied the
// board, reset to the bare header rather than persisting a lone blank line.
function commit(lines: string[], filePath: string): string {
	if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return clear(filePath);
	const next = `${lines.join("\n")}\n`;
	if (byteLength(next) > MAX_BYTES) throw sizeError();
	writeAtomically(filePath, next);
	return read(filePath);
}

// Delete a 1-based inclusive line range (`to` defaults to `from` = one line).
export function removeLines(from: number, to: number = from, filePath: string = boardPath()): string {
	const lines = toLines(read(filePath));
	const [lo, hi] = clampRange(from, to, lines.length);
	lines.splice(lo - 1, hi - lo + 1);
	return commit(lines, filePath);
}

// Swap a 1-based inclusive line range for `text` (which may be multiple lines).
// To delete, use removeLines; replaceRange requires non-empty text.
export function replaceRange(from: number, to: number, text: string, filePath: string = boardPath()): string {
	if (String(text ?? "").length === 0) throw new Error("replaceRange requires non-empty text (use removeLines to delete)");
	const lines = toLines(read(filePath));
	const [lo, hi] = clampRange(from, to, lines.length);
	lines.splice(lo - 1, hi - lo + 1, ...toLines(text));
	return commit(lines, filePath);
}

// Replace a markdown section: the heading matching `heading` (compared by its
// text, ignoring leading #'s and case) through the line before the next heading
// of the same or higher level. `text` is the full replacement, including its own
// heading if you want one kept.
export function replaceSection(heading: string, text: string, filePath: string = boardPath()): string {
	if (String(text ?? "").length === 0) throw new Error("replaceSection requires non-empty text");
	const want = heading.replace(/^#+\s*/, "").trim().toLowerCase();
	if (want.length === 0) throw new Error("replaceSection requires a heading");
	const lines = toLines(read(filePath));
	const headingRe = /^(#{1,6})\s+(.*)$/;
	let start = -1;
	let level = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = headingRe.exec(lines[i]);
		if (m && m[2].trim().toLowerCase() === want) { start = i; level = m[1].length; break; }
	}
	if (start === -1) throw new Error(`section not found: ${heading}`);
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const m = headingRe.exec(lines[i]);
		if (m && m[1].length <= level) { end = i; break; }
	}
	lines.splice(start, end - start, ...toLines(text));
	return commit(lines, filePath);
}

export function path(filePath: string = boardPath()): string {
	return filePath;
}
