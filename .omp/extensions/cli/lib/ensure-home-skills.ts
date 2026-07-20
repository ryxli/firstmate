// Central pre-launch / pre-reload gate for specialist home skill isolation.
// All launchers call ensureSecondmateHomeSkills + injectOmpHomeConfig rather
// than embedding slightly different reconciliation logic per verb.

import { join } from "node:path";
import { isRealFile } from "./path-links";
import {
	type HomeSkillsOptions,
	type HomeSkillsResult,
	SUB_HOME_MARKER,
	syncHomeSkills,
} from "./home-skills";

/** True when path is a seeded secondmate home (real marker file). */
export function isSecondmateHome(home: string): boolean {
	return isRealFile(join(home, SUB_HOME_MARKER));
}

/**
 * Inject `--config <home>/config/omp.yml` into an omp launch command when the
 * command starts with `omp` and does not already pass `--config`.
 */
export function injectOmpHomeConfig(cmd: string, home: string): string {
	const trimmed = cmd.trimStart();
	if (!trimmed.startsWith("omp")) return cmd;
	if (/(?:^|\s)--config(?:\s|=)/.test(trimmed)) return cmd;
	const configPath = join(home, "config", "omp.yml");
	const prefixLen = cmd.length - trimmed.length;
	const prefix = cmd.slice(0, prefixLen);
	const rest = trimmed.slice(3);
	const quoted = `'${configPath.replaceAll("'", "'\\''")}'`;
	return `${prefix}omp --config ${quoted}${rest}`;
}

/**
 * Reconcile skills for a secondmate home before launch/reload. No-op for
 * non-secondmate paths. Returns null when the path is not a specialist home.
 */
export function ensureSecondmateHomeSkills(
	home: string,
	opts: Omit<HomeSkillsOptions, "mode" | "target"> = {},
): HomeSkillsResult | null {
	if (!isSecondmateHome(home)) return null;
	return syncHomeSkills(home, opts);
}
