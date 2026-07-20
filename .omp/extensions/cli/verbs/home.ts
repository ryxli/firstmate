// fm verb: home - check or repair shared-code links and mate-home layout for registered mates.
// Migrated verbatim (behavior-preserving) out of the former sbin/fm monolith,
// then extended so main and secondmate homes share the canonical layout contract.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveMainHome } from "../../bridge/collect";
import { topologyCandidates } from "../../bridge/update";
import { ambiguous, missing, operationalError, output, validationError } from "../common";
import { commandHelp } from "../help";
import { checkMateHomeLayout, repairMateHomeLayout } from "../lib/mate-home-layout";

const FM_CLI = fileURLToPath(new URL("../../../../sbin/fm", import.meta.url));

interface HomeLinkRecord {
	command: string;
	target: string;
	home: string;
	action: "check" | "repair";
	result: string;
	diagnostics: string[];
}

function helperLines(stdout: string, stderr: string): string[] {
	return `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`
		.split(/\r?\n/)
		.filter(line => line.length > 0);
}

function childText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
	if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
	return "";
}

function runHomeLink(target: { id: string; home: string }, action: "check" | "repair"): HomeLinkRecord {
	const helper = spawnSync(FM_CLI, ["home-link", target.home, `--${action}`], {
		encoding: "utf8",
		env: process.env,
	});
	const stdout = childText(helper.stdout);
	const stderr = childText(helper.stderr);
	const diagnostics = helperLines(stdout, stderr);
	const reported = [...diagnostics].reverse().find(line => line.startsWith("result="))?.slice("result=".length);
	if (helper.error) diagnostics.push(`error: ${helper.error.message}`);
	const result = reported ?? (helper.status === 0 ? "ok" : "failed");
	return {
		command: `home ${action}`,
		home: target.home,
		target: target.id,
		action,
		result,
		diagnostics,
	};
}

function runMainLayout(target: { id: string; home: string }, action: "check" | "repair"): HomeLinkRecord {
	const diagnostics: string[] = [`home=${target.home}`, `mode=${action}`, "surface=layout"];
	const outcome = action === "repair" ? repairMateHomeLayout(target.home) : checkMateHomeLayout(target.home);
	if (action === "repair") {
		for (const rel of (outcome as ReturnType<typeof repairMateHomeLayout>).created) {
			diagnostics.push(`layout.${rel.replace(/\//g, ".")}=repaired`);
		}
	}
	for (const issue of outcome.issues) {
		diagnostics.push(`layout.${issue.rel.replace(/\//g, ".")}=blocked:${issue.code}`);
		diagnostics.push(`detail: ${issue.detail}`);
	}
	const result = outcome.ok ? "ok" : "blocked";
	diagnostics.push(`layout=${result}`);
	diagnostics.push(`result=${result}`);
	return {
		command: `home ${action}`,
		home: target.home,
		target: target.id,
		action,
		result,
		diagnostics,
	};
}

async function homeCommand(argv: string[]): Promise<number> {
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
		output(commandHelp("fm home"));
		return 0;
	}
	if (argv.length !== 2) {
		return validationError(`Usage: fm home <check|repair> <mate|--all>`, ["Use `fm home <check|repair> <mate|--all>`."]);
	}
	const action = argv[0];
	if (action !== "check" && action !== "repair") {
		return validationError(`Unknown home action: ${action}`, ["Choose check or repair."]);
	}
	const target = argv[1];
	if (!target || (target.startsWith("-") && target !== "--all")) {
		return validationError(`Invalid home target: ${target || "(missing)"}`, ["Provide a registered mate id or --all."]);
	}
	const root = resolveMainHome();
	if (!root) return operationalError(`home ${action}`, new Error("could not resolve the firstmate home"));
	const candidates = topologyCandidates(root);
	const selected =
		target === "--all"
			? candidates
			: candidates.filter(candidate => candidate.id === target || (target === "firstmate" && candidate.role === "firstmate"));
	if (target !== "--all" && !selected.length) return missing("home", target);
	if (target !== "--all" && selected.length > 1) return ambiguous("home", target, selected.map(candidate => candidate.home));
	const records = selected.map(candidate =>
		candidate.role === "firstmate" ? runMainLayout(candidate, action) : runHomeLink(candidate, action),
	);
	output({ command: `home ${action}`, result: records });
	return records.every(record => record.result === "ok") ? 0 : 1;
}

async function run(argv: string[]): Promise<number> {
	return homeCommand(argv.slice(1));
}

export default {
	name: "home",
	describe: "Check or repair mate-home layout and shared-code links for registered mates.",
	run,
};
