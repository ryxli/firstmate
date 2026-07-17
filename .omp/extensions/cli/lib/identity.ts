// fm lib: identity - shared identity + label helpers for firstmate.
// Ported behavior-preserving from sbin/fm-identity-lib.sh.
//
// Real callers (grepped): fm brief calls fm_identity_value directly;
// fm spawn calls fm_supervisor_name and fm_worker_label; fm brief calls
// fm_supervisor_slug. fm_task_slug has no external caller but is a real
// dependency of fm_worker_label (kept).
//
// Dropped as caller-less (defined in the bash lib, invoked by nothing -
// neither an external script nor another kept function): fm_supervisor_role,
// fm_supervisor_parent.
//
// The canonical per-instance identity file is config/identity (key=value,
// e.g. `name=<name>`), the same LOCAL/gitignored config/ pattern as
// config/crew-harness. It is optional: when absent every helper falls back to
// neutral defaults so the tooling works on a fresh checkout with no identity
// configured.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// identityValue(configDir, key): the value of `key=` from <configDir>/identity,
// or null when the file or key is absent. Mirrors the bash implementation's
// `sed -n "s/^[[:space:]]*key[[:space:]]*=[[:space:]]*//p" | head -1` followed
// by trailing-whitespace trim (leading whitespace is already consumed by the
// match). key is interpolated into a regex, matching the bash sed-BRE
// interpolation; callers only ever pass literal identifiers (name/role/parent).
export function identityValue(configDir: string, key: string): string | null {
	const file = join(configDir, "identity");
	if (!existsSync(file)) return null;
	const lines = readFileSync(file, "utf8").split(/\r?\n/);
	const re = new RegExp(`^\\s*${key}\\s*=\\s*`);
	for (const line of lines) {
		const m = line.match(re);
		if (!m) continue;
		let value = line.slice(m[0].length);
		value = value.replace(/\s+$/, "");
		if (value.length === 0) return null;
		return value;
	}
	return null;
}

// supervisorName(configDir): human-readable supervisor name; "firstmate" when unset.
export function supervisorName(configDir: string): string {
	return identityValue(configDir, "name") ?? "firstmate";
}

// supervisorSlug(configDir): short lowercase handle used as the "who spawned
// this" prefix of a worker label (the lowercased name with spaces turned to
// hyphens, e.g. "Foo Bar" -> "foo-bar"). Falls back to "fm" when no identity
// is configured, preserving the historical fm-<id> agent-name shape.
export function supervisorSlug(configDir: string): string {
	const name = identityValue(configDir, "name");
	if (name === null) return "fm";
	return name.toLowerCase().replaceAll(" ", "-");
}

// taskSlug(id): the human-readable part of a task id: the random suffix
// firstmate appends (a single letter + single digit, e.g. "-k3") is dropped
// so the visible label reads "fix-teardown-cleanup" rather than
// "fix-teardown-cleanup-k3". Ids without that suffix shape pass through whole.
export function taskSlug(id: string): string {
	return id.replace(/-[a-z][0-9]$/, "");
}

// workerLabel(configDir, id, explicit?): the visible herdr tab/pane display
// label for a crewmate: the task slug alone. An explicit label, when given
// (non-empty), wins so a caller can override the derivation. configDir is
// retained for signature stability even though the slug-only label no longer
// consults identity.
export function workerLabel(configDir: string, id: string, explicit?: string): string {
	if (explicit) return explicit;
	return taskSlug(id);
}
