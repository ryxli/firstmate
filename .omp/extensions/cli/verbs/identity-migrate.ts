// fm verb: identity-migrate - migrate and check versioned identities for all
// registered secondmate homes, including nested registries.
// Ported verbatim (behavior-preserving) from the former sbin/fm identity-migrate.
//
// Usage:
//   fm identity-migrate migrate [--dry-run]
//       For each home registered in data/secondmates.md (and recursively in
//       any data/secondmates.md found within those homes): add schema_version=1
//       to an unversioned config/identity (preserving name/role/other fields),
//       or create a config/identity from marker+registry facts for marker-only
//       homes. Refuses to touch any home where the marker id disagrees with
//       the registry id (CONFLICT). With --dry-run shows what would happen
//       without writing anything.
//
//   fm identity-migrate check
//       Exit 0 when every registered home carries a schema_version=1 identity
//       file. Exit 1 otherwise. Emits one tab-separated STATUS line per home:
//         OK        <id> <tab> <home>
//         UNRESOLVED <id> <tab> <home> <tab> <reason>
//       Machine-readable: parse on whitespace or split on tab. Riggs gates
//       removal of the whiteboard extension's marker-only fallback on this
//       command exiting 0.
//
// Behavior guarantees:
//   - Recursive: each registered home's data/secondmates.md is also traversed
//     so nested secondmates (e.g. Gauge under Atlas) are included in every run.
//   - Cycle-safe: each registry file and each home path is visited at most once.
//   - Idempotent: already-versioned homes emit ALREADY_VERSIONED and are left
//     untouched.
//   - Transactional per file: writes go through a tmp file + atomic rename so a
//     crash mid-write never leaves a half-written identity.
//   - Non-destructive: existing name/role/parent/other fields are preserved;
//     only schema_version=1 is prepended and any duplicate schema_version=
//     lines are removed.
//   - Conflict-refusing: a marker-registry id mismatch is emitted as CONFLICT
//     to stderr and the home is left untouched. migrate exits 1 if any
//     conflict occurred.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertIdentityDisplayName } from "../lib/identity";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const SCHEMA_VERSION = "1";

const USAGE = "Usage:\n  sbin/fm identity-migrate migrate [--dry-run]\n  sbin/fm identity-migrate check\n";

function usage(): void {
	process.stderr.write(USAGE);
}

function envOrDefault(name: string, fallback: string): string {
	const value = process.env[name];
	return value && value.length > 0 ? value : fallback;
}

function isDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function trimTrailing(value: string): string {
	return value.replace(/\s+$/, "");
}

function capitalizeId(id: string): string {
	if (id.length === 0) return id;
	return id.charAt(0).toUpperCase() + id.slice(1);
}

// Print [id, home] for each secondmate in one specific registry file.
// Registry line format: - <id> - <summary> (home: <path>[; ...]; ...)
function parseSingleRegistry(reg: string): Array<[string, string]> {
	if (!existsSync(reg)) return [];
	const content = readFileSync(reg, "utf8");
	const lines = content.split(/\r?\n/);
	const re = /^- ([^ ]*) - [^(]*\(home: ([^;)]*)[;)]/;
	const entries: Array<[string, string]> = [];
	for (const line of lines) {
		const match = re.exec(line);
		if (!match) continue;
		entries.push([match[1], match[2].trim()]);
	}
	return entries;
}

// The first-clause role hint for a given id from a specific registry file.
function registryRoleForId(id: string, reg: string): string | null {
	if (!existsSync(reg)) return null;
	const content = readFileSync(reg, "utf8");
	const lines = content.split(/\r?\n/);
	const prefix = `- ${id} - `;
	for (const line of lines) {
		if (!line.startsWith(prefix)) continue;
		let rest = line.slice(prefix.length);
		const homeIdx = rest.indexOf("(home:");
		if (homeIdx !== -1) rest = rest.slice(0, homeIdx);
		rest = trimTrailing(rest);
		const semiIdx = rest.indexOf(";");
		if (semiIdx !== -1) rest = rest.slice(0, semiIdx);
		return rest.length > 0 ? rest : null;
	}
	return null;
}

function extractFieldValue(content: string, field: string): string | null {
	const lines = content.split(/\r?\n/);
	const re = new RegExp(`^${field}\\s*=\\s*(.*)$`);
	for (const line of lines) {
		const match = re.exec(line);
		if (match) return match[1];
	}
	return null;
}

function atomicWrite(filePath: string, content: string): void {
	const tmp = `${filePath}.tmp.${process.pid}`;
	writeFileSync(tmp, content);
	renameSync(tmp, filePath);
}

// Emit [id, home, src_reg] for every secondmate in <reg> and in any
// data/secondmates.md found recursively inside those homes. Each registry
// file and each home path is visited at most once (cycle + dup protection).
function collectEntriesRecursive(
	reg: string,
	seenRegs: Set<string>,
	seenHomes: Set<string>,
	out: Array<[string, string, string]>,
): void {
	if (seenRegs.has(reg)) return;
	seenRegs.add(reg);
	if (!existsSync(reg)) return;
	for (const [id, home] of parseSingleRegistry(reg)) {
		if (!id) continue;
		if (seenHomes.has(home)) continue;
		seenHomes.add(home);
		out.push([id, home, reg]);
		const nested = `${home}/data/secondmates.md`;
		if (existsSync(nested)) collectEntriesRecursive(nested, seenRegs, seenHomes, out);
	}
}

function collectAllEntries(reg: string): Array<[string, string, string]> {
	const out: Array<[string, string, string]> = [];
	collectEntriesRecursive(reg, new Set(), new Set(), out);
	return out;
}

// Emit one STATUS line: "OK\t<id>\t<home>" or "UNRESOLVED\t<id>\t<home>\t<reason>".
// Does not modify any files.
function validateIdentityDisplayFields(identityPath: string, content: string): string | null {
	const existingName = trimTrailing(extractFieldValue(content, "name") ?? "");
	if (existingName.length === 0) return "identity-no-name";
	try {
		assertIdentityDisplayName(existingName, "name", identityPath);
	} catch (error) {
		return (error as Error).message;
	}
	const existingParent = trimTrailing(extractFieldValue(content, "parent") ?? "");
	if (existingParent.length > 0) {
		try {
			assertIdentityDisplayName(existingParent, "parent", identityPath);
		} catch (error) {
			return (error as Error).message;
		}
	}
	return null;
}

function checkHome(id: string, home: string): string {
	const markerPath = `${home}/.fm-secondmate-home`;
	const identityPath = `${home}/config/identity`;

	if (!isDirectory(home)) return `UNRESOLVED\t${id}\t${home}\tno-home-dir`;
	if (!existsSync(markerPath)) return `UNRESOLVED\t${id}\t${home}\tno-marker`;
	const markerId = readFileSync(markerPath, "utf8").replace(/\s/g, "");
	if (markerId !== id) return `UNRESOLVED\t${id}\t${home}\tmarker-mismatch:${markerId}`;
	if (!existsSync(identityPath)) return `UNRESOLVED\t${id}\t${home}\tno-identity`;
	const content = readFileSync(identityPath, "utf8");
	const sv = trimTrailing(extractFieldValue(content, "schema_version") ?? "");
	if (sv !== SCHEMA_VERSION) return `UNRESOLVED\t${id}\t${home}\tunversioned`;
	const fieldError = validateIdentityDisplayFields(identityPath, content);
	if (fieldError !== null) return `UNRESOLVED\t${id}\t${home}\t${fieldError}`;
	return `OK\t${id}\t${home}`;
}

// Emit one STATUS line to stdout (or stderr for CONFLICT/ERROR).
// Returns false on CONFLICT or ERROR.
function migrateHome(id: string, home: string, srcReg: string, dryRun: boolean): boolean {
	const markerPath = `${home}/.fm-secondmate-home`;
	const identityPath = `${home}/config/identity`;

	if (!isDirectory(home)) {
		process.stderr.write(`ERROR\t${id}\t${home}\tno-home-dir\n`);
		return false;
	}

	// Check marker matches registry id - refuse without modifying on mismatch.
	if (!existsSync(markerPath)) {
		process.stderr.write(`CONFLICT\t${id}\t${home}\tno-marker\n`);
		return false;
	}
	const markerId = readFileSync(markerPath, "utf8").replace(/\s/g, "");
	if (markerId !== id) {
		process.stderr.write(`CONFLICT\t${id}\t${home}\tmarker-id-mismatch:${markerId}\n`);
		return false;
	}

	if (existsSync(identityPath)) {
		const content = readFileSync(identityPath, "utf8");
		const sv = trimTrailing(extractFieldValue(content, "schema_version") ?? "");
		if (sv === SCHEMA_VERSION) {
			const fieldError = validateIdentityDisplayFields(identityPath, content);
			if (fieldError !== null) {
				process.stderr.write(`CONFLICT\t${id}\t${home}\t${fieldError}\n`);
				return false;
			}
			process.stdout.write(`ALREADY_VERSIONED\t${id}\t${home}\n`);
			return true;
		}
		// Require name= - an identity file without it cannot be safely migrated.
		const fieldError = validateIdentityDisplayFields(identityPath, content);
		if (fieldError !== null) {
			process.stderr.write(`CONFLICT\t${id}\t${home}\t${fieldError}\n`);
			return false;
		}
		if (dryRun) {
			process.stdout.write(`WOULD_MIGRATE\t${id}\t${home}\n`);
			return true;
		}
		// Atomically prepend schema_version=1, removing any stale duplicate.
		const filtered = content
			.split(/\r?\n/)
			.filter(line => !/^schema_version\s*=/.test(line))
			.join("\n");
		atomicWrite(identityPath, `schema_version=1\n${filtered}`);
		process.stdout.write(`MIGRATED\t${id}\t${home}\n`);
		return true;
	}

	// Marker-only home: create identity from marker + registry role hint.
	const name = capitalizeId(id);
	const role = registryRoleForId(id, srcReg) ?? "";
	try {
		assertIdentityDisplayName(name, "name", identityPath);
	} catch (error) {
		process.stderr.write(`CONFLICT\t${id}\t${home}\t${(error as Error).message}\n`);
		return false;
	}
	if (dryRun) {
		process.stdout.write(`WOULD_CREATE\t${id}\t${home}\tname=${name}\n`);
		return true;
	}
	mkdirSync(`${home}/config`, { recursive: true });
	atomicWrite(identityPath, `schema_version=1\nname=${name}\nrole=${role}\n`);
	process.stdout.write(`CREATED\t${id}\t${home}\n`);
	return true;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const cmd = args[0] ?? "";

	const fmRoot = envOrDefault("FM_ROOT_OVERRIDE", REPO_ROOT);
	const fmHome = envOrDefault("FM_HOME", envOrDefault("FM_ROOT_OVERRIDE", fmRoot));
	const data = envOrDefault("FM_DATA_OVERRIDE", `${fmHome}/data`);
	const reg = `${data}/secondmates.md`;

	switch (cmd) {
		case "check": {
			if (args.length !== 1) {
				usage();
				return 1;
			}
			let anyUnresolved = 0;
			for (const [id, home] of collectAllEntries(reg)) {
				if (!id) continue;
				const result = checkHome(id, home);
				process.stdout.write(`${result}\n`);
				if (result.startsWith("UNRESOLVED")) anyUnresolved = 1;
			}
			return anyUnresolved;
		}
		case "migrate": {
			if (args.length > 2) {
				usage();
				return 1;
			}
			const dryRunFlag = args[1] ?? "";
			if (dryRunFlag !== "" && dryRunFlag !== "--dry-run") {
				usage();
				return 1;
			}
			const dryRun = dryRunFlag === "--dry-run";
			let anyBad = 0;
			for (const [id, home, srcReg] of collectAllEntries(reg)) {
				if (!id) continue;
				const ok = migrateHome(id, home, srcReg, dryRun);
				if (!ok) anyBad = 1;
			}
			return anyBad;
		}
		case "-h":
		case "--help":
		case "":
			usage();
			return 0;
		default:
			usage();
			return 1;
	}
}

export default {
	name: "identity-migrate",
	describe: "Migrate or check versioned identity files across the secondmate registry tree.",
	run,
};
