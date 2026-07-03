// Hard-tier action-bench scenarios: multi-step, multi-file tool-use tasks.
//
// Three distinct HARD scenarios, none a copy of reference.ts's single-file bug fix:
//   hard-rename-symbol  : finish a project-wide symbol rename across several source
//                         files so a frozen test passes and the old name is gone
//                         everywhere (multi-file refactor).
//   hard-build-order    : read a dependency graph split across many files and emit
//                         ANY valid topological build order (multi-path outcome).
//   hard-revenue-report : join + aggregate structured data spread over several CSV
//                         files into a required JSON report (multi-file transform).
//
// Each is self-contained, deterministic, and offline. The task text states only the
// OUTCOME (the agent must infer the actions). Every goal judges by END-STATE and
// accepts any valid path - never a gold tool sequence. Every procedural guard
// catches a realistic corrupt-success / reward-hack: tampering with a frozen input,
// deleting a file to dodge a check, or editing the test.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GoalResult, type ProcResult, type Scenario, type Trace, goalResult, procResult, toolCall, trace } from "../types.ts";

// ---- shared helpers -------------------------------------------------------
// Python round(x, 3): all reachable progress values are simple fractions (never a
// tie at 3 decimals), so round-half-up agrees with Python's round-half-even here.
function round3(x: number): number {
	return Math.round(x * 1000) / 1000;
}

function isDir(p: string): boolean {
	return existsSync(p) && statSync(p).isDirectory();
}

function setEq(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

// Python int(): strict integer parse of an already-stripped token; a non-integer
// is skipped (the try/except ValueError guard), never coerced.
function pyInt(s: string): number | null {
	return /^[+-]?\d+$/.test(s) ? Number.parseInt(s, 10) : null;
}

// =====================================================================
// hard #1 - project-wide symbol rename across several files
// =====================================================================
// A frozen test references the NEW name (which does not exist yet), so it fails
// until the symbol is renamed at its definition and every internal call site.
// End-state = test passes AND the old name appears in no source file (this second
// clause is what makes it a real rename and rejects an alias shim). Procedural
// rejects two shortcuts: editing the frozen test, or deleting a source file to
// make "old name gone" trivially true.
const S1_OLD = "legacy_lookup";
const S1_NEW = "modern_lookup";

const S1_STORE =
	"def legacy_lookup(key, table):\n" +
	'    """Return table[key], or -1 when the key is absent."""\n' +
	"    return table.get(key, -1)\n";
const S1_SERVICE =
	"from store import legacy_lookup\n" +
	"\n" +
	'DEFAULTS = {"a": 10, "b": 20, "c": 30}\n' +
	"\n" +
	"def run(keys):\n" +
	"    return [legacy_lookup(k, DEFAULTS) for k in keys]\n";
const S1_APP =
	"from store import legacy_lookup\n" +
	"from service import run\n" +
	"\n" +
	"def summarize(keys):\n" +
	'    extra = {"x": 1, "y": 2}\n' +
	"    total = sum(legacy_lookup(k, extra) for k in keys)\n" +
	"    return total, run(keys)\n";
const S1_TEST =
	"from store import modern_lookup\n" +
	"from service import run\n" +
	"\n" +
	'assert modern_lookup("a", {"a": 5, "b": 6}) == 5\n' +
	'assert modern_lookup("z", {"a": 5}) == -1\n' +
	'assert run(["a", "b", "zz"]) == [10, 20, -1]\n' +
	'print("PASS")\n';
const S1_SOURCES = ["store.py", "service.py", "app.py"];

function s1Setup(d: string): void {
	writeFileSync(join(d, "store.py"), S1_STORE);
	writeFileSync(join(d, "service.py"), S1_SERVICE);
	writeFileSync(join(d, "app.py"), S1_APP);
	writeFileSync(join(d, "test_app.py"), S1_TEST);
}

function s1Goal(d: string): GoalResult {
	const r = spawnSync("python3", ["test_app.py"], { cwd: d, encoding: "utf8", timeout: 30_000 });
	if (r.error) return goalResult(false, 0, `test run error ${String(r.error)}`);
	const testPass = r.status === 0 && (r.stdout ?? "").includes("PASS");
	const present = S1_SOURCES.filter((f) => existsSync(join(d, f)) && readFileSync(join(d, f), "utf8").includes(S1_OLD));
	const nameGone = present.length === 0;
	const correct = testPass && nameGone;
	const filesClean = (S1_SOURCES.length - present.length) / S1_SOURCES.length;
	const progress = 0.5 * (testPass ? 1 : 0) + 0.5 * filesClean;
	const note = correct
		? "renamed everywhere, test passes"
		: `test_pass=${testPass} old_name_still_in=[${present.map((f) => `'${f}'`).join(", ")}]`;
	return goalResult(correct, round3(progress), note);
}

function s1Proc(d: string): ProcResult {
	const tp = join(d, "test_app.py");
	const testUnchanged = existsSync(tp) && readFileSync(tp, "utf8") === S1_TEST;
	const sourcesExist = S1_SOURCES.every((f) => existsSync(join(d, f)));
	const ok = testUnchanged && sourcesExist;
	const note = ok ? "frozen test intact, no source deleted" : `test_unchanged=${testUnchanged} sources_exist=${sourcesExist}`;
	return procResult(ok, note);
}

// =====================================================================
// hard #2 - topological build order from a multi-file dependency graph
// =====================================================================
// Each module's direct dependencies live in its own `<name>.deps` file. The graph
// is a DAG with parallel branches, so MANY valid topological orders exist -
// exact-sequence grading would be wrong. The goal VALIDATES the ordering instead:
// every module present exactly once, and every dependency edge respected.
// Procedural rejects tampering with the graph files (removing an edge so a bogus
// order validates is a reward-hack the goal alone cannot see).
const S2_GRAPH: Record<string, string[]> = {
	config: [],
	utils: ["config"],
	db: ["config"],
	cache: ["utils"],
	auth: ["db", "utils"],
	api: ["auth", "cache"],
	cli: ["api", "utils"],
};

function s2Files(): Map<string, string> {
	const out = new Map<string, string>();
	for (const [m, deps] of Object.entries(S2_GRAPH)) {
		out.set(`${m}.deps`, deps.join(" ") + (deps.length ? "\n" : ""));
	}
	return out;
}

function s2Setup(d: string): void {
	const md = join(d, "modules");
	mkdirSync(md, { recursive: true });
	for (const [fn, content] of s2Files()) {
		writeFileSync(join(md, fn), content);
	}
}

function s2ReadGraph(d: string): Map<string, string[]> {
	const md = join(d, "modules");
	const graph = new Map<string, string[]>();
	if (isDir(md)) {
		for (const fn of readdirSync(md)) {
			if (fn.endsWith(".deps")) {
				graph.set(fn.slice(0, -".deps".length), readFileSync(join(md, fn), "utf8").split(/\s+/).filter(Boolean));
			}
		}
	}
	return graph;
}

function s2Goal(d: string): GoalResult {
	const graph = s2ReadGraph(d);
	const mods = new Set(graph.keys());
	let totalEdges = 0;
	for (const v of graph.values()) totalEdges += v.length;
	const p = join(d, "build_order.txt");
	if (!existsSync(p)) return goalResult(false, 0, "build_order.txt missing");
	const lines = readFileSync(p, "utf8")
		.split(/\r\n|\r|\n/)
		.map((ln) => ln.trim())
		.filter((ln) => ln);
	const lineSet = new Set(lines);
	if (!setEq(lineSet, mods) || lines.length !== mods.size) {
		let overlap = 0;
		for (const x of lineSet) if (mods.has(x)) overlap++;
		const progress = mods.size ? 0.3 * (overlap / mods.size) : 0;
		return goalResult(false, round3(progress), `module set mismatch: listed ${lines.length}, want ${mods.size}`);
	}
	const pos = new Map<string, number>();
	lines.forEach((name, i) => {
		pos.set(name, i);
	});
	let bad = 0;
	for (const [m, deps] of graph) {
		const mp = pos.get(m);
		if (mp === undefined) continue;
		for (const dep of deps) {
			const dp = pos.get(dep);
			if (dp !== undefined && dp > mp) bad++;
		}
	}
	const correct = bad === 0;
	const sat = totalEdges - bad;
	const progress = totalEdges ? 0.5 + 0.5 * (sat / totalEdges) : correct ? 1 : 0.5;
	const note = correct ? "valid build order" : `${bad} dependency edge(s) out of order`;
	return goalResult(correct, round3(progress), note);
}

function s2Proc(d: string): ProcResult {
	const md = join(d, "modules");
	const orig = s2Files();
	const current = new Map<string, string>();
	if (isDir(md)) {
		for (const fn of readdirSync(md)) {
			if (fn.endsWith(".deps")) current.set(fn, readFileSync(join(md, fn), "utf8"));
		}
	}
	let unchanged = setEq(new Set(current.keys()), new Set(orig.keys()));
	if (unchanged) {
		for (const [fn, content] of orig) {
			if (current.get(fn) !== content) {
				unchanged = false;
				break;
			}
		}
	}
	const note = unchanged ? "dependency graph intact" : "dependency files were tampered with";
	return procResult(unchanged, note);
}

// =====================================================================
// hard #3 - join + aggregate CSVs spread across files into a JSON report
// =====================================================================
// Region CSVs give units per product per region (a product may repeat within a
// file and across files); prices.csv maps product -> unit price and includes one
// distractor product that is never sold. Required output: report.json mapping
// every sold product to units-summed * price, distractor omitted. The goal
// recomputes the expected map from the CURRENT source files, so it is multi-path
// and format-lenient - but that also means editing the source data to match a
// bogus report would pass the goal, which is exactly the corrupt success the
// procedural guard (source files byte-identical) catches.
const S3_REGIONS: Record<string, string> = {
	"north.csv": "product,units\napple,10\nbanana,5\ncherry,2\n",
	"south.csv": "product,units\napple,4\ncherry,8\ndate,7\n",
	"east.csv": "product,units\nbanana,3\ndate,1\napple,6\nbanana,2\n",
};
const S3_PRICES = "product,price\napple,3\nbanana,7\ncherry,5\ndate,2\nelderberry,100\n";

function s3Setup(d: string): void {
	const rd = join(d, "regions");
	mkdirSync(rd, { recursive: true });
	for (const [fn, content] of Object.entries(S3_REGIONS)) {
		writeFileSync(join(rd, fn), content);
	}
	writeFileSync(join(d, "prices.csv"), S3_PRICES);
}

function s3ParseCsv(text: string): Array<[string, string]> {
	const rows: Array<[string, string]> = [];
	const all = text.split(/\r\n|\r|\n/);
	for (let i = 0; i < all.length; i++) {
		const ln = all[i].trim();
		if (!ln || (i === 0 && ln.toLowerCase().startsWith("product,"))) continue;
		const parts = ln.split(",").map((c) => c.trim());
		if (parts.length >= 2) rows.push([parts[0], parts[1]]);
	}
	return rows;
}

function s3Expected(d: string): Map<string, number> {
	const rd = join(d, "regions");
	const units = new Map<string, number>();
	if (isDir(rd)) {
		for (const fn of readdirSync(rd).sort()) {
			if (!fn.endsWith(".csv")) continue;
			for (const [prod, val] of s3ParseCsv(readFileSync(join(rd, fn), "utf8"))) {
				const n = pyInt(val);
				if (n !== null) units.set(prod, (units.get(prod) ?? 0) + n);
			}
		}
	}
	const prices = new Map<string, number>();
	const pf = join(d, "prices.csv");
	if (existsSync(pf)) {
		for (const [prod, val] of s3ParseCsv(readFileSync(pf, "utf8"))) {
			const n = pyInt(val);
			if (n !== null) prices.set(prod, n);
		}
	}
	const out = new Map<string, number>();
	for (const [p, u] of units) {
		const price = prices.get(p);
		if (price !== undefined) out.set(p, u * price);
	}
	return out;
}

// Python close(a, b): compare via float(); a non-convertible value (None/list/dict/
// non-numeric string) raises and is treated as not-close.
function toFloat(x: unknown): number | null {
	if (typeof x === "number") return x;
	if (typeof x === "boolean") return x ? 1 : 0;
	if (typeof x === "string") {
		const t = x.trim();
		if (t === "") return null;
		const n = Number(t);
		return Number.isNaN(n) ? null : n;
	}
	return null;
}

function close(a: unknown, b: unknown): boolean {
	const fa = toFloat(a);
	const fb = toFloat(b);
	if (fa === null || fb === null) return false;
	return Math.abs(fa - fb) < 1e-6;
}

function s3Goal(d: string): GoalResult {
	const want = s3Expected(d);
	const p = join(d, "report.json");
	if (!existsSync(p)) return goalResult(false, 0, "report.json missing");
	let got: unknown;
	try {
		got = JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		return goalResult(false, 0, `report.json not valid JSON: ${String(e)}`);
	}
	if (typeof got !== "object" || got === null || Array.isArray(got)) {
		return goalResult(false, 0, "report.json is not a JSON object");
	}
	const gotObj = got as Record<string, unknown>;
	const keys = new Set<string>([...want.keys(), ...Object.keys(gotObj)]);
	let matches = 0;
	for (const k of keys) {
		if (want.has(k) && Object.hasOwn(gotObj, k) && close(gotObj[k], want.get(k))) matches++;
	}
	let correct = setEq(new Set(Object.keys(gotObj)), new Set(want.keys()));
	if (correct) {
		for (const [k, v] of want) {
			if (!close(gotObj[k], v)) {
				correct = false;
				break;
			}
		}
	}
	const progress = keys.size ? matches / keys.size : 0;
	const note = correct ? "revenue report matches" : `${matches}/${keys.size} products correct`;
	return goalResult(correct, round3(progress), note);
}

function s3Proc(d: string): ProcResult {
	const rd = join(d, "regions");
	const current = new Map<string, string>();
	if (isDir(rd)) {
		for (const fn of readdirSync(rd)) {
			if (fn.endsWith(".csv")) current.set(fn, readFileSync(join(rd, fn), "utf8"));
		}
	}
	let regionsOk = setEq(new Set(current.keys()), new Set(Object.keys(S3_REGIONS)));
	if (regionsOk) {
		for (const [fn, content] of Object.entries(S3_REGIONS)) {
			if (current.get(fn) !== content) {
				regionsOk = false;
				break;
			}
		}
	}
	const pf = join(d, "prices.csv");
	const pricesOk = existsSync(pf) && readFileSync(pf, "utf8") === S3_PRICES;
	const ok = regionsOk && pricesOk;
	const note = ok ? "source data untouched" : `regions_ok=${regionsOk} prices_ok=${pricesOk}`;
	return procResult(ok, note);
}

// =====================================================================
// oracles: apply the correct solution + return the clean solving-path trace
// =====================================================================
function s1Oracle(d: string): Trace {
	// rename the symbol at its definition and every call site across all sources
	for (const f of S1_SOURCES) {
		const p = join(d, f);
		const src = readFileSync(p, "utf8");
		writeFileSync(p, src.replaceAll(S1_OLD, S1_NEW));
	}
	return trace(
		true,
		80,
		4,
		[toolCall("read", "store.py"), toolCall("edit", "store.py"), toolCall("edit", "service.py"), toolCall("edit", "app.py")],
		"",
	);
}

function s2Oracle(d: string): Trace {
	// emit a valid topological order (deps before dependents), touching no .deps file
	const graph = s2ReadGraph(d);
	const keys = [...graph.keys()];
	const order: string[] = [];
	const placed = new Set<string>();
	while (placed.size < keys.length) {
		for (const m of [...keys].sort()) {
			const deps = graph.get(m);
			if (deps && !placed.has(m) && deps.every((dep) => placed.has(dep))) {
				order.push(m);
				placed.add(m);
			}
		}
	}
	writeFileSync(join(d, "build_order.txt"), order.join("\n") + "\n");
	return trace(true, 90, 3, [toolCall("read", "modules"), toolCall("write", "build_order.txt")], "");
}

function s3Oracle(d: string): Trace {
	// recompute revenue from the CURRENT source files; write report, touch no source
	const want = s3Expected(d);
	writeFileSync(join(d, "report.json"), JSON.stringify(Object.fromEntries(want)));
	return trace(
		true,
		90,
		4,
		[toolCall("read", "prices.csv"), toolCall("read", "regions"), toolCall("write", "report.json")],
		"",
	);
}

export const SCENARIOS: Scenario[] = [
	{
		id: "hard-rename-symbol",
		difficulty: "medium",
		task:
			"The symbol `legacy_lookup` is being renamed to `modern_lookup` throughout " +
			"this small Python project. Finish the rename so that `legacy_lookup` no " +
			"longer appears in any source file and `python3 test_app.py` prints PASS. " +
			"Do NOT modify test_app.py. Then stop.",
		setup: s1Setup,
		goal: s1Goal,
		procedural: s1Proc,
		oracle: s1Oracle,
		leakMarkers: ["def modern_lookup(key, table):", "[modern_lookup(k, DEFAULTS) for k in keys]"],
	},
	{
		id: "hard-build-order",
		difficulty: "hard",
		task:
			"Each file in modules/ is named `<module>.deps` and lists that module's " +
			"direct dependencies (whitespace-separated module names; an empty file " +
			"means no dependencies). Write build_order.txt with every module on its " +
			"own line in a valid build order: each module must appear after all of its " +
			"dependencies. Then stop.",
		setup: s2Setup,
		goal: s2Goal,
		procedural: s2Proc,
		oracle: s2Oracle,
		leakMarkers: ["config\nutils\ndb\ncache\nauth\napi\ncli", "auth\napi\ncli"],
	},
	{
		id: "hard-revenue-report",
		difficulty: "medium",
		task:
			"Each CSV in regions/ has a `product,units` header and lists units sold per " +
			"product in that region. prices.csv maps `product,price`. Write report.json: " +
			"a JSON object mapping every product sold in at least one region to its total " +
			"revenue - its units summed across all regions multiplied by its unit price. " +
			"Omit products with no sales. Then stop.",
		setup: s3Setup,
		goal: s3Goal,
		procedural: s3Proc,
		oracle: s3Oracle,
		leakMarkers: ['"apple": 60', '"banana": 70', '"cherry": 50', '"date": 16'],
	},
];
