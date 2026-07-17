// fm verb: skill-census - read-only census of every skill instance this fleet
// touches: the shared template, each registered mate home's local skills, and
// machine-wide harness caches. Never writes anything, anywhere.
// Ported behavior-preserving out of the former sbin/fm skill-census, with
// the root/home resolution it sourced from sbin/fm-root-lib.sh inlined below.
//
// Surfaces enumerated:
//   template              <code-root>/.agents/skills/*/SKILL.md - the shared,
//                          tracked skill set every mate inherits.
//   mate:<id>:.agents      <home>/.agents/skills/*/SKILL.md for each home
//                          registered in data/secondmates.md.
//   mate:<id>:.claude      <home>/.claude/skills/*/SKILL.md for the same homes.
//   cache:omp-managed-skills   ~/.omp/agent/managed-skills/*/SKILL.md
//   cache:claude-skills        ~/.claude/skills/*/SKILL.md
//
// A mate-home entry is skipped (not emitted) when its SKILL.md resolves,
// through any chain of symlinks - whether the whole .agents/.claude directory
// is symlinked or just the individual skill entry - into the template's
// .agents/skills tree. That is the template surface reappearing through the
// home's symlink, not a real mate-local copy. Cache entries are never
// skipped this way: they are physical copies by construction.
//
// Optional mate-local frontmatter convention (3 extra scalar lines, all
// optional, meaningful only on a mate-local SKILL.md - a real, non-template
// copy a mate keeps for itself):
//   origin: <how this local copy came to exist, e.g. "copied from template">
//   date: <YYYY-MM-DD this local copy was last created or reviewed>
//   stale_when: <YYYY-MM-DD after which the copy should be re-reviewed>
//
// Disposition flags (exactly one per emitted row, in priority order):
//   expire                stale_when is a valid past date (checked first -
//                          a copy overdue for review is actionable no matter
//                          how it otherwise compares to the template)
//   merge                 exact duplicate of the template's same-named skill
//                          (identical SKILL.md content hash) - fold in, delete
//                          the copy
//   drift                 same name as a template skill, but a different
//                          content hash - an unregistered divergent copy
//   graduate-or-delete    cache-only: no template skill shares this name
//   healthy               unique mate-local skill: no template counterpart
//   template              the shared baseline row itself (informational only,
//                          not one of the five disposition flags above)
//
// Output: tab-separated rows to stdout, one per skill instance -
//   surface<TAB>name<TAB>sha256<TAB>description<TAB>origin<TAB>date<TAB>stale_when<TAB>disposition
// missing optional fields print as "-". A header row, a blank line, all
// instance rows, a blank line, then a "summary" section with a row count per
// disposition flag observed this run.
//
// --check: exit 1 if any row's disposition is "drift"; exit 0 otherwise.
// Output is identical in both modes - --check only changes the exit code.
//
// Degrades gracefully: a missing template dir, missing registry, missing
// mate home, missing cache dir, unreadable file, or absent frontmatter
// field is reported as empty/skipped, never a crash.
//
// Env overrides (mainly for tests):
//   FM_CODE_ROOT_OVERRIDE / FM_ROOT_OVERRIDE   template code root
//   FM_HOME / FM_DATA_OVERRIDE                 where data/secondmates.md lives
//   FM_SKILL_CACHE_OMP_OVERRIDE                  overrides ~/.omp/agent/managed-skills
//   FM_SKILL_CACHE_CLAUDE_OVERRIDE                overrides ~/.claude/skills
//   FM_SKILL_CENSUS_TODAY                      overrides "today" (YYYY-MM-DD)

import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Physical repo root (unaffected by any override), mirroring the original
// script's SCRIPT_DIR/.. (derived from BASH_SOURCE, not from any override).
const CANONICAL_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

const USAGE = "usage: fm skill-census [--check]\n";

// --- fs helpers -------------------------------------------------------------

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isReadable(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

// Subdirectory names directly under dir - mirrors bash nullglob "dir/*/ ",
// which matches directories and symlinks-that-resolve-to-directories.
function subDirNames(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names.filter(name => isDirectory(join(dir, name)));
}

// --- fm-root-lib.sh equivalents ---------------------------------------------

function fmRealpathExisting(path: string): string {
	if (!existsSync(path)) throw new Error(`not found: ${path}`);
	return realpathSync(path);
}

// Mirrors fm_normalize_path: physically resolve the longest existing prefix,
// then lexically apply any remaining (possibly nonexistent) path components.
function fmNormalizePath(path: string): string {
	const probe0 = isAbsolute(path) ? path : join(process.cwd(), path);
	if (existsSync(probe0)) return fmRealpathExisting(probe0);

	const tail: string[] = [];
	let probe = probe0;
	while (!existsSync(probe) && probe !== "/") {
		tail.unshift(basename(probe));
		probe = dirname(probe);
	}
	const prefix = existsSync(probe) ? fmRealpathExisting(probe) : "/";
	let out = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
	if (!out) out = "/";
	for (const component of tail) {
		if (component === "" || component === ".") continue;
		if (component === "..") {
			if (out !== "/") {
				const idx = out.lastIndexOf("/");
				out = idx > 0 ? out.slice(0, idx) : "/";
			}
		} else {
			out = out === "/" ? `/${component}` : `${out}/${component}`;
		}
	}
	return out;
}

// Mirrors fm_home_from_cwd: walk up from the physical cwd to the nearest
// AGENTS.md marker.
function fmHomeFromCwd(): string {
	let d = process.cwd();
	while (d && d !== "/") {
		if (existsSync(join(d, "AGENTS.md"))) return d;
		d = dirname(d);
	}
	return "";
}

function resolveCodeRoot(): string {
	const codeRootOverride = process.env.FM_CODE_ROOT_OVERRIDE;
	if (codeRootOverride) return fmRealpathExisting(codeRootOverride);
	const rootOverride = process.env.FM_ROOT_OVERRIDE;
	if (rootOverride) return fmRealpathExisting(rootOverride);
	return CANONICAL_ROOT;
}

function resolveHome(codeRootEffective: string): string {
	const fmHome = process.env.FM_HOME;
	if (fmHome) return fmNormalizePath(fmHome);
	const rootOverride = process.env.FM_ROOT_OVERRIDE;
	const codeRootOverride = process.env.FM_CODE_ROOT_OVERRIDE;
	if (rootOverride && !codeRootOverride) return fmNormalizePath(rootOverride);
	const fromCwd = fmHomeFromCwd();
	return fromCwd || codeRootEffective;
}

// --- SKILL.md parsing --------------------------------------------------------

function hashFile(path: string): string {
	if (!isReadable(path)) return "-";
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return "-";
	}
}

// Lines strictly between the first and second "---" delimiters, or [] if the
// file has no frontmatter block (first line isn't exactly "---").
function frontmatterBlock(path: string): string[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const lines = text.split("\n");
	if (lines[0] !== "---") return [];
	const out: string[] = [];
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "---") break;
		out.push(lines[i]);
	}
	return out;
}

function stripQuotes(s: string): string {
	let out = s;
	const dq = /^"(.*)"$/.exec(out);
	if (dq) out = dq[1];
	const sq = /^'(.*)'$/.exec(out);
	if (sq) out = sq[1];
	return out;
}

// First-line scalar value of a frontmatter field, quotes stripped, or "" if
// absent/unreadable.
function frontmatterField(path: string, field: string): string {
	const prefix = `${field}:`;
	for (const line of frontmatterBlock(path)) {
		if (line.startsWith(prefix)) {
			const rest = line.slice(prefix.length).replace(/^[ \t]*/, "");
			return stripQuotes(rest);
		}
	}
	return "";
}

function truncateDesc(s: string): string {
	const t = s.replace(/\t/g, " ");
	const max = 100;
	return t.length > max ? `${t.slice(0, max)}...` : t;
}

function isPastDate(d: string, today: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
	return d < today;
}

function todayString(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

interface Row {
	surface: string;
	name: string;
	hash: string;
	desc: string;
	origin: string;
	date: string;
	staleWhen: string;
	disposition: string;
}

function classify(
	surface: string,
	name: string,
	hash: string,
	staleWhen: string,
	today: string,
	templateHashes: Map<string, string>,
): string {
	if (staleWhen && isPastDate(staleWhen, today)) return "expire";
	const templateHash = templateHashes.get(name);
	if (templateHash) return templateHash === hash ? "merge" : "drift";
	if (surface.startsWith("mate:")) return "healthy";
	if (surface.startsWith("cache:")) return "graduate-or-delete";
	return "unknown";
}

function emitRow(rows: Row[], surface: string, name: string, file: string, disposition: string): void {
	const hash = hashFile(file);
	let desc = truncateDesc(frontmatterField(file, "description"));
	if (!desc) desc = "-";
	const origin = frontmatterField(file, "origin") || "-";
	const date = frontmatterField(file, "date") || "-";
	const staleWhen = frontmatterField(file, "stale_when") || "-";
	rows.push({ surface, name, hash, desc, origin, date, staleWhen, disposition });
}

function censusCache(
	rows: Row[],
	surface: string,
	dir: string,
	today: string,
	templateHashes: Map<string, string>,
): void {
	for (const name of subDirNames(dir)) {
		const skillFile = join(dir, name, "SKILL.md");
		if (!isFile(skillFile) || !isReadable(skillFile)) continue;
		const staleWhen = frontmatterField(skillFile, "stale_when");
		const disposition = classify(surface, name, hashFile(skillFile), staleWhen, today, templateHashes);
		emitRow(rows, surface, name, skillFile, disposition);
	}
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const first = args[0];
	let checkMode = false;
	if (first === "--check") {
		checkMode = true;
	} else if (first === "--help" || first === "-h") {
		process.stderr.write(USAGE);
		return 0;
	} else if (first === undefined || first === "") {
		// no-op: default run
	} else {
		process.stderr.write(USAGE);
		return 1;
	}

	try {
		const today = process.env.FM_SKILL_CENSUS_TODAY || todayString();
		const codeRootEffective = resolveCodeRoot();
		const homeEffective = resolveHome(codeRootEffective);
		const dataEffective = process.env.FM_DATA_OVERRIDE || join(homeEffective, "data");
		const templateSkillsDir = join(codeRootEffective, ".agents", "skills");
		const secondmatesMd = join(dataEffective, "secondmates.md");
		const homeDir = process.env.HOME ?? "";
		const ompCache = process.env.FM_SKILL_CACHE_OMP_OVERRIDE || join(homeDir, ".omp", "agent", "managed-skills");
		const claudeCache = process.env.FM_SKILL_CACHE_CLAUDE_OVERRIDE || join(homeDir, ".claude", "skills");

		const rows: Row[] = [];
		const templateHashes = new Map<string, string>();
		let templateSkillsReal = "";

		// Surface 1: template
		if (isDirectory(templateSkillsDir)) {
			templateSkillsReal = fmRealpathExisting(templateSkillsDir);
			for (const name of subDirNames(templateSkillsDir)) {
				const skillFile = join(templateSkillsDir, name, "SKILL.md");
				if (!isFile(skillFile)) continue;
				templateHashes.set(name, hashFile(skillFile));
				emitRow(rows, "template", name, skillFile, "template");
			}
		}

		function resolvesIntoTemplate(file: string): boolean {
			if (!templateSkillsReal) return false;
			let resolved: string;
			try {
				resolved = realpathSync(file);
			} catch {
				return false;
			}
			return resolved.startsWith(`${templateSkillsReal}/`);
		}

		// Surface 2: each registered mate home's local skills
		if (isReadable(secondmatesMd)) {
			const text = readFileSync(secondmatesMd, "utf8");
			const matePattern = /^- (\S+) - [^(]*\(home: ([^;)]*)[;)].*$/;
			for (const rawLine of text.split(/\r?\n/)) {
				const m = matePattern.exec(rawLine);
				if (!m) continue;
				const mateId = m[1];
				const mateHome = m[2];
				if (!mateId || !mateHome) continue;
				if (!isDirectory(mateHome)) continue;
				for (const sub of [".agents/skills", ".claude/skills"]) {
					const dir = join(mateHome, sub);
					if (!isDirectory(dir)) continue;
					const label = sub === ".claude/skills" ? ".claude" : ".agents";
					for (const name of subDirNames(dir)) {
						const skillFile = join(dir, name, "SKILL.md");
						if (!isFile(skillFile)) continue;
						if (resolvesIntoTemplate(skillFile)) continue;
						if (!isReadable(skillFile)) continue;
						const staleWhen = frontmatterField(skillFile, "stale_when");
						const surface = `mate:${mateId}:${label}`;
						const disposition = classify(surface, name, hashFile(skillFile), staleWhen, today, templateHashes);
						emitRow(rows, surface, name, skillFile, disposition);
					}
				}
			}
		}

		// Surface 3: machine caches
		if (isDirectory(ompCache)) censusCache(rows, "cache:omp-managed-skills", ompCache, today, templateHashes);
		if (isDirectory(claudeCache)) censusCache(rows, "cache:claude-skills", claudeCache, today, templateHashes);

		// Report
		const sortedRows = [...rows].sort((a, b) => {
			if (a.surface !== b.surface) return a.surface < b.surface ? -1 : 1;
			if (a.name !== b.name) return a.name < b.name ? -1 : 1;
			return 0;
		});

		let out = "surface\tname\tsha256\tdescription\torigin\tdate\tstale_when\tdisposition\n";
		out += "\n";
		for (const r of sortedRows) {
			out += `${r.surface}\t${r.name}\t${r.hash}\t${r.desc}\t${r.origin}\t${r.date}\t${r.staleWhen}\t${r.disposition}\n`;
		}
		out += "\n";
		out += "summary\n";
		out += "disposition\tcount\n";

		const counts = new Map<string, number>();
		for (const r of rows) counts.set(r.disposition, (counts.get(r.disposition) ?? 0) + 1);
		let driftCount = 0;
		for (const disposition of [...counts.keys()].sort()) {
			const count = counts.get(disposition)!;
			out += `${disposition}\t${count}\n`;
			if (disposition === "drift") driftCount = count;
		}
		out += `total\t${rows.length}\n`;

		process.stdout.write(out);

		if (checkMode && driftCount > 0) return 1;
		return 0;
	} catch {
		// Mirrors the original script's `set -eu`: a required path that cannot
		// be resolved (e.g. an override pointing at a nonexistent directory)
		// aborts silently with a nonzero exit code.
		return 1;
	}
}

export default {
	name: "skill-census",
	describe: "Read-only census of skill instances across the template, mate homes, and machine skill caches, with --check exiting nonzero on drift.",
	run,
};
