// bridge - pure fleet parsing + rendering (NO bun/node imports).
//
// This module is the deterministic core of the /bridge command: it parses the
// on-disk firstmate fleet files (secondmates.md, backlog.md, *.meta, *.status),
// folds in live gh PR state + herdr agent status, and renders a compact,
// glanceable, READ-ONLY snapshot. It is dependency-free so it unit-tests against
// fixture homes with zero IO.
//
// STATUS-PATH WRINKLE (resolved here by construction): a secondmate's OWN status
// lands in the MAIN home (<main-home>/state/<sm>.status) and a secondmate's
// CREWMATE status lands in that secondmate's OWN home (<secondmate-home>/state/<id>.status).
// Because a secondmate's *.meta also lives in the main home and a crewmate's
// *.meta lives in the secondmate home, reading "<id>.status beside <id>.meta in
// the SAME home" is exactly the correct resolution - no special-casing needed.

export type StatusState = "working" | "needs-decision" | "blocked" | "failed" | "done" | "unknown";

export type PrState = "OPEN" | "MERGED" | "CLOSED" | "DRAFT" | "UNKNOWN";

export interface Meta {
	id: string;
	pane?: string;
	pr?: string;
	home?: string;
	kind?: string;
	mode?: string;
	raw: Record<string, string>;
}

export interface StatusLine {
	state: StatusState;
	text: string;
}

export type BacklogSection = "inflight" | "queued" | "done";

export interface BacklogItem {
	id: string;
	desc: string;
	section: BacklogSection;
	pr?: string;
	/** done item explicitly marked merged/closed/scrapped/replaced - no gh call needed. */
	resolved: boolean;
}

export interface Backlog {
	inflight: BacklogItem[];
	queued: BacklogItem[];
	done: BacklogItem[];
}

export interface PrInfo {
	url: string;
	state: PrState;
	checks: "passing" | "failing" | "pending" | "none" | "unknown";
}

/** A live herdr agent (subset of `herdr agent list` output we use). */
export interface HerdrAgent {
	pane_id?: string;
	agent_status?: string;
	name?: string;
	cwd?: string;
	workspace_id?: string;
}

// ---------------------------------------------------------------------------
// Raw -> parsed
// ---------------------------------------------------------------------------

export interface RawHome {
	path: string;
	isMain: boolean;
	backlogText: string | null;
	metas: { id: string; text: string }[];
	/** id -> raw status file contents. */
	statuses: Record<string, string>;
}

export interface ParsedAgent {
	id: string;
	meta: Meta;
	status?: StatusLine;
}

export interface ParsedHome {
	path: string;
	label: string;
	isMain: boolean;
	backlog: Backlog;
	agents: ParsedAgent[];
}

const STATUS_STATES: readonly StatusState[] = [
	"working",
	"needs-decision",
	"blocked",
	"failed",
	"done",
];

const PR_URL_RE = /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/;
const PR_URL_RE_G = /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/g;

/** Every GitHub PR URL in a string (status lines can carry `done: PR <url>`). */
export function extractPrUrls(text: string): string[] {
	return text.match(PR_URL_RE_G) ?? [];
}

/** PR URLs that mean "this done agent is awaiting merge". */
export function doneStatusPrUrls(status: StatusLine | undefined): string[] {
	if (status?.state !== "done") return [];
	if (!/^PR\s+https:\/\/github\.com\//i.test(status.text)) return [];
	return extractPrUrls(status.text);
}

/** Last path segment, e.g. ".../mates/riggs" -> "riggs". */
export function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Parse secondmate home paths from data/secondmates.md. Each secondmate line
 * carries `home: <path>` inside parentheses; we extract every one.
 */
export function parseSecondmateHomes(md: string): string[] {
	const homes: string[] = [];
	const re = /home:\s*([^;)\s]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(md)) !== null) {
		const p = m[1].trim();
		if (p && !homes.includes(p)) homes.push(p);
	}
	return homes;
}

/** Parse a `key=value` *.meta file. */
export function parseMeta(id: string, text: string): Meta {
	const raw: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq <= 0) continue;
		raw[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
	}
	return {
		id,
		pane: raw.pane,
		pr: raw.pr,
		home: raw.home,
		kind: raw.kind,
		mode: raw.mode,
		raw,
	};
}

/**
 * Parse the LAST non-empty line of a *.status file: `state: text`. Unknown
 * prefixes degrade to state "unknown" with the whole line as text.
 */
export function parseStatus(text: string): StatusLine | undefined {
	const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	if (lines.length === 0) return undefined;
	const last = lines[lines.length - 1];
	const colon = last.indexOf(":");
	if (colon > 0) {
		const prefix = last.slice(0, colon).trim().toLowerCase();
		if ((STATUS_STATES as readonly string[]).includes(prefix)) {
			return { state: prefix as StatusState, text: last.slice(colon + 1).trim() };
		}
	}
	return { state: "unknown", text: last };
}

/** id is the leading token after the `- [ ]`/`- [x]` checkbox, up to ` - `. */
function parseItemId(body: string): { id: string; desc: string } {
	const sep = body.indexOf(" - ");
	if (sep >= 0) return { id: body.slice(0, sep).trim(), desc: body.slice(sep + 3).trim() };
	return { id: body.trim(), desc: "" };
}

/** Parse a backlog.md file into its In flight / Queued / Done sections. */
export function parseBacklog(text: string | null): Backlog {
	const backlog: Backlog = { inflight: [], queued: [], done: [] };
	if (!text) return backlog;
	let section: BacklogSection | null = null;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		const head = /^#{1,6}\s+(.*)$/.exec(line);
		if (head) {
			const name = head[1].toLowerCase();
			if (name.includes("in flight") || name.includes("in-flight")) section = "inflight";
			else if (name.includes("queued")) section = "queued";
			else if (name.includes("done")) section = "done";
			else section = null;
			continue;
		}
		const item = /^- \[[ xX]\]\s+(.*)$/.exec(line);
		if (!item || section === null) continue;
		const body = item[1];
		const { id, desc } = parseItemId(body);
		if (!id) continue;
		const prM = PR_URL_RE.exec(body);
		const pr = prM ? prM[0] : undefined;
		const resolved = /\b(merged|closed|scrapped|replaced)\b/i.test(body);
		backlog[section].push({ id, desc, section, pr, resolved });
	}
	return backlog;
}

/** Parse a single home's raw files into structured form. */
export function parseHome(raw: RawHome): ParsedHome {
	const agents: ParsedAgent[] = [];
	for (const { id, text } of raw.metas) {
		const meta = parseMeta(id, text);
		const statusText = raw.statuses[id];
		const status = statusText !== undefined ? parseStatus(statusText) : undefined;
		agents.push({ id, meta, status });
	}
	agents.sort((a, b) => a.id.localeCompare(b.id));
	return {
		path: raw.path,
		label: basename(raw.path),
		isMain: raw.isMain,
		backlog: parseBacklog(raw.backlogText),
		agents,
	};
}

/**
 * The set of PR URLs worth a live gh check, in live-first order (so a fetch cap
 * keeps the most-likely-open ones): every agent meta `pr=`, every PR URL in a
 * latest `done: PR <url>` status line (a freshly-opened PR can exist ONLY there
 * before `pr=`/backlog catch up), every in-flight backlog PR, and every
 * UNRESOLVED done PR. Resolved done PRs render as landed links without a gh call.
 */
export function prUrlsToFetch(homes: ParsedHome[]): string[] {
	const urls = new Set<string>();
	for (const home of homes) {
		for (const a of home.agents) {
			if (a.meta.pr) urls.add(a.meta.pr);
			for (const u of doneStatusPrUrls(a.status)) urls.add(u);
		}
		for (const it of home.backlog.inflight) if (it.pr) urls.add(it.pr);
		for (const it of home.backlog.done) if (it.pr && !it.resolved) urls.add(it.pr);
	}
	return [...urls];
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * One ranked "needs the captain" row. NOT classified here - it is produced by
 * fm-focus (the single ranking authority) so /bridge and `fm-focus` agree exactly.
 */
export interface PendingItem {
	/** fm-focus class name, e.g. "CAPTAIN-BLOCKED", "REVIEW-READY". */
	cls: string;
	/** numeric class (4 highest) for color/grouping in the render. */
	clsRank: number;
	home: string;
	id: string;
	/** fm-focus reason() - the glanceable "why", optionally PR/CI-enriched. */
	reason: string;
}

/** A persistent named mate in the roster: the firstmate or a secondmate. */
export interface MateRow {
	/** Display name: the firstmate label, or the secondmate id. */
	name: string;
	role: "firstmate" | "secondmate";
	/** Live herdr agent_status (presence: idle/working/...). */
	herdrStatus?: string;
	/** In-flight tasks this mate owns (its home backlog in-flight count). */
	load: number;
}

export type TaskClassification = "active" | "waiting" | "blocked" | "stale" | "queued" | "complete";

/** One task in the ledger, tagged with its owner, project, and (in-flight) worker. */
export interface TaskRow {
	id: string;
	state: BacklogSection; // "inflight" | "queued" | "done"
	/** The mate that owns it (firstmate or a secondmate). */
	owner: string;
	/** Project/repo, parsed from the backlog line when present. */
	project?: string;
	/** Live worker status (in-flight only): the crewmate running it, for the glyph. */
	workerState?: string;
	/** Deterministic bridge-visible state derived from backlog/status/herdr/PR inputs. */
	classification: TaskClassification;
	/** The concrete signal supporting classification, rendered on the task board. */
	evidence: string;
	/** One concrete blocker when the task is blocked. */
	blocker?: string;
	/** One concrete next action when the task is blocked. */
	nextAction?: string;
	/** The ready queued task to pick up at a completion boundary. */
	nextPriority?: string;
	/** Glanceable detail: worker note (in-flight) / blocked-by or ready (queued) / merge state (done). */
	note: string;
	pr?: string;
	merged?: boolean;
}

export interface LivePane {
	name: string;
	status: string;
	cwd: string;
}

export interface FleetSnapshot {
	generatedAt: string;
	pending: PendingItem[];
	/** Persistent roster (firstmate first, then secondmates); empty only when the main home cannot be located. */
	mates: MateRow[];
	/** Every task across all homes, flat, tagged owner/project/state/worker. */
	tasks: TaskRow[];
	otherLivePanes: LivePane[];
	notes: string[];
}

/** Extract "(repo: X)" -> "X" from a backlog line, if present. */
function parseProject(desc: string): string | undefined {
	const m = /\(repo:\s*([^),;]+)/i.exec(desc);
	return m ? m[1].trim() : undefined;
}

/** A queued line's dependency: "blocked-by: X" -> "blocked-by X", else "ready". */
function blockedNote(desc: string): string {
	const m = /blocked-by:?\s*([^\s,)]+)/i.exec(desc);
	return m ? `blocked-by ${m[1].trim()}` : "ready";
}

function labeledValue(text: string, labelPattern: string): string | undefined {
	const m = new RegExp(`\\b(?:${labelPattern})\\s*[:=]\\s*([^;\\n]+)`, "i").exec(text);
	return m?.[1]?.trim() || undefined;
}

function blockerAndNext(text: string): { blocker?: string; nextAction?: string } {
	const blocker = labeledValue(text, "blocker|blocked by") ?? /\bblocked by\s+([^;\n]+)/i.exec(text)?.[1]?.trim();
	const nextAction = labeledValue(text, "next(?: action)?");
	return { blocker, nextAction };
}


function classifyInflight(
	it: BacklogItem,
	worker: ParsedAgent | undefined,
	herdr: HerdrAgent | undefined,
	prByUrl: Map<string, PrInfo>,
): Pick<TaskRow, "classification" | "evidence" | "blocker" | "nextAction"> {
	if (!worker) {
		return { classification: "stale", evidence: "missing worker metadata" };
	}
	if (worker.meta.pane && !herdr) {
		return { classification: "stale", evidence: `recorded pane ${worker.meta.pane} is not live` };
	}
	if (herdr?.name && herdr.name !== it.id) {
		return { classification: "stale", evidence: `pane ${worker.meta.pane ?? "?"} belongs to ${herdr.name}` };
	}

	const status = worker.status;
	if (status?.state === "blocked" || status?.state === "failed" || status?.state === "needs-decision") {
		const concrete = blockerAndNext(status.text);
		return {
			classification: "blocked",
			evidence: concrete.blocker ? `blocked by ${concrete.blocker}` : status.text,
			blocker: concrete.blocker,
			nextAction: concrete.nextAction,
		};
	}

	if (status?.state === "done") {
		const urls = doneStatusPrUrls(status);
		const waiting = urls.find(url => prByUrl.get(url)?.state !== "MERGED");
		if (waiting) {
			const pr = prByUrl.get(waiting);
			const suffix = pr ? `${pr.state.toLowerCase()}, checks ${pr.checks}` : "PR state unknown";
			return { classification: "waiting", evidence: `waiting on PR (${suffix})` };
		}
		return { classification: "waiting", evidence: status.text || "waiting at completion boundary" };
	}

	if (status?.state === "working" || herdr?.agent_status === "working") {
		return { classification: "active", evidence: status?.text || "live worker is working" };
	}

	if (herdr?.agent_status === "idle") {
		return { classification: "waiting", evidence: status?.text || "live worker is idle" };
	}

	return { classification: "stale", evidence: status?.text || "no live work signal" };
}

/**
 * Fold parsed homes + live signals into the render-ready snapshot via TWO lenses:
 * MATES (the persistent roster - firstmate + secondmates, with presence + load) and
 * TASKS (every backlog item across homes, tagged owner/project/state/worker). The
 * PENDING ranking is NOT computed here - fm-focus owns it and it is passed in, so
 * /bridge and `fm-focus` never disagree. A crewmate is the live worker of an
 * in-flight task and surfaces on the TASK lens, never as a roster person.
 */
export function buildSnapshot(
	homes: ParsedHome[],
	herdrByPane: Map<string, HerdrAgent>,
	herdrAll: HerdrAgent[],
	prByUrl: Map<string, PrInfo>,
	pending: PendingItem[],
	now: string,
	notes: string[] = [],
): FleetSnapshot {
	const normPath = (p?: string): string => (p ?? "").replace(/\/+$/, "");
	const secondmateHomes = homes.filter(h => !h.isMain);
	const homeByPath = new Map<string, ParsedHome>();
	for (const h of secondmateHomes) homeByPath.set(normPath(h.path), h);

	const usedPanes = new Set<string>();
	const ownerByHome = new Map<string, string>(); // home path -> owning mate name
	const consumedHomes = new Set<string>();
	const mates: MateRow[] = [];
	const mainHome = homes.find(h => h.isMain) ?? null;

	if (mainHome) {
		// The firstmate: its own supervisor pane sits at the main-home cwd.
		const ownPane = herdrAll.find(h => normPath(h.cwd) === normPath(mainHome.path));
		if (ownPane?.pane_id) usedPanes.add(ownPane.pane_id);
		ownerByHome.set(normPath(mainHome.path), mainHome.label);
		mates.push({ name: mainHome.label, role: "firstmate", herdrStatus: ownPane?.agent_status, load: mainHome.backlog.inflight.length });

		// Secondmates are kind=secondmate metas in the MAIN home, linked to their own homes.
		for (const a of mainHome.agents) {
			if (a.meta.kind !== "secondmate") continue;
			const smHome = a.meta.home ? homeByPath.get(normPath(a.meta.home)) : undefined;
			if (smHome) {
				consumedHomes.add(normPath(smHome.path));
				ownerByHome.set(normPath(smHome.path), a.id);
			}
			const herdr = a.meta.pane ? herdrByPane.get(a.meta.pane) : undefined;
			mates.push({ name: a.id, role: "secondmate", herdrStatus: herdr?.agent_status, load: smHome ? smHome.backlog.inflight.length : 0 });
		}

		// Registered secondmate homes with no linking meta (recovery transient).
		for (const smHome of secondmateHomes) {
			if (consumedHomes.has(normPath(smHome.path))) continue;
			const own = herdrAll.find(h => normPath(h.cwd) === normPath(smHome.path));
			if (own?.pane_id) usedPanes.add(own.pane_id);
			ownerByHome.set(normPath(smHome.path), basename(smHome.path));
			mates.push({ name: basename(smHome.path), role: "secondmate", herdrStatus: own?.agent_status, load: smHome.backlog.inflight.length });
		}
	}

	// Every tracked agent pane is attributed, so it never shows under "other panes".
	for (const home of homes) for (const a of home.agents) if (a.meta.pane) usedPanes.add(a.meta.pane);

	// TASK lens: flatten every home's backlog, tagging owner + project + live worker.
	const tasks: TaskRow[] = [];
	for (const home of homes) {
		const owner = ownerByHome.get(normPath(home.path)) ?? home.label;
		const workerById = new Map<string, ParsedAgent>();
		for (const a of home.agents) if (a.meta.kind !== "secondmate") workerById.set(a.id, a);
		const nextReady = home.backlog.queued.find(it => blockedNote(it.desc) === "ready");
		for (const it of home.backlog.inflight) {
			const w = workerById.get(it.id);
			const herdr = w?.meta.pane ? herdrByPane.get(w.meta.pane) : undefined;
			const classification = classifyInflight(it, w, herdr, prByUrl);
			tasks.push({
				id: it.id,
				state: "inflight",
				owner,
				project: parseProject(it.desc),
				workerState: w?.status?.state ?? herdr?.agent_status,
				note: w?.status?.text ?? "",
				...classification,
			});
		}
		for (const it of home.backlog.queued) {
			const note = blockedNote(it.desc);
			const waitingOn = note.startsWith("blocked-by ") ? note.slice("blocked-by ".length) : "";
			tasks.push({
				id: it.id,
				state: "queued",
				owner,
				project: parseProject(it.desc),
				note,
				classification: waitingOn ? "waiting" : "queued",
				evidence: waitingOn ? `waiting on ${waitingOn}` : "ready next priority",
			});
		}
		for (const it of home.backlog.done) {
			const merged = it.resolved || (it.pr ? prByUrl.get(it.pr)?.state === "MERGED" : false);
			const note = merged ? "merged" : it.pr ? "open PR" : "done";
			tasks.push({
				id: it.id,
				state: "done",
				owner,
				project: parseProject(it.desc),
				note,
				pr: it.pr,
				merged,
				classification: "complete",
				evidence: merged ? "completed and merged" : it.pr ? "completion waiting on PR" : "completed",
				nextPriority: merged || !it.pr ? nextReady?.id : undefined,
			});
		}
	}

	const otherLivePanes: LivePane[] = herdrAll
		.filter(h => h.pane_id && !usedPanes.has(h.pane_id))
		.map(h => ({
			name: h.name || (h.cwd ? basename(h.cwd) : h.pane_id || "?"),
			status: h.agent_status || "unknown",
			cwd: h.cwd ? basename(h.cwd) : "",
		}));

	return { generatedAt: now, pending, mates, tasks, otherLivePanes, notes };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

// Visual vocabulary in ONE place: geometric status glyphs (load-bearing runtime
// literals; ASCII source via \u escapes). Glyphs, not color, carry every signal -
// color is never assumed (the notify surface is not a TTY) and would never be the
// sole carrier anyway, so the board stays readable and colorblind-safe.
const GLYPH = {
	working: "\u25cf", // filled circle
	idle: "\u25cb", // hollow circle
	done: "\u2713", // check - done / review-ready
	blocked: "\u2717", // ballot x - needs the captain
	none: "\u00b7", // middot - unknown / dormant / no signal
} as const;
const RULE = "\u2500";
const ELLIPSIS = "\u2026";

const BOARD_WIDTH = 70;
const TIME_WIDTH = 20;
const LABEL_MAX = 30; // clip names so a long one never breaks the layout
const MAX_DONE = 6; // recent done tasks shown on the board

export type BridgeView = "roster" | "tasks" | "all";

/** Collapse whitespace and clip to n code points (never splits a surrogate pair). */
function truncate(s: string, n: number): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	const cps = [...oneLine];
	return cps.length > n ? `${cps.slice(0, n - 1).join("")}${ELLIPSIS}` : oneLine;
}

/** Captain's LOCAL time: "2026-06-28T22:31:10.207Z" -> "2026-06-28 15:31 PDT". */
function fmtTime(iso: string): string {
	const d = new Date(iso);
	const p2 = (n: number): string => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
	let tz = "";
	try {
		tz = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(d).find(x => x.type === "timeZoneName")?.value ?? "";
	} catch {
		tz = "";
	}
	return tz ? `${stamp} ${tz}` : stamp;
}

/** Live status -> glyph: prefer the status line, fall back to herdr presence. */
function statusGlyph(state?: string, herdr?: string): string {
	const s = (state || herdr || "").toLowerCase();
	if (s === "blocked" || s === "failed" || s === "needs-decision") return GLYPH.blocked;
	if (s === "working") return GLYPH.working;
	if (s === "done") return GLYPH.done;
	if (s === "idle") return GLYPH.idle;
	return GLYPH.none;
}

/** Pending class -> glyph: x for CAPTAIN-BLOCKED (4), check for REVIEW-READY (3). */
function classGlyph(rank: number): string {
	return rank >= 4 ? GLYPH.blocked : rank === 3 ? GLYPH.done : GLYPH.none;
}

/** 4-wide left "signal" column: the status glyph reads as a vertical strip. */
function gutter(g: string): string {
	return ` ${g}  `;
}

function emitHeader(out: string[], snap: FleetSnapshot): void {
	out.push(`${"FLEET BRIDGE".padEnd(BOARD_WIDTH - TIME_WIDTH)}${fmtTime(snap.generatedAt).padStart(TIME_WIDTH)}`);
	out.push(RULE.repeat(BOARD_WIDTH));
}

/** NEEDS YOU: fm-focus's ranked attention list (the urgent cross-cut, in every view). */
function emitNeedsYou(out: string[], snap: FleetSnapshot): void {
	out.push("");
	out.push("NEEDS YOU");
	if (snap.mates.length === 0) {
		out.push("  fleet NOT read - could not locate the firstmate home (see notes)");
	} else if (snap.pending.length === 0) {
		out.push(`${gutter(GLYPH.done)}all clear`);
	} else {
		for (const p of snap.pending) {
			const who = truncate(`${p.home}/${p.id}`, 22).padEnd(22);
			out.push(`${gutter(classGlyph(p.clsRank))}${who} ${truncate(p.reason, BOARD_WIDTH - 27)}`);
		}
	}
}

/** CREW: the persistent named mates you reach out to - presence + load, no tasks. */
function emitRoster(out: string[], snap: FleetSnapshot): void {
	if (snap.mates.length === 0) return;
	out.push("");
	out.push("CREW");
	for (const m of snap.mates) {
		const role = m.role === "firstmate" ? "(you talk to this one)" : "secondmate";
		const load = m.load > 0 ? `${m.load} in flight` : "free";
		// Clip the name to the width left after gutter + role + load, so the row
		// (with its right-aligned load) can never exceed BOARD_WIDTH.
		const nameBudget = Math.max(6, Math.min(LABEL_MAX, BOARD_WIDTH - 7 - role.length - load.length));
		const left = `${gutter(statusGlyph(undefined, m.herdrStatus))}${truncate(m.name, nameBudget)}  ${role}`;
		const pad = Math.max(1, BOARD_WIDTH - [...left].length - load.length);
		out.push(`${left}${" ".repeat(pad)}${load}`);
	}
}

function emitTaskRow(out: string[], t: TaskRow): void {
	const cls = t.classification;
	const g = cls === "blocked" || cls === "stale" ? GLYPH.blocked
		: cls === "active" ? GLYPH.working
			: cls === "waiting" ? GLYPH.idle
				: cls === "complete" ? GLYPH.done
					: t.state === "done" ? GLYPH.done : GLYPH.none;
	const label = cls === "active" ? "ACTIVE"
		: cls === "waiting" ? "WAIT"
			: cls === "blocked" ? "BLOCKED"
				: cls === "stale" ? "STALE"
					: cls === "complete" ? "DONE" : "NEXT";
	const project = t.project && t.project !== t.owner ? truncate(t.project, 12) : "";
	const head = `${gutter(g)}${truncate(t.id, 20).padEnd(20)} ${project.padEnd(12)} ${truncate(t.owner, 10).padEnd(10)} `;
	const detail = [`${label}: ${t.evidence || t.note}`];
	if (t.nextAction) detail.push(`next: ${t.nextAction}`);
	if (t.nextPriority) detail.push(`next priority: ${t.nextPriority}`);
	const detailText = detail.join("; ");
	const avail = BOARD_WIDTH - [...head].length;
	out.push(head + (avail >= 8 ? truncate(detailText, avail) : ""));
	if ([...detailText].length > avail) out.push(`${gutter(GLYPH.none)}${truncate(detailText, BOARD_WIDTH - 4)}`);
}

/** TASKS: every task, grouped by state (the volume lens, scales past the roster). */
function emitTaskBoard(out: string[], snap: FleetSnapshot): void {
	const groups: { label: string; state: BacklogSection; cap?: number }[] = [
		{ label: "IN FLIGHT", state: "inflight" },
		{ label: "QUEUED", state: "queued" },
		{ label: "DONE", state: "done", cap: MAX_DONE },
	];
	for (const grp of groups) {
		const all = snap.tasks.filter(t => t.state === grp.state);
		const shown = grp.cap ? all.slice(0, grp.cap) : all;
		out.push("");
		out.push(`${grp.label} (${all.length})`);
		if (all.length === 0) {
			out.push("  none");
			continue;
		}
		for (const t of shown) emitTaskRow(out, t);
		if (grp.cap && all.length > grp.cap) out.push(`     (+${all.length - grp.cap} more)`);
	}
}

function emitOtherPanes(out: string[], snap: FleetSnapshot): void {
	if (snap.otherLivePanes.length === 0) return;
	out.push("");
	out.push("OTHER PANES");
	for (const p of snap.otherLivePanes) out.push(`${gutter(statusGlyph(undefined, p.status))}${truncate(p.name, LABEL_MAX)}`);
}

function emitNotes(out: string[], snap: FleetSnapshot): void {
	if (snap.notes.length === 0) return;
	out.push("");
	out.push("NOTES");
	for (const n of snap.notes) out.push(`  ${truncate(n, BOARD_WIDTH - 2)}`);
}

/**
 * Render the fleet board for a view. A left status-glyph column is the through-line:
 *  - "roster" (default): NEEDS YOU + the persistent CREW + other panes.
 *  - "tasks": NEEDS YOU + the full task board, grouped by state.
 *  - "all": both lenses together.
 * Status rides on glyphs, never color.
 */
export function render(snap: FleetSnapshot, view: BridgeView = "roster"): string {
	const out: string[] = [];
	emitHeader(out, snap);
	emitNeedsYou(out, snap);
	if (view === "roster" || view === "all") emitRoster(out, snap);
	if (view === "tasks" || view === "all") emitTaskBoard(out, snap);
	if (view === "roster" || view === "all") emitOtherPanes(out, snap);
	emitNotes(out, snap);
	return out.join("\n").replace(/\n+$/, "");
}
