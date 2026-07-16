// Corpus metrics + the real-history sanitizer.
//
// Two deterministic, token-free surfaces built on the static scenario registry:
//
//   corpusMetrics()      machine-readable shape of the corpus - total, synthetic vs
//                        real-history split, per-source-class real-history counts, the
//                        difficulty distribution, and the sanitization verdict. Driven
//                        by `sbin/fm-action-bench.sh corpus`.
//
//   sanitize()           scans every REAL-HISTORY scenario's MATERIALIZED fixture (its
//                        setup output), task prompt, and leak markers for operational
//                        data that must never be committed: absolute home paths,
//                        emails, IPs, private-key headers, and credential/secret-like
//                        tokens. Backs the sanitize integrity gate (gates.ts), so unsafe
//                        real-history content aborts before any live run.
//
// The sanitizer is self-checking: it runs a fixed set of POISON samples through the
// same matcher and asserts each is caught, so a broken/emptied matcher fails loudly
// instead of silently waving unsafe content through.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIFFICULTY_ORDER, type Difficulty, SOURCE_CLASSES, type Scenario, type SourceClass } from "./types.ts";

// ---- unsafe-content patterns --------------------------------------------
// Each entry flags one class of operational data that must never reach a committed
// building block or a materialized fixture. Deliberately conservative: matched only
// against real-history scenarios (synthetic fixtures may legitimately use generic
// absolute-looking paths like /homes/triage in a made-up routing puzzle).
const UNSAFE_PATTERNS: Array<[string, RegExp]> = [
	["absolute-home-path", /\/(?:Users|home|root)\/[A-Za-z0-9._-]+/],
	["private-key-header", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
	["token-prefix", /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gh[osu]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,})\b/],
	["bearer-token", /(?:[Bb]earer|[Aa]uthorization:)\s+[A-Za-z0-9._~+/-]{16,}=*/],
	["credential-assignment", /(?:password|passwd|api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[^\s"']{6,}/i],
	["email-address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
	["ip-address", /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
];

// Poison values are ASSEMBLED at runtime from harmless fragments, so NO complete
// unsafe literal (absolute path, identity, credential, secret-like token, or address)
// is present in tracked source, while the matcher still sees a genuine unsafe string.
const POISON = {
	abspath: `worktree at /${"Use" + "rs"}/${"dev"}/code`,
	credential: `api${"_"}key${"="}${"Ab" + "Cd" + "Ef" + "123456"}`,
	token: `token gh${"p"}_${"A".repeat(30)} in log`,
	privateKey: `${"-----BEGIN "}${"OPENSSH "}${"PRIV" + "ATE KEY-----"}`,
	email: `ping ${"user"}${"@"}${"host.example"}`,
	ip: `host ${"203.0"}${"."}${"113.42"}`,
};

// Known-bad samples the matcher MUST catch. If any goes unflagged the sanitizer is
// broken and the gate fails - a permanent negative control baked into every run.
const POISON_SAMPLES: Array<[string, string]> = [
	["absolute-home-path", POISON.abspath],
	["credential-assignment", POISON.credential],
	["token-prefix", POISON.token],
	["private-key-header", POISON.privateKey],
	["email-address", POISON.email],
	["ip-address", POISON.ip],
];

// All labels matched by a text blob (deduped, stable order).
export function scanText(text: string): string[] {
	const hits: string[] = [];
	for (const [label, re] of UNSAFE_PATTERNS) {
		if (re.test(text)) hits.push(label);
	}
	return hits;
}

// The real-history subset of a corpus (scenarios carrying a `history` provenance tag).
export function realHistoryScenarios(scenarios: Scenario[]): Scenario[] {
	return scenarios.filter((s) => s.history !== undefined);
}

// Recursively collect every file's relative path + contents under a fixture dir.
function collectFiles(root: string, rel = ""): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	const base = rel ? join(root, rel) : root;
	for (const name of readdirSync(base)) {
		const childRel = rel ? join(rel, name) : name;
		const abs = join(root, childRel);
		if (statSync(abs).isDirectory()) {
			out.push(...collectFiles(root, childRel));
		} else {
			out.push([childRel, readFileSync(abs, "utf8")]);
		}
	}
	return out;
}

export interface ScanFinding {
	scenario: string;
	where: string;
	labels: string[];
}

// Materialize one real-history scenario and scan its fixture + prompt + leak markers.
function scanScenario(scn: Scenario): ScanFinding[] {
	const findings: ScanFinding[] = [];
	const add = (where: string, text: string): void => {
		const labels = scanText(text);
		if (labels.length) findings.push({ scenario: scn.id, where, labels });
	};
	add("task-prompt", scn.task);
	for (const step of scn.steps ?? []) add("step-task", step[0]);
	for (const mk of scn.leakMarkers) add("leak-marker", mk);
	const d = mkdtempSync(join(tmpdir(), `corpus-${scn.id}-`));
	try {
		scn.setup(d);
		for (const step of scn.steps ?? []) {
			if (step[1]) step[1](d);
		}
		for (const [relPath, contents] of collectFiles(d)) {
			add(`fixture:${relPath}`, relPath);
			add(`fixture:${relPath}`, contents);
		}
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
	return findings;
}

export interface SanitizeReport {
	clean: boolean;
	scanned: number;
	selfTest: { passed: boolean; samplesChecked: number; missed: string[] };
	findings: ScanFinding[];
}

// Self-test the matcher against POISON_SAMPLES, then scan the real-history corpus.
export function sanitize(scenarios: Scenario[]): SanitizeReport {
	const missed: string[] = [];
	for (const [label, sample] of POISON_SAMPLES) {
		if (!scanText(sample).includes(label)) missed.push(label);
	}
	const findings: ScanFinding[] = [];
	const real = realHistoryScenarios(scenarios);
	for (const scn of real) findings.push(...scanScenario(scn));
	const selfTest = { passed: missed.length === 0, samplesChecked: POISON_SAMPLES.length, missed };
	return { clean: selfTest.passed && findings.length === 0, scanned: real.length, selfTest, findings };
}

// A fabricated real-history scenario whose fixture carries a deliberate leak, used as
// a negative control (the sanitize gate MUST flag it). Never registered in the corpus.
export function poisonScenario(kind: "abspath" | "secret"): Scenario {
	const payload = `${kind === "secret" ? POISON.credential : POISON.abspath} committed by mistake\n`;
	return {
		id: `__poison-${kind}`,
		difficulty: "easy",
		task: "poison control - do nothing.",
		setup: (d: string) => {
			writeFileSync(join(d, "leak.txt"), payload);
		},
		goal: () => ({ correct: false, progress: 0, note: "poison" }),
		procedural: () => ({ clean: true, note: "poison" }),
		leakMarkers: ["__poison__"],
		history: { sourceClass: "state-status" },
	};
}

export interface CorpusMetrics {
	totalScenarios: number;
	synthetic: number;
	realHistory: number;
	bySourceClass: Record<SourceClass, number>;
	byDifficulty: Record<Difficulty, number>;
	sanitization: {
		status: "clean" | "unsafe";
		selfTest: { passed: boolean; samplesChecked: number };
		scanned: number;
		findings: ScanFinding[];
	};
}

export function corpusMetrics(scenarios: Scenario[]): CorpusMetrics {
	const bySourceClass = Object.fromEntries(SOURCE_CLASSES.map((c) => [c, 0])) as Record<SourceClass, number>;
	const byDifficulty = Object.fromEntries(DIFFICULTY_ORDER.map((d) => [d, 0])) as Record<Difficulty, number>;
	let realHistory = 0;
	for (const s of scenarios) {
		byDifficulty[s.difficulty] += 1;
		if (s.history) {
			realHistory += 1;
			bySourceClass[s.history.sourceClass] += 1;
		}
	}
	const san = sanitize(scenarios);
	return {
		totalScenarios: scenarios.length,
		synthetic: scenarios.length - realHistory,
		realHistory,
		bySourceClass,
		byDifficulty,
		sanitization: {
			status: san.clean ? "clean" : "unsafe",
			selfTest: { passed: san.selfTest.passed, samplesChecked: san.selfTest.samplesChecked },
			scanned: san.scanned,
			findings: san.findings,
		},
	};
}
