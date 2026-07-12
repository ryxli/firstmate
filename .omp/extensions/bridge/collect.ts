// bridge - IO layer: read the live fleet, run gh + herdr, assemble a snapshot.
//
// Everything here is best-effort and READ-ONLY: it only reads fleet files and
// spawns read-only `gh pr view` / `herdr agent list`. Any missing file, missing
// home, or failed/slow subprocess degrades to a note rather than an error, so
// /bridge always renders what is available.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
	basename,
	type BridgeView,
	buildSnapshot,
	type FleetSnapshot,
	type HerdrAgent,
	parseHome,
	type ParsedHome,
	parseSecondmateHomes,
	type PendingItem,
	type PrInfo,
	type PrState,
	prUrlsToFetch,
	type RawHome,
	render,
} from "./fleet";

/**
 * A directory is a MAIN firstmate home if it carries the canonical spawn script
 * and is NOT a secondmate home (secondmate homes are leased clones that link in
 * sbin/ too, but carry the .fm-secondmate-home marker).
 */
function isMainHome(dir: string): boolean {
	return existsSync(join(dir, "sbin", "fm-spawn.sh")) && !existsSync(join(dir, ".fm-secondmate-home"));
}

/**
 * Resolve the MAIN firstmate home, or null if none can be located. Order:
 * $FM_HOME (the repo's own convention) or $FIRSTMATE_HOME (back-compat) when
 * either points at a real main home; then WALK UP from the invoking pane's cwd
 * (the omp ExtensionContext.cwd hook) so /bridge works anywhere in the tree;
 * then known clone locations. It never tells the captain to set an env var.
 */
export function resolveMainHome(cwd?: string): string | null {
	const env = process.env.FM_HOME?.trim() || process.env.FIRSTMATE_HOME?.trim();
	if (env && isMainHome(env)) return env;
	let dir = cwd && cwd.length > 0 ? cwd : process.cwd();
	for (let i = 0; i < 64; i++) {
		if (isMainHome(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const cand of [join(homedir(), "code", "harness", "firstmate"), join(homedir(), "code", "firstmate")]) {
		if (isMainHome(cand)) return cand;
	}
	return null;
}

function readFileOrNull(path: string): string | null {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	} catch {
		return null;
	}
}

/** Read one home's raw fleet files (backlog + state/*.meta + matching *.status). */
export function readRawHome(homePath: string, isMain: boolean): RawHome {
	const backlogText = readFileOrNull(join(homePath, "data", "backlog.md"));
	const stateDir = join(homePath, "state");
	const metas: { id: string; text: string }[] = [];
	const statuses: Record<string, string> = {};
	let entries: string[] = [];
	try {
		entries = existsSync(stateDir) ? readdirSync(stateDir) : [];
	} catch {
		entries = [];
	}
	for (const name of entries) {
		if (!name.endsWith(".meta")) continue;
		const id = name.slice(0, -".meta".length);
		const metaText = readFileOrNull(join(stateDir, name));
		if (metaText === null) continue;
		metas.push({ id, text: metaText });
		// Status sits beside the meta in the SAME home (resolves the status-path
		// wrinkle: secondmate metas live in main home, crewmate metas in their
		// secondmate home; either way <id>.status is next to <id>.meta).
		const statusText = readFileOrNull(join(stateDir, `${id}.status`));
		if (statusText !== null) statuses[id] = statusText;
	}
	return { path: homePath, isMain, backlogText, metas, statuses };
}

interface Spawned {
	ok: boolean;
	stdout: string;
}

/** Run argv read-only with a timeout; never throws. */
async function run(argv: string[], timeoutMs: number): Promise<Spawned> {
	try {
		const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				// already exited
			}
		}, timeoutMs);
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		clearTimeout(timer);
		return { ok: code === 0, stdout };
	} catch {
		return { ok: false, stdout: "" };
	}
}

/**
 * Aggregate a gh statusCheckRollup into one CI verdict. A rollup mixes two node
 * shapes: CheckRun (a `status` of QUEUED/IN_PROGRESS/COMPLETED + a `conclusion`)
 * and StatusContext (a `state` of EXPECTED/PENDING/SUCCESS/FAILURE/ERROR with NO
 * `status`). Both kinds are handled so a pending required context is never
 * mistaken for passing.
 */
export function rollupVerdict(rollup: unknown): PrInfo["checks"] {
	if (!Array.isArray(rollup) || rollup.length === 0) return "none";
	let failing = false;
	let pending = false;
	for (const c of rollup) {
		const node = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
		const status = String(node.status ?? "").toUpperCase();
		const conclusion = String(node.conclusion ?? "").toUpperCase();
		const state = String(node.state ?? "").toUpperCase();
		// CheckRun: not yet COMPLETED -> still running.
		if (status && status !== "COMPLETED") pending = true;
		// StatusContext: a commit-status state without a check-run status.
		if (!status && (state === "PENDING" || state === "EXPECTED")) pending = true;
		if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(conclusion)) {
			failing = true;
		}
		if (state === "FAILURE" || state === "ERROR") failing = true;
	}
	if (failing) return "failing";
	if (pending) return "pending";
	return "passing";
}

/** Max live `gh pr view` lookups per /bridge; excess URLs are noted, not fetched. */
const MAX_PR_LOOKUPS = 30;
/** Concurrent `gh` subprocesses (bounded so a big fleet does not fork a swarm). */
const PR_LOOKUP_CONCURRENCY = 6;

export function splitPrLookups(
	urls: string[],
	max: number = MAX_PR_LOOKUPS,
): { toFetch: string[]; cappedUrls: string[]; map: Map<string, PrInfo> } {
	const toFetch = urls.slice(0, max);
	const cappedUrls = urls.slice(max);
	const map = new Map<string, PrInfo>();
	for (const url of cappedUrls) map.set(url, { url, state: "UNKNOWN", checks: "unknown" });
	return { toFetch, cappedUrls, map };
}

/** Run `fn` over items with at most `limit` in flight; preserves input order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const idx = next++;
			if (idx >= items.length) return;
			results[idx] = await fn(items[idx]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/**
 * Best-effort `gh pr view <url> --json state,statusCheckRollup`, bounded to
 * MAX_PR_LOOKUPS with PR_LOOKUP_CONCURRENCY in flight. A failed/malformed lookup
 * is recorded as state UNKNOWN (NOT dropped) so an open PR stays visible during a
 * gh outage instead of being mistaken for resolved. `capped` counts URLs skipped
 * past the cap.
 */
async function fetchPrStates(urls: string[]): Promise<{ map: Map<string, PrInfo>; failed: number; capped: number }> {
	const { toFetch, cappedUrls, map } = splitPrLookups(urls);
	let failed = 0;
	const results = await mapPool(toFetch, PR_LOOKUP_CONCURRENCY, async url => {
		const r = await run(["gh", "pr", "view", url, "--json", "state,statusCheckRollup"], 6000);
		if (!r.ok) return { url, info: null as PrInfo | null };
		try {
			const data = JSON.parse(r.stdout) as { state?: string; statusCheckRollup?: unknown };
			const state = String(data.state ?? "UNKNOWN").toUpperCase() as PrState;
			return { url, info: { url, state, checks: rollupVerdict(data.statusCheckRollup) } };
		} catch {
			return { url, info: null };
		}
	});
	for (const { url, info } of results) {
		if (info) {
			map.set(url, info);
		} else {
			failed++;
			map.set(url, { url, state: "UNKNOWN", checks: "unknown" });
		}
	}
	return { map, failed, capped: cappedUrls.length };
}

/** Best-effort `herdr agent list` -> the live agents array. */
async function fetchHerdrAgents(): Promise<{ agents: HerdrAgent[]; ok: boolean }> {
	const r = await run(["herdr", "agent", "list"], 5000);
	if (!r.ok) return { agents: [], ok: false };
	try {
		const data = JSON.parse(r.stdout) as { result?: { agents?: HerdrAgent[] } };
		return { agents: data.result?.agents ?? [], ok: true };
	} catch {
		return { agents: [], ok: false };
	}
}

// ---------------------------------------------------------------------------
// fm-focus integration: the SINGLE ranking authority.
// ---------------------------------------------------------------------------
// The bridge does NOT classify "what needs the captain" itself. It calls the
// firstmate's sbin/fm-focus.mjs rank()/gather()/reason(), so the /bridge PENDING
// list is the SAME ranking the captain gets from `fm-focus` - the two glance
// surfaces can never disagree. Best-effort: if fm-focus is unreachable the
// bridge degrades to an empty pending list plus a note.

interface FocusItem {
	id: string;
	home: string;
	pane: string;
	pr: string;
}
interface FocusRanked {
	rank: number;
	item: FocusItem;
	s: { cls: number; tag: string };
}
interface FocusModule {
	gather(mainHome: string): FocusItem[];
	rank(items: FocusItem[], now?: number): FocusRanked[];
	reason(r: FocusRanked): string;
	CLASS_NAME: Record<number, string>;
}

/** Rank the whole fleet via fm-focus and keep the rows that actually need the captain. */
async function computeFocusPending(main: string, prByUrl: Map<string, PrInfo>, notes: string[]): Promise<PendingItem[]> {
	const focusPath = join(main, "sbin", "fm-focus.mjs");
	if (!existsSync(focusPath)) {
		notes.push("priority ranking unavailable - sbin/fm-focus.mjs not found");
		return [];
	}
	let mod: FocusModule;
	try {
		// Runtime-selected path: fm-focus.mjs lives in the resolved main firstmate
		// home's sbin/, a separate repo whose absolute path is only known at runtime
		// (resolveMainHome walks the filesystem). A static import cannot name it.
		mod = await import(focusPath);
	} catch (err) {
		notes.push(`priority ranking unavailable - ${String(err)}`);
		return [];
	}
	let ranked: FocusRanked[];
	try {
		ranked = mod.rank(mod.gather(main));
	} catch (err) {
		notes.push(`priority ranking failed - ${String(err)}`);
		return [];
	}
	const pending: PendingItem[] = [];
	for (const r of ranked) {
		if (r.s.cls < 3) continue; // only CAPTAIN-BLOCKED (4) + REVIEW-READY (3) need the captain
		let why = mod.reason(r);
		if (r.item.pr) {
			const info = prByUrl.get(r.item.pr);
			if (info?.state === "MERGED") continue; // already merged - no longer pending
			if (info && info.checks !== "none" && info.checks !== "unknown") why += ` [ci ${info.checks}]`;
		}
		pending.push({
			cls: mod.CLASS_NAME[r.s.cls] ?? String(r.s.cls),
			clsRank: r.s.cls,
			home: basename(r.item.home),
			id: r.item.id,
			reason: why,
		});
	}
	return pending;
}

/**
 * Read the whole fleet live into a render-ready snapshot. READ-ONLY: spawns only
 * `gh`/`herdr` reads and reads fleet files; writes nothing anywhere. PENDING comes
 * from fm-focus (the single ranking authority); the tree + ledger come from here.
 */
export async function collectSnapshot(now = new Date().toISOString(), cwd?: string): Promise<FleetSnapshot> {
	const notes: string[] = [];
	const main = resolveMainHome(cwd);
	const rawHomes: RawHome[] = [];

	if (main === null) {
		notes.push("could not locate the firstmate home (checked the current pane, FM_HOME, and ~/code/harness/firstmate)");
	} else {
		rawHomes.push(readRawHome(main, true));
		const secondmatesText = readFileOrNull(join(main, "data", "secondmates.md"));
		if (secondmatesText === null) {
			notes.push("data/secondmates.md missing - only the main home is shown");
		} else {
			const parsedHomes = parseSecondmateHomes(secondmatesText);
			// A secondmate entry is a top-level list bullet; if rows exist but no
			// home: path parsed, the file is malformed and we would silently render
			// only the main home (a false all-clear). Make that gap visible.
			const rows = secondmatesText.split(/\r?\n/).filter(l => /^- \S/.test(l.trim())).length;
			if (parsedHomes.length === 0 && rows > 0) {
				notes.push(`secondmates.md has ${rows} entr${rows === 1 ? "y" : "ies"} but no home: path parsed - check the file format`);
			} else if (parsedHomes.length < rows) {
				notes.push(`secondmates.md: parsed ${parsedHomes.length} of ${rows} entries - some are missing a home: path`);
			}
			for (const homePath of parsedHomes) {
				if (existsSync(homePath)) rawHomes.push(readRawHome(homePath, false));
				else notes.push(`secondmate home not found: ${homePath}`);
			}
		}
	}

	const homes: ParsedHome[] = rawHomes.map(parseHome);

	const [herdrResult, prResult] = await Promise.all([
		fetchHerdrAgents(),
		fetchPrStates(prUrlsToFetch(homes)),
	]);

	if (!herdrResult.ok) notes.push("herdr agent list unavailable - live agent status omitted");
	if (prResult.failed > 0) {
		notes.push(`gh PR state unknown for ${prResult.failed} PR(s) - merged/CI state may be stale (gh slow/unauth?)`);
	}
	if (prResult.capped > 0) {
		notes.push(`${prResult.capped} PR(s) exceeded the live-check cap (${MAX_PR_LOOKUPS}) and were not verified`);
	}

	const herdrByPane = new Map<string, HerdrAgent>();
	for (const a of herdrResult.agents) if (a.pane_id) herdrByPane.set(a.pane_id, a);

	const pending = main === null ? [] : await computeFocusPending(main, prResult.map, notes);

	return buildSnapshot(homes, herdrByPane, herdrResult.agents, prResult.map, pending, now, notes);
}

/** Read the whole fleet live and render the /bridge board for a view (READ-ONLY). */
export async function collectAndRender(now = new Date().toISOString(), cwd?: string, view: BridgeView = "roster"): Promise<string> {
	return render(await collectSnapshot(now, cwd), view);
}
