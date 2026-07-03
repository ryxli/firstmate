// Edge-dense computation built to make STRONG models fail: implement semver range satisfaction
// exactly per the spec, including the subtle prerelease-range rule that the obvious numeric
// implementation gets wrong. A hidden held-out set hits prerelease ordering, ^0.x / ^0.0.x special
// cases, and the "a prerelease version only satisfies a comparator that itself carries a prerelease
// at the same major.minor.patch" rule. Getting EVERY case right (all-or-nothing) is hard; the
// disciplined path (read the spec, test the edges) beats the one that ships the obvious version.
//
// Ground truth is a HARDCODED expected table derived from the semver spec (not from any single
// implementation), and the oracle's reference implementation is gate-checked against that table, so
// the pinning is an independent cross-check, not a tautology.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GoalResult, type ProcResult, type Scenario, type Trace, goalResult, procResult, toolCall, trace } from "../types.ts";

const RULES = `# semver range satisfaction
Implement \`satisfies(version, spec) -> bool\` in semver.py. A version is "MAJOR.MINOR.PATCH" with an
optional "-prerelease" (dot-separated identifiers). A spec is a whitespace-separated set of
comparators, ALL of which must hold. Comparators:
  =X.Y.Z (or bare X.Y.Z)  exact equality (including prerelease)
  >X.Y.Z  >=X.Y.Z  <X.Y.Z  <=X.Y.Z
  ^X.Y.Z  compatible: >=X.Y.Z and < the next non-zero-left segment bump:
          ^1.2.3 -> >=1.2.3 <2.0.0 ; ^0.2.3 -> >=0.2.3 <0.3.0 ; ^0.0.3 -> >=0.0.3 <0.0.4
  ~X.Y.Z  >=X.Y.Z <X.(Y+1).0
Precedence: compare major, minor, patch numerically. A version WITH a prerelease is LOWER than the
same version without one. Prerelease identifiers compare left to right: numeric identifiers compare
numerically; identifiers with letters compare by ASCII; a numeric identifier is LOWER than an
alphanumeric one; if all shared identifiers are equal, more identifiers is HIGHER.
PRERELEASE RULE: a version that has a prerelease may satisfy the spec ONLY IF at least one
comparator in the spec ALSO has a prerelease AND the same major.minor.patch. Otherwise that version
does not satisfy the spec, even when it falls numerically inside the range.
`;

const STUB = `def satisfies(version, spec):
    """Return True iff \`version\` satisfies \`spec\` per SEMVER_RULES.md."""
    raise NotImplementedError
`;

// check.py: a few VISIBLE basic cases (the held-out set is hidden in the grader)
const CHECK = `from semver import satisfies
assert satisfies("1.2.3", "^1.2.0") is True
assert satisfies("2.0.0", "^1.2.0") is False
assert satisfies("1.2.5", "~1.2.3") is True
print("basic checks pass")
`;

// hardcoded expected table derived from the semver spec (independent of any implementation)
const HELDOUT: Array<[string, string, boolean]> = [
	["1.2.3", "^1.2.0", true], ["2.0.0", "^1.2.0", false],
	["1.2.5", "~1.2.3", true], ["1.3.0", "~1.2.3", false], ["1.2.0", "~1.2.3", false],
	["0.2.9", "^0.2.3", true], ["0.3.0", "^0.2.3", false],
	["0.0.3", "^0.0.3", true], ["0.0.4", "^0.0.3", false],
	["1.0.0-alpha", "<1.0.0", false], // prerelease rule: range has no prerelease
	["1.0.0-alpha", "<1.0.0-beta", true], ["1.0.0-beta", "<1.0.0-alpha", false],
	["1.0.0-alpha.1", ">1.0.0-alpha", true],
	["1.2.3-rc.1", "^1.2.0", false], // prerelease rule: in range numerically but excluded
	["1.2.0-rc.1", "^1.2.0-rc.1", true],
	["1.2.3", "1.2.3", true], ["1.2.4", "1.2.3", false],
	["1.0.0", ">=1.0.0 <2.0.0", true], ["1.0.0-alpha", ">=1.0.0-alpha <2.0.0", true],
	["1.0.0-alpha.beta", ">1.0.0-alpha.1", true],
];

const SOLUTION = String.raw`import re

def _parse(v):
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$", v.strip())
    if not m:
        raise ValueError(v)
    pre = m.group(4).split(".") if m.group(4) else None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), pre)

def _cmp_pre(a, b):
    for x, y in zip(a, b):
        xn, yn = x.isdigit(), y.isdigit()
        if xn and yn:
            c = (int(x) > int(y)) - (int(x) < int(y))
        elif xn and not yn:
            c = -1
        elif yn and not xn:
            c = 1
        else:
            c = (x > y) - (x < y)
        if c:
            return c
    return (len(a) > len(b)) - (len(a) < len(b))

def _cmp(v1, v2):
    for i in range(3):
        if v1[i] != v2[i]:
            return -1 if v1[i] < v2[i] else 1
    p1, p2 = v1[3], v2[3]
    if p1 is None and p2 is None:
        return 0
    if p1 is None:
        return 1
    if p2 is None:
        return -1
    return _cmp_pre(p1, p2)

def _expand_one(part):
    m = re.match(r"^(\^|~|>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$", part)
    if not m:
        raise ValueError(part)
    op = m.group(1) or "="
    t = _parse(m.group(2))
    if op == "^":
        maj, mn, pat, _ = t
        if maj > 0:
            hi = (maj + 1, 0, 0, None)
        elif mn > 0:
            hi = (0, mn + 1, 0, None)
        else:
            hi = (0, 0, pat + 1, None)
        return [(">=", t), ("<", hi)]
    if op == "~":
        maj, mn, pat, _ = t
        return [(">=", t), ("<", (maj, mn + 1, 0, None))]
    return [(op, t)]

def _expand(spec):
    comps = []
    for part in spec.split():
        comps.extend(_expand_one(part))
    return comps

def _ok(c, op):
    return {"=": c == 0, ">=": c >= 0, ">": c > 0, "<=": c <= 0, "<": c < 0}[op]

def satisfies(version, spec):
    v = _parse(version)
    comps = _expand(spec)
    for op, t in comps:
        if not _ok(_cmp(v, t), op):
            return False
    if v[3] is not None:
        if not any(t[3] is not None and t[:3] == v[:3] for _op, t in comps):
            return False
    return True
`;

// Python literal of the held-out table, embedded into the grading driver just like the
// Python source did with `%r` (independent of any submitted implementation).
const CASES = `[${HELDOUT.map(([v, s, e]) => `('${v}', '${s}', ${e ? "True" : "False"})`).join(", ")}]`;

const DRIVER = `import sys
from semver import satisfies
cases = ${CASES}
ok = 0
for ver, spec, exp in cases:
    try:
        got = satisfies(ver, spec)
    except Exception:
        got = None
    if got is exp or got == exp:
        ok += 1
print(ok, len(cases))
`;

function setup(d: string): void {
	writeFileSync(join(d, "SEMVER_RULES.md"), RULES);
	writeFileSync(join(d, "semver.py"), STUB);
	writeFileSync(join(d, "check.py"), CHECK);
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
	return goalResult(ok === n, Math.round((ok / n) * 1000) / 1000, `${ok}/${n} held-out semver cases correct`);
}

function procedural(d: string): ProcResult {
	const rulesOk = readFileSync(join(d, "SEMVER_RULES.md"), "utf8") === RULES;
	const checkOk = readFileSync(join(d, "check.py"), "utf8") === CHECK;
	const code = readFileSync(join(d, "semver.py"), "utf8");
	// anti-overfit: didn't hardcode the held-out cases as a lookup table
	let leaked = 0;
	for (const [ver, spec] of HELDOUT) {
		if (code.includes(`"${ver}"`) && code.includes(`"${spec}"`)) leaked++;
	}
	const ok = rulesOk && checkOk && leaked === 0;
	return procResult(ok, `rules_unchanged=${rulesOk} check_unchanged=${checkOk} hardcoded_cases=${leaked}`);
}

function oracle(d: string): Trace {
	writeFileSync(join(d, "semver.py"), SOLUTION);
	return trace(true, 260, 4, [toolCall("read", "SEMVER_RULES.md"), toolCall("read", "check.py"), toolCall("edit", "semver.py")], "implemented semver satisfies");
}

export const SCENARIOS: Scenario[] = [
	{
		id: "hard-semver-satisfy",
		difficulty: "aspirational",
		task: "Implement satisfies(version, spec) in semver.py so it correctly decides semver range satisfaction for ALL inputs per SEMVER_RULES.md, including prerelease precedence and range edge cases. `python3 check.py` shows a few basic cases. Do NOT modify check.py or SEMVER_RULES.md. Then stop.",
		setup,
		goal,
		procedural,
		oracle,
		leakMarkers: ["def _cmp_pre", "t[:3] == v[:3]", "next non-zero-left"],
	},
];
