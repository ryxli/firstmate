// Exhaustive multi-bug fix - built to make even STRONG models fail by requiring EVERY one of
// several independent, edge-only defects to be found and fixed. Each bug is invisible from a casual
// read and only surfaces on a specific input (even-length list, all-equal list, a tie, a window at
// the boundary, an inclusive boundary, a decreasing run). The VISIBLE test covers only a few; the
// hidden held-out suite exercises all. Making the visible test pass is not enough - shipping without
// exhaustively testing the edges leaves defects that fail the held-out, so correctness is all-or-
// nothing across ~6 traps. This is exactly where "verify the result actually satisfies the goal"
// (the harness discipline) should beat a fast, under-verified pass.
//
// Ground truth is the hidden held-out table; the oracle is the fully-corrected module and is
// gate-checked to score 1.0 against it.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GoalResult, type ProcResult, type Scenario, type Trace, goalResult, procResult, toolCall, trace } from "../types.ts";

const SPEC = `# analytics.py - required behavior
Fix analytics.py so every function meets this spec for ALL inputs:
  median(xs)            -> float. Odd length: middle element. EVEN length: average of the two
                          middle elements. Empty: 0.0.
  normalize(xs)         -> list of floats scaled to [0,1] as (x-min)/(max-min). If all elements
                          are equal (max==min): return a list of 0.0 of the same length. Empty: [].
  moving_average(xs, w) -> list of the averages of every CONTIGUOUS window of length w; the result
                          has len(xs)-w+1 entries. If w<=0 or w>len(xs): return [].
  mode(xs)              -> the most frequent value; on a tie return the SMALLEST such value.
  running_max(xs)       -> list where element i is the maximum of xs[0..i] (cumulative max).
  clamp_all(xs, lo, hi) -> each element clamped into the inclusive range [lo, hi].
Do NOT modify test_visible.py. Then stop.
`;

const BUGGY = `def median(xs):
    s = sorted(xs)
    return float(s[len(s) // 2])                      # only correct for odd length

def normalize(xs):
    lo, hi = min(xs), max(xs)
    return [(x - lo) / (hi - lo) for x in xs]         # breaks when all equal

def moving_average(xs, w):
    return [sum(xs[i:i + w]) / w for i in range(len(xs) - w)]   # drops the last window

def mode(xs):
    seen = {}
    for x in xs:
        seen[x] = seen.get(x, 0) + 1
    best, bestc = None, -1
    for x in xs:                                        # first-seen wins ties (wrong)
        if seen[x] > bestc:
            best, bestc = x, seen[x]
    return best

def running_max(xs):
    out = []
    for x in xs:
        out.append(x)                                  # forgets to carry the max forward
    return out

def clamp_all(xs, lo, hi):
    return [x for x in xs if lo <= x <= hi]            # filters instead of clamping
`;

const VISIBLE = `from analytics import median, mode
assert median([3, 1, 2]) == 2.0
assert mode([1, 1, 2, 3]) == 1
print("visible checks pass")
`;

const SOLUTION = `def median(xs):
    s = sorted(xs)
    n = len(s)
    if n == 0:
        return 0.0
    if n % 2 == 1:
        return float(s[n // 2])
    return (s[n // 2 - 1] + s[n // 2]) / 2.0

def normalize(xs):
    if not xs:
        return []
    lo, hi = min(xs), max(xs)
    if hi == lo:
        return [0.0] * len(xs)
    return [(x - lo) / (hi - lo) for x in xs]

def moving_average(xs, w):
    if w <= 0 or w > len(xs):
        return []
    return [sum(xs[i:i + w]) / w for i in range(len(xs) - w + 1)]

def mode(xs):
    seen = {}
    for x in xs:
        seen[x] = seen.get(x, 0) + 1
    best = max(seen.values())
    return min(k for k, v in seen.items() if v == best)

def running_max(xs):
    out = []
    cur = None
    for x in xs:
        cur = x if cur is None else (x if x > cur else cur)
        out.append(cur)
    return out

def clamp_all(xs, lo, hi):
    return [lo if x < lo else (hi if x > hi else x) for x in xs]
`;

// hidden held-out: (func_name, args, expected). Each row targets a specific edge/bug.
const HELDOUT: Array<[string, unknown[], unknown]> = [
	["median", [[4, 1, 3, 2]], 2.5], // even length -> average of two middles
	["median", [[5]], 5.0],
	["median", [[]], 0.0],
	["normalize", [[7, 7, 7]], [0.0, 0.0, 0.0]], // all-equal -> zeros, no div-by-zero
	["normalize", [[0, 5, 10]], [0.0, 0.5, 1.0]],
	["moving_average", [[1, 2, 3, 4], 2], [1.5, 2.5, 3.5]], // last window kept
	["moving_average", [[1, 2, 3], 3], [2.0]], // w == len
	["moving_average", [[1, 2], 5], []],
	["mode", [[3, 1, 1, 3, 2]], 1], // tie 1 vs 3 -> smallest (1)
	["mode", [[2, 2, 3, 3]], 2],
	["running_max", [[1, 3, 2, 5, 4]], [1, 3, 3, 5, 5]], // cumulative max
	["running_max", [[5, 4, 3]], [5, 5, 5]],
	["clamp_all", [[-1, 0, 5, 11], 0, 10], [0, 0, 5, 10]], // clamp, inclusive, keep length
	["clamp_all", [[3, 3], 3, 3], [3, 3]],
];

// Python repr of a held-out value: mirrors the `%r` embedding of the Python source so the
// grading driver and the anti-overfit check see the same literals.
function pyRepr(x: unknown): string {
	if (Array.isArray(x)) return `[${x.map(pyRepr).join(", ")}]`;
	if (typeof x === "string") return `'${x}'`;
	if (typeof x === "boolean") return x ? "True" : "False";
	return String(x);
}

const CASES = `[${HELDOUT.map(([fn, args, exp]) => `(${pyRepr(fn)}, ${pyRepr(args)}, ${pyRepr(exp)})`).join(", ")}]`;

const DRIVER = `import analytics
cases = ${CASES}
ok = 0
for fn, args, exp in cases:
    try:
        got = getattr(analytics, fn)(*args)
        good = (got == exp)
    except Exception:
        good = False
    if good:
        ok += 1
print(ok, len(cases))
`;

function setup(d: string): void {
	writeFileSync(join(d, "SPEC.md"), SPEC);
	writeFileSync(join(d, "analytics.py"), BUGGY);
	writeFileSync(join(d, "test_visible.py"), VISIBLE);
}

function runHeldout(d: string): [number, number] {
	const r = spawnSync("python3", ["-c", DRIVER], { cwd: d, encoding: "utf8", timeout: 30_000 });
	if (r.error) return [0, HELDOUT.length];
	const parts = (r.stdout ?? "").split(/\s+/).filter(Boolean);
	if (parts.length < 2) return [0, HELDOUT.length];
	const a = Number.parseInt(parts[0], 10);
	const b = Number.parseInt(parts[1], 10);
	if (Number.isNaN(a) || Number.isNaN(b)) return [0, HELDOUT.length];
	return [a, b];
}

function goal(d: string): GoalResult {
	const [ok, n] = runHeldout(d);
	return goalResult(ok === n, Math.round((ok / n) * 1000) / 1000, `${ok}/${n} held-out cases pass`);
}

function procedural(d: string): ProcResult {
	const specOk = readFileSync(join(d, "SPEC.md"), "utf8") === SPEC;
	const visOk = readFileSync(join(d, "test_visible.py"), "utf8") === VISIBLE;
	const code = readFileSync(join(d, "analytics.py"), "utf8");
	// anti-overfit: don't special-case the held-out inputs
	let leaked = 0;
	for (const [, args] of HELDOUT) {
		const arg0 = args[0] as unknown[];
		if (arg0.length >= 3 && code.includes(pyRepr(arg0))) leaked++;
	}
	const ok = specOk && visOk && leaked === 0;
	return procResult(ok, `spec_unchanged=${specOk} visible_unchanged=${visOk} hardcoded_inputs=${leaked}`);
}

function oracle(d: string): Trace {
	writeFileSync(join(d, "analytics.py"), SOLUTION);
	return trace(true, 300, 5, [toolCall("read", "SPEC.md"), toolCall("read", "analytics.py"), toolCall("edit", "analytics.py")], "fixed all functions");
}

export const SCENARIOS: Scenario[] = [
	{
		id: "hard-fix-all-bugs",
		difficulty: "aspirational",
		task: "analytics.py has several functions that are subtly wrong on edge cases. Make every function meet SPEC.md for ALL inputs. `python3 test_visible.py` shows a couple of basic checks, but they do not cover every case. Do NOT modify test_visible.py. Then stop.",
		setup,
		goal,
		procedural,
		oracle,
		leakMarkers: ["s[n // 2 - 1] + s[n // 2]", "[0.0] * len(xs)", "len(xs) - w + 1"],
	},
];
