// fm lib: herdr - shared herdr pane primitives for firstmate.
// Ported behavior-preserving from sbin/fm-herdr-lib.sh.
//
// Replaces fm-tmux-lib.sh. All functions operate on herdr pane IDs
// (e.g. "w8:p3") rather than tmux targets. Sourced (in bash) by fm send;
// the `fm peek` CLI verb inlines its own copy of the slice it needs.
//
// herdr tracks agent status natively (idle|working|blocked|done|unknown),
// so the ANSI ghost-text stripping and pane-hash busy detection from the
// tmux era are gone. The guarantees this lib provides instead:
//
//   1. resolveLivePane: resolve durable targets (fm-<id>) through the
//      live herdr agent identity, and refresh state/<id>.meta when pane=
//      drifts after a restart/reopen.
//   2. paneIsBusy: reads herdr agent status; true when "working".
//   3. paneInputPending: reads visible pane content to detect a
//      half-typed human line in the composer; same semantics as before but
//      simpler implementation (no ANSI parsing, no SGR stripping).
//
// Text submission lives in fm send and uses one atomic
// "herdr pane run" call. This library never retries or queues text.
//
// Real callers (grepped): fm spawn and fm reload call jsonGet;
// fm reload calls metaSet directly; fm send, fm reload, and
// fm teardown call resolveLivePane; fm reload calls
// herdrPaneAgentProcessVerdict directly; fm spawn calls
// herdrReapHuskSlot; fm send calls paneInputPending. herdrPaneId,
// metaValue, herdrAgentStatus, paneIsBusy, and herdrClassifySlot have no
// direct external caller but are real dependencies of the kept functions
// above (resolveLivePane, paneInputPending, herdrReapHuskSlot respectively)
// and so are kept as their support functions.
//
// Dropped as caller-less: fm_task_for_pane is defined but never invoked
// anywhere in the repo, not even by another function in the same bash file.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// jsonGet(text, ...keys): parse a JSON string, walk the nested keys given as
// positional arguments, and return the leaf value coerced to a string (or ""
// on any parse error / missing key). This is the canonical accessor for
// herdr's one-shot JSON responses; prefer it over regexing raw JSON.
export function jsonGet(text: string, ...keys: string[]): string {
	try {
		let value: unknown = JSON.parse(text);
		for (const key of keys) {
			if (value === null || typeof value !== "object") return "";
			value = (value as Record<string, unknown>)[key];
		}
		if (value === undefined || value === null) return "";
		return String(value);
	} catch {
		return "";
	}
}

// metaValue(metaPath, key): the value of the last `key=` line in metaPath, or
// "" when the file or key is absent.
export function metaValue(metaPath: string, key: string): string {
	if (!existsSync(metaPath)) return "";
	const matches = readFileSync(metaPath, "utf8")
		.split(/\r?\n/)
		.filter(line => line.startsWith(`${key}=`));
	if (matches.length === 0) return "";
	const last = matches[matches.length - 1];
	return last.slice(last.indexOf("=") + 1);
}

// metaSet(metaPath, key, value): rewrite metaPath so its last `key=` line (or
// a newly appended one) reads `key=value`, preserving every other line.
export function metaSet(metaPath: string, key: string, value: string): void {
	let lines: string[] = [];
	if (existsSync(metaPath)) {
		lines = readFileSync(metaPath, "utf8").split(/\r?\n/);
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	}
	let found = false;
	const out: string[] = [];
	for (const line of lines) {
		if (line.startsWith(`${key}=`)) {
			out.push(`${key}=${value}`);
			found = true;
		} else {
			out.push(line);
		}
	}
	if (!found) out.push(`${key}=${value}`);
	writeFileSync(metaPath, out.map(line => `${line}\n`).join(""));
}

// herdrPaneId(target): the pane_id from `herdr agent get <target>`, or "" on
// any failure or no match.
export function herdrPaneId(target: string): string {
	const res = spawnSync("herdr", ["agent", "get", target], { encoding: "utf8" });
	if (res.error || typeof res.stdout !== "string") return "";
	const m = res.stdout.match(/"pane_id":"([^"]*)"/);
	return m ? m[1] : "";
}

// resolveLivePane(target, state): resolve durable targets (fm-<id>) through
// the live herdr agent identity, and refresh state/<id>.meta when pane=
// drifts after a restart/reopen. A bare "w8:p3"-shaped pane id passes through
// unchanged; anything else is resolved via `herdr agent get`. Returns null
// (having already written the error to stderr) on failure, mirroring the
// bash function's `echo ... >&2; return 1`.
export function resolveLivePane(target: string, state: string): string | null {
	if (target.includes(":")) return target;
	if (target.startsWith("fm-")) {
		if (!state) {
			process.stderr.write(`error: fm_resolve_live_pane needs a state dir for ${target}\n`);
			return null;
		}
		const metaPath = join(state, `${target.slice("fm-".length)}.meta`);
		if (!existsSync(metaPath)) {
			process.stderr.write(
				`error: no metadata for ${target} in ${state}; pass a pane id to target a pane outside this firstmate home\n`,
			);
			return null;
		}
		const slot = metaValue(metaPath, "agent_slot") || target;
		const live = herdrPaneId(slot);
		if (live) {
			const pane = metaValue(metaPath, "pane");
			if (pane !== live) metaSet(metaPath, "pane", live);
			return live;
		}
		const pane = metaValue(metaPath, "pane");
		if (!pane) {
			process.stderr.write(`error: no pane recorded in ${metaPath}\n`);
			return null;
		}
		return pane;
	}
	const pane = herdrPaneId(target);
	if (!pane) {
		process.stderr.write(`error: no pane found for ${target}\n`);
		return null;
	}
	return pane;
}

// herdrAgentStatus(pane): the current herdr agent status for a pane id, one
// of idle|working|blocked|done|unknown in practice - but note this returns ""
// (not "unknown") when the field is simply absent from the response, exactly
// like the bash version: its `|| printf 'unknown'` fallback is gated on the
// whole pipeline's exit status, and since the pipeline's last command (sed)
// exits 0 even on empty input, that fallback is effectively dead code that
// never fires. Ported verbatim rather than "fixed" to preserve behavior.
export function herdrAgentStatus(pane: string): string {
	const res = spawnSync("herdr", ["agent", "get", pane], { encoding: "utf8" });
	const text = res.stdout ?? "";
	const m = text.match(/"agent_status":"([^"]*)"/);
	return m ? m[1] : "";
}

// paneIsBusy(pane): true if the agent is currently working (agent mid-turn).
export function paneIsBusy(pane: string): boolean {
	return herdrAgentStatus(pane) === "working";
}

export type ProcessVerdict = "agent" | "shell" | "err";

// herdrPaneAgentProcessVerdict(pane): determine whether a pane contains a
// live coding harness when native status is still unknown. "shell" proves an
// agent-less restored shell; "agent" and "err" must fail closed.
export function herdrPaneAgentProcessVerdict(pane: string): ProcessVerdict {
	const res = spawnSync("herdr", ["pane", "process-info", "--pane", pane], { encoding: "utf8" });
	const processInfo = !res.error && res.status === 0 ? (res.stdout ?? "") : "";
	if (!processInfo) return "err";
	let processes: unknown;
	try {
		const parsed = JSON.parse(processInfo) as { result?: { process_info?: { foreground_processes?: unknown } } };
		processes = parsed?.result?.process_info?.foreground_processes;
	} catch {
		return "err";
	}
	if (!Array.isArray(processes)) return "err";
	const harness = /\b(omp|claude|codex|opencode|pi|node|bun|deno)\b/;
	for (const proc of processes) {
		const p = proc as Record<string, unknown>;
		const text = ["argv0", "name", "cmdline"].map(key => String(p?.[key] ?? "")).join(" ");
		if (harness.test(text)) return "agent";
	}
	return "shell";
}

export type SlotVerdict = "free" | "husk" | "live" | "unknown";

// herdrClassifySlot(slot): decide whether a persisted agent registration may
// be safely reused after herdr restores a session layout. Only a confirmed
// agent-less husk is reusable. A bound or booting agent remains protected.
export function herdrClassifySlot(slot: string): SlotVerdict {
	const agentRes = spawnSync("herdr", ["agent", "get", slot], { encoding: "utf8" });
	if (agentRes.error || agentRes.status !== 0) return "free";
	const info = agentRes.stdout ?? "";
	if (info.includes('"error"')) return "free";
	const pane = jsonGet(info, "result", "agent", "pane_id");
	if (!pane) return "free";
	const paneRes = spawnSync("herdr", ["pane", "get", pane], { encoding: "utf8" });
	const paneInfo = !paneRes.error && paneRes.status === 0 ? (paneRes.stdout ?? "") : "";
	if (!paneInfo || paneInfo.includes('"error"')) return "husk";
	const status = jsonGet(paneInfo, "result", "pane", "agent_status");
	if (status === "working" || status === "idle" || status === "blocked" || status === "done") return "live";
	return herdrPaneAgentProcessVerdict(pane) === "shell" ? "husk" : "unknown";
}

async function sleepSeconds(seconds: number): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// herdrReapHuskSlot(slot): remove only a confirmed session-restore husk.
// Callers must create the replacement tab before this resolves so closing the
// restored tab cannot leave its workspace empty. Returns true (rc 0) on
// success (including the free no-op case) or false (rc 1) after writing an
// explanatory error to stderr, mirroring the bash function's return codes.
export async function herdrReapHuskSlot(slot: string): Promise<boolean> {
	const verdict = herdrClassifySlot(slot);
	if (verdict === "free") return true;
	if (verdict === "husk") {
		const agentRes = spawnSync("herdr", ["agent", "get", slot], { encoding: "utf8" });
		const info = !agentRes.error && agentRes.status === 0 ? (agentRes.stdout ?? "") : "";
		const tab = jsonGet(info, "result", "agent", "tab_id");
		const pane = jsonGet(info, "result", "agent", "pane_id");
		if (tab) {
			spawnSync("herdr", ["tab", "close", tab]);
		} else if (pane) {
			spawnSync("herdr", ["pane", "close", pane]);
		}
		const settle = Number(process.env.FM_HUSK_REAP_SETTLE ?? "0.3");
		await sleepSeconds(settle);
		process.stderr.write(`info: reaped husk agent slot '${slot}' before respawn\n`);
		return true;
	}
	if (verdict === "live") {
		process.stderr.write(`error: agent slot '${slot}' is held by a live agent - refusing to replace\n`);
		return false;
	}
	process.stderr.write(`error: agent slot '${slot}' is occupied and not confidently a husk - refusing to replace\n`);
	return false;
}

// paneInputPending: true (pending) if the pane's visible content shows real
// unsubmitted text a human typed into the composer. An idle composer, a bare
// prompt glyph, or a busy footer is NOT pending. With herdr we read the raw
// visible text; no ANSI SGR stripping needed because herdr pane read returns
// plain text by default. Note: --lines is not honored by --source visible
// (herdr always returns the full visible viewport for that source), so this
// scans the whole visible tail rather than relying on a short window.
export function paneInputPending(pane: string): boolean {
	// If the agent is mid-turn, the visible last line is agent output, never
	// unsubmitted human text. Defer to the busy check so a working pane is
	// never misread as holding pending input.
	if (paneIsBusy(pane)) return false;

	const res = spawnSync("herdr", ["pane", "read", pane, "--lines", "3", "--source", "visible"], { encoding: "utf8" });
	const raw = (res.stdout ?? "").split(/\r?\n/).filter(line => !/^[ \t]*$/.test(line));
	if (raw.length === 0) return false;

	let found = false;
	let result = "";
	// Scan the visible tail top-to-bottom, keeping only the LAST line that is
	// neither known trailing chrome nor a border-only row; that survivor is the
	// composer's real content line. Current Claude Code layouts render, below
	// the composer's bottom border, a persistent mode-indicator footer (e.g.
	// "bypass permissions on (shift+tab to cycle)") and sometimes a shortcuts
	// hint - neither reflects composer content, so both are skipped instead of
	// being misread as an unsent draft (this was the false-positive bug: that
	// footer line was previously the last non-blank line, so it alone decided
	// pending/not-pending). A border-only row (e.g. omp/opus's "╰── … ──╯", or
	// Claude Code's plain rule lines) collapses to whitespace once box-drawing
	// chrome is stripped and is skipped the same way, since it carries no
	// signal either way. Nothing real follows the composer's actual content
	// line in these layouts, so the last surviving candidate is always that
	// content line. "result" (not "stripped") carries the winning candidate
	// across iterations, since a later skipped border/chrome row must not
	// clobber it.
	for (const line of raw) {
		if (line.includes("shift+tab to cycle") || line.includes("for shortcuts")) continue;
		let stripped = line
			.replaceAll("│", "")
			.replaceAll("┃", "")
			.replaceAll("|", "")
			.replaceAll("─", "")
			.replaceAll("━", "")
			.replaceAll("╭", "")
			.replaceAll("╮", "")
			.replaceAll("╰", "")
			.replaceAll("╯", "")
			.replaceAll("┌", "")
			.replaceAll("┐", "")
			.replaceAll("└", "")
			.replaceAll("┘", "");
		stripped = stripped.trim();
		if (!stripped) continue;
		found = true;
		result = stripped;
	}
	if (!found) return false;
	// Bare prompt glyph = empty composer.
	if (result === ">" || result === "❯" || result === "$" || result === "%" || result === "#") return false;
	// Custom idle-compositor override (after border stripping), e.g. for custom prompt patterns.
	const idleRe = process.env.FM_COMPOSER_IDLE_RE;
	if (idleRe) {
		if (new RegExp(idleRe).test(result)) return false;
	}
	// A busy footer on the cursor line is not pending input.
	const busyRe = process.env.FM_BUSY_REGEX || "esc (to )?interrupt|Working\\.\\.\\.";
	if (new RegExp(busyRe, "i").test(result)) return false;
	return true;
}
