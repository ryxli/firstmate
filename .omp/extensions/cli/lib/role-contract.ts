import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeFromCwd } from "./root";
import { identityValue } from "./identity";

const DEFAULT_MAIN_NAME = "firstmate";

export type RoleKind = "firstmate" | "secondmate" | "crew" | "unverified";

export interface RoleContractInput {
	home: string;
	mainHome?: string;
	crewId?: string;
	brief?: string;
	launchingSupervisor?: string;
}

export function activeHome(repoRoot: string): string {
	const nearest = homeFromCwd();
	if (nearest && roleKindForHome(nearest) !== "firstmate") return nearest;
	return process.env.FM_HOME?.trim() || nearest || repoRoot;
}

export function isSecondmateHome(home: string): boolean {
	return existsSync(join(home, ".fm-secondmate-home"));
}

export function roleKindForHome(home: string): Extract<RoleKind, "firstmate" | "secondmate" | "unverified"> {
	const marked = isSecondmateHome(home);
	const configDir = join(home, "config");
	const configuredRole = identityValue(configDir, "role")?.trim().toLowerCase();
	const configuredParent = identityValue(configDir, "parent")?.trim().toLowerCase();
	const parentIsCaptain = configuredParent === "captain" || configuredParent === "cap";
	const parentIsSupervisor = configuredParent !== undefined && !parentIsCaptain;
	if (marked) return configuredRole === "firstmate" || parentIsCaptain ? "unverified" : "secondmate";
	return configuredRole === "secondmate" || parentIsSupervisor ? "unverified" : "firstmate";
}

export function configuredName(home: string, fallback: string): string {
	return identityValue(join(home, "config"), "name") ?? fallback;
}

export function configuredParent(home: string, fallback: string): string {
	return identityValue(join(home, "config"), "parent") ?? fallback;
}

function markerId(home: string): string {
	try {
		return readFileSync(join(home, ".fm-secondmate-home"), "utf8").trim();
	} catch {
		return "unknown-secondmate";
	}
}

function title(id: string): string {
	return id ? id.charAt(0).toUpperCase() + id.slice(1) : id;
}

function charterScope(home: string): string {
	try {
		const charter = readFileSync(join(home, "data", "charter.md"), "utf8");
		const start = charter.indexOf("# Routing scope");
		if (start === -1) return "(scope unavailable; read-only until charter is restored)";
		const rest = charter.slice(start + "# Routing scope".length);
		const next = rest.search(/\n# /);
		return (next === -1 ? rest : rest.slice(0, next)).trim() || "(scope unavailable; read-only until charter is restored)";
	} catch {
		return "(scope unavailable; read-only until charter is restored)";
	}
}

export function ensureSecondmateParentIdentity(home: string, parentName: string, updateExisting = false): void {
	if (!isSecondmateHome(home)) return;
	const configDir = join(home, "config");
	const identityFile = join(configDir, "identity");
	mkdirSync(configDir, { recursive: true });
	let text = "";
	try {
		text = readFileSync(identityFile, "utf8");
	} catch {
		const id = markerId(home);
		writeFileSync(identityFile, `schema_version=1\nname=${title(id)}\nrole=secondmate\nparent=${parentName}\n`);
		return;
	}
	if (/^\s*parent\s*=/m.test(text)) {
		if (!updateExisting) return;
		const updated = text.replace(/^\s*parent\s*=.*$/m, `parent=${parentName}`);
		if (updated !== text) writeFileSync(identityFile, updated);
		return;
	}
	const suffix = text.endsWith("\n") ? "" : "\n";
	writeFileSync(identityFile, `${text}${suffix}parent=${parentName}\n`);
}

export function mainRoleContract(input: RoleContractInput): string {
	const name = configuredName(input.home, DEFAULT_MAIN_NAME);
	return [
		"# Runtime Role Contract",
		"priority: system/developer",
		`You are ${name}, the first mate reporting to the captain.`,
		`name: ${name}`,
		"kind: firstmate",
		"reports_to: captain",
		"authority: fleet-wide supervisor, direct captain interface, fleet-policy owner",
		"scope: all registered homes, direct reports, fleet routing, and shared firstmate policy",
		"if_identity_absent_or_conflicting: operate read-only and surface the conflict",
	].join("\n");
}

export function secondmateRoleContract(input: RoleContractInput): string {
	const id = markerId(input.home);
	const mainName = input.mainHome ? configuredName(input.mainHome, DEFAULT_MAIN_NAME) : configuredParent(input.home, DEFAULT_MAIN_NAME);
	ensureSecondmateParentIdentity(input.home, mainName, Boolean(input.mainHome));
	const name = configuredName(input.home, title(id));
	return [
		"# Runtime Role Contract",
		"priority: system/developer",
		`You are ${name}, a secondmate reporting to ${mainName}.`,
		`id: ${id}`,
		`name: ${name}`,
		"kind: secondmate",
		`reports_to: ${mainName}`,
		"authority: own-home and charter-domain only; relay captain interface through the main firstmate",
		"not_authorized: sibling governance, main-home governance, fleet policy, cap direct interface",
		`routing_scope: ${charterScope(input.home)}`,
		"if_identity_absent_or_conflicting: operate read-only and surface the conflict",
	].join("\n");
}

export function crewRoleContract(input: RoleContractInput): string {
	const supervisor = input.launchingSupervisor ?? (input.mainHome ? configuredName(input.mainHome, DEFAULT_MAIN_NAME) : DEFAULT_MAIN_NAME);
	return [
		"# Runtime Role Contract",
		"priority: system/developer",
		`You are a crew agent assigned to ${input.crewId ?? "crew"}, reporting to ${supervisor}.`,
		`id: ${input.crewId ?? "crew"}`,
		"kind: crew",
		`reports_to: ${supervisor}`,
		"authority: assigned brief only",
		"scope: the launching supervisor owns all routing, captain communication, and fleet policy",
		"if_identity_absent_or_conflicting: operate read-only and surface the conflict",
	].join("\n");
}

function unverifiedRoleContract(home: string): string {
	const marked = isSecondmateHome(home);
	const configDir = join(home, "config");
	const configuredRole = identityValue(configDir, "role");
	const configuredParent = identityValue(configDir, "parent");
	const evidence = `secondmate marker ${marked ? "present" : "absent"}; config/identity role is ${configuredRole ?? "missing"}; parent is ${configuredParent ?? "missing"}`;
	return [
		"# Runtime Role Contract",
		"priority: system/developer",
		"You are an unverified local agent. Operate read-only until the home identity is repaired.",
		"name: unverified",
		"kind: unverified",
		"reports_to: unknown",
		"authority: read-only",
		"scope: surface the identity conflict; do not perform firstmate or secondmate actions",
		`identity_conflict: ${evidence}`,
		"if_identity_absent_or_conflicting: operate read-only and surface the conflict",
	].join("\n");
}

export function roleContractForHome(home: string, mainHome?: string): string {
	const kind = roleKindForHome(home);
	if (kind === "secondmate") return secondmateRoleContract({ home, mainHome });
	if (kind === "firstmate") return mainRoleContract({ home });
	return unverifiedRoleContract(home);
}

export function forbiddenInSecondmate(argv: string[]): string | null {
	const verb = argv[0] ?? "";
	if (["home", "home-seed", "update", "promote", "link-ship-ext"].includes(verb)) return verb;
	if ((verb === "tasks" || verb === "task") && argv[1] === "mv") return `${verb} mv`;
	if (verb === "spawn" && argv.includes("--secondmate")) return "spawn --secondmate";
	if (verb === "brief" && (argv.includes("--secondmate") || argv.includes("--regen") || argv.includes("--check"))) return "brief secondmate projection";
	return null;
}
