// Fleet lifecycle: stop / clean / check for persistent registered secondmates.
// OMP owns subagent cancel/complete; this module only observes inventory.

import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { topologyCandidates, type TopologyCandidate } from "../../bridge/update";
import { archiveAllDoneEntries, BacklogStore, blockedIds, isHoldActive } from "./backlog-store";
import { listArtifactsPure } from "./artifact";
import { checkHomeSkills } from "./home-skills";
import { checkMateHomeLayout } from "./mate-home-layout";
import { ensureMateMiseToml } from "./mise-home";
import { observeOmpSubagentInventory } from "./omp-subagents";
import { exitPaneSession } from "./pane-exit";
import { inspectLivePane, metaValue } from "./herdr";
import { reconcileFleet } from "./home-skills-fleet";

export type MateStopState = "stopped" | "already-stopped" | "blocked" | "failed";

export interface MateStopResult {
	mate: string;
	state: MateStopState;
	pane?: string;
	reason?: string;
}

function todayLocal(): string {
	return new Date().toISOString().slice(0, 10);
}

function secondmatesFromSnapshot(homes: TopologyCandidate[]): Array<{ id: string; home: string }> {
	return homes
		.filter(c => c.role === "secondmate")
		.map(c => ({ id: c.id, home: c.home }))
		.sort((a, b) => a.id.localeCompare(b.id));
}

function controllerStateDir(controllerHome: string): string {
	return join(controllerHome, "state");
}

function mateHarness(controllerHome: string, mateId: string): string {
	const metaPath = join(controllerStateDir(controllerHome), `${mateId}.meta`);
	return metaValue(metaPath, "harness") || "omp";
}

function emitLine(line: string): void {
	process.stdout.write(`${line}\n`);
}

export async function fleetStop(
	controllerHome: string,
	selector: string,
	frozenHomes?: TopologyCandidate[],
): Promise<number> {
	const homes = frozenHomes ?? topologyCandidates(controllerHome);
	const all = secondmatesFromSnapshot(homes);
	const snapped =
		selector === "--all"
			? all
			: all.filter(t => t.id === selector || t.home.endsWith(`/${selector}`) || t.home === selector);
	if (selector !== "--all" && snapped.length === 0) {
		process.stderr.write(`error: no registered persistent secondmate '${selector}'\n`);
		return 1;
	}

	const stateDir = controllerStateDir(controllerHome);
	const results: MateStopResult[] = [];
	for (const mate of snapped) {
		const target = `fm-${mate.id}`;
		const inspect = inspectLivePane(target, stateDir);
		if (inspect.class === "absent" || inspect.class === "shell") {
			results.push({ mate: mate.id, state: "already-stopped", pane: inspect.livePane || undefined, reason: inspect.class });
			emitLine(`state=already-stopped mate=${mate.id}${inspect.livePane ? ` pane=${inspect.livePane}` : ""}`);
			continue;
		}
		if (inspect.class === "stale-binding") {
			results.push({ mate: mate.id, state: "failed", reason: "stale-binding" });
			emitLine(`state=failed mate=${mate.id} reason=stale-binding`);
			continue;
		}
		if (inspect.class === "error" || inspect.class === "unknown") {
			results.push({ mate: mate.id, state: "failed", reason: inspect.reason || inspect.class });
			emitLine(`state=failed mate=${mate.id} reason=${(inspect.reason || inspect.class).replace(/\s+/g, "-")}`);
			continue;
		}
		const harness = mateHarness(controllerHome, mate.id);
		const exit = await exitPaneSession({
			target,
			stateDir,
			harness,
			refreshBinding: true,
		});
		if (exit.state === "already-stopped") {
			results.push({ mate: mate.id, state: "already-stopped", pane: exit.pane, reason: exit.reason });
			emitLine(`state=already-stopped mate=${mate.id}${exit.pane ? ` pane=${exit.pane}` : ""}`);
		} else if (exit.state === "consumed") {
			results.push({ mate: mate.id, state: "stopped", pane: exit.pane });
			emitLine(`state=stopped mate=${mate.id}${exit.pane ? ` pane=${exit.pane}` : ""}`);
		} else if (exit.state === "composer-blocked") {
			results.push({ mate: mate.id, state: "blocked", pane: exit.pane, reason: "composer-draft" });
			emitLine(`state=blocked mate=${mate.id} reason=composer-draft`);
		} else {
			results.push({ mate: mate.id, state: "failed", pane: exit.pane, reason: exit.reason || "failed" });
			emitLine(`state=failed mate=${mate.id} reason=${(exit.reason || "failed").replace(/\s+/g, "-")}`);
		}
	}

	const stopped = results.filter(r => r.state === "stopped").length;
	const already = results.filter(r => r.state === "already-stopped").length;
	const blocked = results.filter(r => r.state === "blocked").length;
	const failed = results.filter(r => r.state === "failed").length;
	const summaryState = failed > 0 ? "failed" : blocked > 0 ? "blocked" : "ok";
	emitLine(`result=${summaryState} stopped=${stopped} already_stopped=${already} blocked=${blocked} failed=${failed}`);
	if (failed > 0) return 1;
	if (blocked > 0) return 75;
	return 0;
}

export interface ActiveScopeBlocker {
	key: string;
	state: string;
}

/** Active-scope blockers over a frozen home snapshot. Missing backlog = unknown, not resting. */
export function findActiveScopeBlockers(
	controllerHome: string,
	frozenHomes?: TopologyCandidate[],
): ActiveScopeBlocker[] {
	const homes = frozenHomes ?? topologyCandidates(controllerHome);
	const blockers: ActiveScopeBlocker[] = [];
	for (const cand of homes) {
		const dataDir = join(cand.home, "data");
		const backlogPath = join(dataDir, "backlog.md");
		if (!existsSync(backlogPath)) {
			blockers.push({ key: `${cand.id}/<missing-backlog>`, state: "unknown" });
			continue;
		}
		let store: BacklogStore;
		try {
			store = BacklogStore.load(backlogPath);
		} catch {
			blockers.push({ key: `${cand.id}/<unreadable-backlog>`, state: "unreadable" });
			continue;
		}
		const tasks = store.list();
		const blocked = blockedIds(tasks, { dataDir, pure: true });
		const today = todayLocal();
		for (const t of tasks) {
			if (t.state === "inflight") {
				blockers.push({ key: `${cand.id}/${t.id}`, state: "inflight" });
				continue;
			}
			if (t.state === "queued") {
				const held = isHoldActive(t, today);
				if (held) blockers.push({ key: `${cand.id}/${t.id}`, state: "held" });
				else if (blocked.has(t.id)) blockers.push({ key: `${cand.id}/${t.id}`, state: "blocked" });
				else blockers.push({ key: `${cand.id}/${t.id}`, state: "queued" });
			}
		}
	}
	return blockers;
}

interface CleanReceipt {
	operationId: string;
	controllerHome: string;
	startedAt: string;
	updatedAt: string;
	lastPhase: string;
	targetSnapshot: string[];
	preflight?: Record<string, unknown>;
	stop?: Record<string, unknown>;
	repair?: Record<string, unknown>;
	reconcile?: Record<string, unknown>;
	archive?: Record<string, unknown>;
	scrub?: Record<string, unknown>;
	check?: Record<string, unknown>;
	artifactIdsReferenced?: string[];
}

function receiptPath(controllerHome: string): string {
	return join(controllerHome, "data", "fleet-clean.receipt.json");
}

function writeReceipt(controllerHome: string, receipt: CleanReceipt): void {
	mkdirSync(join(controllerHome, "data"), { recursive: true });
	const path = receiptPath(controllerHome);
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`);
	renameSync(tmp, path);
}

const VOLATILE_PREFIXES = [".herdr-prev-status-", ".herdr-idle-count-", ".herdr-turn-", ".stale-"];

export interface ScrubResult {
	scrubbed: string[];
	residuals: string[];
	errors: string[];
}

function listVolatileRuntimeFiles(home: string): { files: string[]; errors: string[] } {
	const state = join(home, "state");
	const files: string[] = [];
	const errors: string[] = [];
	if (!existsSync(state)) return { files, errors };
	try {
		for (const name of readdirSync(state)) {
			if (VOLATILE_PREFIXES.some(p => name.startsWith(p))) {
				files.push(join(state, name));
			}
		}
	} catch (error) {
		errors.push(`${state}:${String(error)}`);
	}
	return { files, errors };
}

function scrubVolatileRuntime(home: string): ScrubResult {
	const scrubbed: string[] = [];
	const residuals: string[] = [];
	const errors: string[] = [];
	const listed = listVolatileRuntimeFiles(home);
	errors.push(...listed.errors);
	for (const path of listed.files) {
		try {
			unlinkSync(path);
			scrubbed.push(path);
		} catch (error) {
			residuals.push(path);
			errors.push(`${path}:${String(error)}`);
		}
	}
	return { scrubbed, residuals, errors };
}

function assessRuntimeMetadata(homes: TopologyCandidate[]): { state: string; detail?: string } {
	const residuals: string[] = [];
	const errors: string[] = [];
	for (const cand of homes) {
		const listed = listVolatileRuntimeFiles(cand.home);
		residuals.push(...listed.files);
		errors.push(...listed.errors);
	}
	if (errors.length > 0) {
		return { state: "failed", detail: `errors=${errors.length} residuals=${residuals.length}` };
	}
	if (residuals.length > 0) {
		return { state: "failed", detail: `residuals=${residuals.length}` };
	}
	return { state: "ok" };
}

export async function fleetClean(controllerHome: string): Promise<number> {
	// Freeze the clean target snapshot once before preflight; reuse everywhere.
	const frozenHomes = topologyCandidates(controllerHome);
	const targets = secondmatesFromSnapshot(frozenHomes);
	const operationId = `fleet-clean-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
	const receipt: CleanReceipt = {
		operationId,
		controllerHome,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		lastPhase: "start",
		targetSnapshot: frozenHomes.map(t => t.id),
	};

	const active = findActiveScopeBlockers(controllerHome, frozenHomes);
	if (active.length > 0) {
		for (const b of active) emitLine(`blocked-task key=${b.key} state=${b.state}`);
		emitLine(`result=failed reason=active-scope count=${active.length}`);
		process.stderr.write("error: fleet clean refused; active queued/held/blocked/inflight tasks present\n");
		return 1;
	}

	const inv = observeOmpSubagentInventory(controllerHome);
	emitLine(`check=omp-subagents state=${inv.state} trustworthy=${inv.trustworthy ? "true" : "false"}`);
	if (inv.state !== "ok" || !inv.trustworthy) {
		emitLine(`result=failed reason=omp-subagents-${inv.state}`);
		process.stderr.write(`error: fleet clean refused; OMP subagent inventory is ${inv.state}: ${inv.reason}\n`);
		return 1;
	}

	receipt.preflight = { activeScope: [], ompSubagents: inv, targetSnapshot: targets.map(t => t.id) };
	receipt.lastPhase = "preflight";
	receipt.updatedAt = new Date().toISOString();
	writeReceipt(controllerHome, receipt);

	const stopRc = await fleetStop(controllerHome, "--all", frozenHomes);
	receipt.stop = { exitCode: stopRc };
	receipt.lastPhase = "stop";
	receipt.updatedAt = new Date().toISOString();
	writeReceipt(controllerHome, receipt);
	if (stopRc !== 0) {
		emitLine("result=failed reason=stop-barrier");
		return stopRc;
	}

	const { repairMateHomeLayout } = await import("./mate-home-layout");
	const repairFails: string[] = [];
	for (const cand of frozenHomes) {
		const layout = repairMateHomeLayout(cand.home);
		if (!layout.ok) repairFails.push(cand.id);
	}
	receipt.repair = { failed: repairFails };
	receipt.lastPhase = "repair";
	receipt.updatedAt = new Date().toISOString();
	writeReceipt(controllerHome, receipt);
	if (repairFails.length > 0) {
		emitLine(`result=failed reason=repair-barrier homes=${repairFails.join(",")}`);
		return 1;
	}

	const savedHome = process.env.FM_HOME;
	process.env.FM_HOME = controllerHome;
	let reconcileOk = false;
	try {
		const reconcile = reconcileFleet({ target: "--all", smoke: false, fmHome: controllerHome, quiet: true });
		reconcileOk = reconcile.ok;
		receipt.reconcile = { ok: reconcile.ok, lines: reconcile.lines.slice(-5) };
	} finally {
		if (savedHome !== undefined) process.env.FM_HOME = savedHome;
		else delete process.env.FM_HOME;
	}
	receipt.lastPhase = "reconcile";
	receipt.updatedAt = new Date().toISOString();
	writeReceipt(controllerHome, receipt);
	if (!reconcileOk) {
		emitLine("result=failed reason=reconcile-barrier");
		return 1;
	}

	const archived: string[] = [];
	const artifactRefs: string[] = [];
	try {
		for (const cand of frozenHomes) {
			const backlogPath = join(cand.home, "data", "backlog.md");
			const archivePath = join(cand.home, "data", "done-archive.md");
			if (!existsSync(backlogPath)) {
				throw new Error(`missing backlog for registered home ${cand.id}`);
			}
			const store = BacklogStore.load(backlogPath, { lenient: true });
			const result = archiveAllDoneEntries(store, { owner: cand.id, archivePath });
			if (result.archivedIds.length + result.skippedIds.length > 0) store.save();
			archived.push(...result.archivedIds.map(id => `${cand.id}/${id}`));
			for (const art of listArtifactsPure(join(cand.home, "data"), join(cand.home, "state"))) {
				if (art.reviewState === "abandoned" || art.reviewState === "superseded") {
					artifactRefs.push(`${cand.id}/${art.taskId}`);
				}
			}
		}
	} catch (error) {
		receipt.archive = { error: String(error) };
		receipt.lastPhase = "archive";
		receipt.updatedAt = new Date().toISOString();
		writeReceipt(controllerHome, receipt);
		emitLine("result=failed reason=archive-barrier");
		return 1;
	}
	receipt.archive = { archived };
	receipt.artifactIdsReferenced = artifactRefs;
	receipt.lastPhase = "archive";
	receipt.updatedAt = new Date().toISOString();
	writeReceipt(controllerHome, receipt);

	const scrubbed: string[] = [];
	const scrubResiduals: string[] = [];
	const scrubErrors: string[] = [];
	for (const cand of frozenHomes) {
		const scrub = scrubVolatileRuntime(cand.home);
		scrubbed.push(...scrub.scrubbed);
		scrubResiduals.push(...scrub.residuals);
		scrubErrors.push(...scrub.errors);
	}
	receipt.scrub = {
		scrubbedCount: scrubbed.length,
		residuals: scrubResiduals,
		errors: scrubErrors,
	};
	receipt.lastPhase = "scrub";
	receipt.updatedAt = new Date().toISOString();
	writeReceipt(controllerHome, receipt);
	if (scrubErrors.length > 0 || scrubResiduals.length > 0) {
		emitLine(
			`result=failed reason=scrub-barrier residuals=${scrubResiduals.length} errors=${scrubErrors.length}`,
		);
		return 1;
	}

	const checkRc = await fleetCheck(controllerHome, frozenHomes);
	receipt.check = { exitCode: checkRc };
	receipt.lastPhase = "check";
	receipt.updatedAt = new Date().toISOString();
	writeReceipt(controllerHome, receipt);
	return checkRc;
}

export interface FleetCheckLine {
	check: string;
	state: string;
	detail?: string;
}

export async function fleetCheck(controllerHome: string, frozenHomes?: TopologyCandidate[]): Promise<number> {
	const homes = frozenHomes ?? topologyCandidates(controllerHome);
	const lines: FleetCheckLine[] = [];
	let ok = true;

	const inv = observeOmpSubagentInventory(controllerHome);
	lines.push({
		check: "omp-subagents",
		state: inv.state,
		detail: inv.trustworthy ? undefined : inv.reason,
	});
	if (inv.state !== "ok" || !inv.trustworthy) ok = false;

	const active = findActiveScopeBlockers(controllerHome, homes);
	lines.push({
		check: "backlog-resting",
		state: active.length === 0 ? "ok" : "failed",
		detail: active.length ? active.map(b => b.key).join(",") : undefined,
	});
	if (active.length > 0) ok = false;

	for (const cand of homes) {
		const layout = checkMateHomeLayout(cand.home);
		lines.push({ check: "home-layout", state: layout.ok ? "ok" : "failed", detail: `home=${cand.id}` });
		if (!layout.ok) ok = false;

		// Specialist profile validation only — not the main/firstmate home.
		if (cand.role === "secondmate") {
			const skills = checkHomeSkills(cand.home, { quiet: true });
			lines.push({ check: "skills-profile", state: skills.ok ? "ok" : "failed", detail: `home=${cand.id}` });
			if (!skills.ok) ok = false;
		}

		const mise = ensureMateMiseToml(cand.home, false);
		const miseOk = mise.status === "ok";
		lines.push({ check: "mise", state: miseOk ? "ok" : "failed", detail: `home=${cand.id} status=${mise.status}` });
		if (!miseOk) ok = false;

		if (cand.role === "secondmate") {
			const inspect = inspectLivePane(`fm-${cand.id}`, controllerStateDir(controllerHome));
			if (inspect.class === "live-agent") {
				lines.push({ check: "session-ownership", state: "failed", detail: `mate=${cand.id} unexpected-live` });
				ok = false;
			} else if (inspect.class === "stale-binding" || inspect.class === "unknown") {
				lines.push({ check: "session-ownership", state: "failed", detail: `mate=${cand.id} ${inspect.class}` });
				ok = false;
			} else if (inspect.class === "error") {
				lines.push({ check: "session-ownership", state: "failed", detail: `mate=${cand.id} ${inspect.reason || "error"}` });
				ok = false;
			} else {
				lines.push({ check: "session-ownership", state: "ok", detail: `mate=${cand.id} ${inspect.class}` });
			}
		}
	}

	const runtime = assessRuntimeMetadata(homes);
	lines.push({ check: "runtime-metadata", state: runtime.state, detail: runtime.detail });
	if (runtime.state !== "ok") ok = false;

	for (const line of lines) {
		emitLine(`check=${line.check} state=${line.state}${line.detail ? ` ${line.detail}` : ""}`);
	}
	emitLine(`result=${ok ? "ok" : "failed"}`);
	return ok ? 0 : 1;
}
