// fm verb: brief - scaffold a crewmate brief or persistent secondmate charter
// at data/<task-id>/brief.md under the active firstmate home, and regenerate
// or check registry-driven secondmate projections.
// Ported verbatim (behavior-preserving) out of the former sbin/fm brief.
//
// For ordinary tasks, the standard Setup/Rules/Definition-of-done contract is
// filled in. Firstmate then replaces the {TASK} placeholder with the task
// description, acceptance criteria, and context, and may adjust other sections
// when the task genuinely deviates (e.g. working an existing external PR instead
// of shipping a new one).
// Usage: fm brief <task-id> <repo-name> [worker-args...]
//        fm brief --scout <task-id> <repo-name> [args...]
//        fm brief --secondmate <task-id> [project...]
//   --scout writes the scout contract instead: the deliverable is a report at
//   data/<task-id>/report.md (no branch, no push, no PR) and the worktree is scratch.
//   --secondmate writes a persistent secondmate charter. The project list
//   is cloned into the secondmate home, while the natural-language scope
//   tells the main firstmate when to route work there; routine churn stays in its own home;
//   only cap-relevant escalations reach the main firstmate through the fleet peer bus.
//   Set FM_SECONDMATE_CHARTER='<charter>' to fill the charter text.
//   Set FM_SECONDMATE_SCOPE='<scope>' to write a routing scope distinct from the charter text.
// For ship tasks, the definition of done is shaped by the project's delivery mode
// (data/projects.md via fm project-mode; trunk|pr only):
//   pr     push fm/<id>, open PR, report done: PR <url> (mandatory); then fm accept / finish
//   trunk  implement on branch, ready for fm accept (no push/PR); fm finish lands locally
// Scout tasks ignore mode - their deliverable is a report, not a merge.
// Supervisor path: fm accept (judgment) → fm revise (pre-accept) → fm finish (drain).
// Ship tasks include a project-memory section so durable project-intrinsic
// learnings can be committed to AGENTS.md through the project's delivery path.
// Refuses to overwrite an existing brief.
//
// Usage: fm brief --regen <id>
//        fm brief --check <id>
//   --regen and --check make data/secondmates.md the only hand-edited home for a
//   secondmate's identity/scope: both data/<id>/brief.md and <home>/data/charter.md
//   are generated projections of the registry line for <id> plus a tracked
//   template. --regen writes both projections; --check regenerates in memory and
//   exits nonzero, naming any projection whose current content differs from what
//   generation would produce (a projection missing its mate-owned section markers
//   also fails --check). Each projection carries exactly one delimited mate-owned
//   free-form section, preserved verbatim across regenerations; --check ignores
//   that section's content but still requires the markers to be present.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { identityValue, supervisorSlug } from "../lib/identity";
import { shellQuote } from "../lib/spawn";

// Equivalent of the former script's SCRIPT_DIR/.. (sbin's parent = repo root),
// resolved from this verb module's own location (verbs -> cli -> extensions -> .omp -> root).
const DEFAULT_FM_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");

// joinPath(...parts): plain "/"-concatenation, deliberately NOT node:path's
// normalizing join. The former bash script built every path via literal
// "$A/$B" string interpolation, which never collapses a double slash (e.g. a
// FM_HOME/DATA override supplied with a trailing slash). Generated brief/
// charter text is a byte-for-byte contract, so path text embedded in it must
// reproduce that same non-normalizing concatenation.
function joinPath(...parts: string[]): string {
	return parts.join("/");
}

function envOrUndefined(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

interface Paths {
	fmRoot: string;
	data: string;
	config: string;
	state: string;
}

function resolvePaths(): Paths {
	const rootOverride = envOrUndefined("FM_ROOT_OVERRIDE");
	const fmRoot = rootOverride ?? DEFAULT_FM_ROOT;
	const fmHome = envOrUndefined("FM_HOME") ?? rootOverride ?? fmRoot;
	const data = envOrUndefined("FM_DATA_OVERRIDE") ?? joinPath(fmHome, "data");
	const config = envOrUndefined("FM_CONFIG_OVERRIDE") ?? joinPath(fmHome, "config");
	const state = envOrUndefined("FM_STATE_OVERRIDE") ?? joinPath(fmHome, "state");
	return { fmRoot, data, config, state };
}

// --- house convention blocks --------------------------------------------------
// Static and terse on purpose: they ride into every spawn, so every token is
// paid per crewmate/secondmate. Identical wording for both the one-shot
// ship/scout/secondmate scaffolds and the registry-driven secondmate projection.

const LEAN_LOOP_BLOCK = `# Lean-loop discipline
Work in conclusive slices that each narrow toward done; do not restate the task or announce a pause before acting.
Every reasoning step must add a new decision, fact, or tool call - if it would repeat a prior conclusion, act instead.
Delegate any self-contained side-work a subagent can do rather than spending your own turn on it.`;

const HOUSE_TOOLING_BLOCK = `# House tooling conventions
Use bun/bunx (or a bun-linked bare command) for JS/TS tooling - never npm, npx, yarn, or pnpm.
Use the axi-family CLIs - gh-axi, chrome-devtools-axi, lavish-axi - for GitHub, browser, and review surfaces.`;

// --- secondmate charter regeneration -----------------------------------------
// data/secondmates.md is the only hand-edited home for secondmate identity and
// scope; data/<id>/brief.md and <home>/data/charter.md are both generated
// projections of the registry line for <id> plus the template below; never
// hand-edit them outside the one mate-owned section each carries.

const MATE_SECTION_BEGIN = "<!-- BEGIN MATE-OWNED NOTES: preserved verbatim across regeneration; edit only inside this block -->";
const MATE_SECTION_END = "<!-- END MATE-OWNED NOTES -->";
const MATE_SECTION_DEFAULT = "(no mate-owned notes yet)";

// findSecondmateLine(id, regPath): the raw registry line for id, or null if the
// registry or id is absent.
function findSecondmateLine(id: string, regPath: string): string | null {
	if (!existsSync(regPath)) return null;
	const lines = readFileSync(regPath, "utf8").split(/\r?\n/);
	for (const line of lines) {
		if (!line.startsWith("- ")) continue;
		const rest = line.slice(2);
		const rid = rest.split(" ")[0];
		if (rid === id) return line;
	}
	return null;
}

// secondmateSummary(line, id): the charter-summary text between "<id> - " and
// " (home:" on a registry line.
function secondmateSummary(line: string, id: string): string {
	let rest = line.startsWith("- ") ? line.slice(2) : line;
	if (rest.startsWith(id)) rest = rest.slice(id.length);
	if (rest.startsWith(" - ")) rest = rest.slice(3);
	const idx = rest.indexOf(" (home:");
	if (idx !== -1) rest = rest.slice(0, idx);
	return rest;
}

interface SecondmateFields {
	home: string;
	workspace: string;
	name: string;
	scope: string;
	projects: string;
	added: string;
}

function cutBefore(s: string, sep: string): string {
	const idx = s.indexOf(sep);
	return idx === -1 ? s : s.slice(0, idx);
}

function cutAfter(s: string, sep: string): string {
	const idx = s.indexOf(sep);
	return idx === -1 ? s : s.slice(idx + sep.length);
}

// secondmateParseFields(line): the registry line's parenthesized field block,
// anchored on fixed literal "; <field>: " separators (not a naive "; " split),
// so a semicolon inside a field's own free text (e.g. the scope prose) never
// misparses as a field boundary.
function secondmateParseFields(line: string): SecondmateFields {
	const openIdx = line.indexOf("(");
	let inner = openIdx === -1 ? "" : line.slice(openIdx + 1);
	if (inner.endsWith(")")) inner = inner.slice(0, -1);
	let rest = inner;
	if (rest.startsWith("home: ")) rest = rest.slice("home: ".length);

	let home: string;
	let workspace: string;
	if (rest.includes("; workspace: ")) {
		home = cutBefore(rest, "; workspace: ");
		rest = cutAfter(rest, "; workspace: ");
		workspace = cutBefore(rest, "; name: ");
		rest = cutAfter(rest, "; name: ");
	} else {
		home = cutBefore(rest, "; name: ");
		workspace = "";
		rest = cutAfter(rest, "; name: ");
	}
	const name = cutBefore(rest, "; scope: ");
	rest = cutAfter(rest, "; scope: ");
	const scope = cutBefore(rest, "; projects: ");
	rest = cutAfter(rest, "; projects: ");
	const projects = cutBefore(rest, "; added ");
	rest = cutAfter(rest, "; added ");
	const added = rest;
	return { home, workspace, name, scope, projects, added };
}

// resolveEscalationName(configDir): the main firstmate's display name for prose
// escalation text, resolved from config/identity name= at generation time.
// Falls back to "the main firstmate" (not identity.ts's generic "firstmate"
// default) so a generated charter never hard-codes a specific mate's name.
function resolveEscalationName(configDir: string): string {
	return identityValue(configDir, "name") ?? "the main firstmate";
}

// formatProjectLines(csv): a registry "projects:" csv field rendered as a
// bulleted list, or the pure-domain placeholder when empty/"(none)".
function formatProjectLines(csv: string): string {
	if (!csv || csv === "(none)") {
		return "(none) - pure-domain secondmate; your work surface is this firstmate home.";
	}
	return csv
		.split(",")
		.map(part => part.trim())
		.map(part => `- ${part}`)
		.join("\n");
}

// extractMateOwned(file): the verbatim content between the mate-owned markers
// in file, or the empty scaffold placeholder when file is missing or lacks
// both markers.
function extractMateOwned(file: string): string {
	if (!existsSync(file)) return MATE_SECTION_DEFAULT;
	const content = readFileSync(file, "utf8");
	if (!content.includes(MATE_SECTION_BEGIN) || !content.includes(MATE_SECTION_END)) {
		return MATE_SECTION_DEFAULT;
	}
	const lines = content.split(/\r?\n/);
	let capture = false;
	const out: string[] = [];
	for (const line of lines) {
		if (line === MATE_SECTION_BEGIN) {
			capture = true;
			continue;
		}
		if (line === MATE_SECTION_END) {
			capture = false;
			continue;
		}
		if (capture) out.push(line);
	}
	return out.join("\n");
}

// renderSecondmateProjection(id, line, configDir, priorMateOwned): the full
// generated charter/brief text for a registered secondmate.
function renderSecondmateProjection(id: string, line: string, configDir: string, priorMateOwned: string): string {
	const fields = secondmateParseFields(line);
	const charterText = secondmateSummary(line, id);
	const escalationName = resolveEscalationName(configDir);
	const escalationSlug = supervisorSlug(configDir);
	const projectLines = formatProjectLines(fields.projects);

	return `You are a secondmate: a persistent domain supervisor managed by the main firstmate. Work on your own; do not wait for a human.

<!-- fm-charter: schema-version=1; generated from data/secondmates.md via fm brief; do not hand-edit outside the mate-owned section below -->

# Charter
You are ${fields.name}, a persistent secondmate managed by the main firstmate.
${charterText}

# Routing scope
${fields.scope}

# Project clones
${projectLines}

# Operating model
You are in an isolated firstmate home.
Your local \`data/\`, \`state/\`, \`config/\`, and \`projects/\` directories are yours to operate.
The projects above are local clones for work you supervise; they are not an exclusive ownership claim.
OMP injects the applicable \`AGENTS.md\` at session start.
Do not tool-read it during ordinary boot or recovery.
At startup, read only this charter, compact \`data/cap.md\`, \`data/backlog.md:1-20\`, the local \`state/\` listing plus active \`.meta\` and \`.status\` files, pending peer messages, and the current whiteboard diff.
Use selectors and persisted artifacts instead of whole-file evidence reads or broad directory searches.
Delegate investigation after three primary-thread tool calls unless the next call conclusively closes the decision.
Delegate project work to your own crewmates with the normal firstmate lifecycle: brief, spawn, direct crewmate status-file reporting, \`fm send\` pane steering, teardown, and recovery.
Do not invent a second delegation system.
When driving a visible pane or remote machine, state the diagnostic intent first, then send short human-legible expert commands one by one.
Do not paste chained shell blobs, printf sentinels, or noisy echo scaffolding into the pane.
You do not generate your own work.
Act only on tasks the main firstmate routes to you.
Never start a survey, audit, or "find improvements" sweep on your own initiative; that is not your job and it is unwanted.
Supervision is automatic and in-process; there is no watcher, wake-queue, beacon, or separate supervisor process.
Relevant fleet changes coalesce into one non-visible attention edge; on that edge, read \`fm fleet\` once for the authoritative snapshot rather than expecting event payloads or per-event continuations.

${LEAN_LOOP_BLOCK}

${HOUSE_TOOLING_BLOCK}

# Escalation to main firstmate
Handle routine work yourself.
Escalate only cap-actionable transition states - \`done\`, \`blocked\`, \`needs-decision\`, \`failed\`, or a material phase change - through the fleet peer bus.
Use the agent tool peer_send when available, or type /peer send ${escalationSlug} "{state}: {one short line}" from the composer, addressed to ${escalationName}; set priority only for cap-blocking decisions, failures, or work ready for review.
States: needs-decision, blocked, done, failed.
Routine internal supervision, heartbeats, retries, and crewmate churn stay inside your own home and must not touch the supervisor channel.

# Definition of done
You are persistent by default. Do not exit just because your queue is empty.
On startup and restart, run normal firstmate bootstrap and recovery for your own home, but only to RECONCILE work that is already yours: in-flight crewmates, tracked backlog items, and durable watches recorded in this home.
When you have no assigned or in-flight work after that reconciliation, go idle and wait silently for the main firstmate to route you a task.
An empty queue is a healthy resting state, not a cue to invent work: never spawn a survey, audit, or any self-directed "find work" task on your own initiative.
If this charter cannot be carried out, send blocked: {why} or failed: {why} to the main firstmate through the fleet peer bus and stop.

# Mate-owned notes
${MATE_SECTION_BEGIN}
${priorMateOwned}
${MATE_SECTION_END}`;
}

// checkProjection(path, expected): missing (message to stderr, false) / missing
// either mate-owned marker (message, false) / differs from expected (message,
// false) / else true.
function checkProjection(path: string, expected: string): boolean {
	if (!existsSync(path)) {
		process.stderr.write(`check: missing projection: ${path}\n`);
		return false;
	}
	const raw = readFileSync(path, "utf8");
	if (!raw.includes(MATE_SECTION_BEGIN) || !raw.includes(MATE_SECTION_END)) {
		process.stderr.write(`check: projection missing mate-owned section markers: ${path}\n`);
		return false;
	}
	const actual = raw.replace(/\n+$/, "");
	if (actual !== expected) {
		process.stderr.write(`check: projection differs from registry-generated content: ${path}\n`);
		return false;
	}
	return true;
}

// cmdRegenOrCheck(mode, id): looks id up in data/secondmates.md, renders both
// projections (each preserving its own current mate-owned section verbatim),
// then either writes them (regen) or diffs them against what is on disk (check).
function cmdRegenOrCheck(mode: "regen" | "check", id: string, paths: Paths): number {
	const line = findSecondmateLine(id, joinPath(paths.data, "secondmates.md"));
	if (line === null) {
		process.stderr.write(`error: no registered secondmate '${id}' in ${joinPath(paths.data, "secondmates.md")}\n`);
		return 1;
	}
	const fields = secondmateParseFields(line);
	const briefPath = joinPath(paths.data, id, "brief.md");
	const charterPath = joinPath(fields.home, "data", "charter.md");

	const briefPrior = extractMateOwned(briefPath);
	const charterPrior = extractMateOwned(charterPath);
	const briefContent = renderSecondmateProjection(id, line, paths.config, briefPrior);
	const charterContent = renderSecondmateProjection(id, line, paths.config, charterPrior);

	if (mode === "regen") {
		mkdirSync(dirname(briefPath), { recursive: true });
		writeFileSync(briefPath, `${briefContent}\n`);
		mkdirSync(dirname(charterPath), { recursive: true });
		writeFileSync(charterPath, `${charterContent}\n`);
		process.stdout.write(`regenerated: ${briefPath}\n`);
		process.stdout.write(`regenerated: ${charterPath}\n`);
		return 0;
	}

	let failed = false;
	if (!checkProjection(briefPath, briefContent)) failed = true;
	if (!checkProjection(charterPath, charterContent)) failed = true;
	if (failed) return 1;
	process.stdout.write(`check: ok (${id})\n`);
	return 0;
}

const USAGE = `usage: fm brief <id> <repo> [worker-args...]        generate a ship brief
       fm brief --scout <id> <repo> [args...]       generate a scout brief
       fm brief --secondmate <id> [project...]      scaffold a secondmate charter
       fm brief --regen <id>                        regenerate projections
       fm brief --check <id>                        verify projections`;

function usage(code: number): number {
	process.stderr.write(`${USAGE}\n`);
	return code;
}

// assignmentContract(): static block folded into every ship/scout brief.
const ASSIGNMENT_CONTRACT = `# Assignment contract
The \`# Task\` section is the complete assignment and the only required pre-spawn substitution is \`{TASK}\`.
Before work begins, extract and record these values from the task text:
- Falsifiable goal (exactly one): state one measurable outcome the task must achieve.
- Named deliverable path (exactly one): state the file, report, branch, or PR that will carry the result.
- Evidence packet: cite stable source references such as \`path:line\`, \`commit:<full-sha>:path:line\`, or a durable URL.
- Acceptance criteria:
  - preserve every criterion stated in the \`# Task\` section and verify each one.
- Non-goals: honor explicit exclusions in the task and do not add unrelated scope.
- Stopping point: stop only after the acceptance criteria are verified.
- Method owner: You own the specialist method.
  Choose, execute, and justify the method needed to meet the goal; escalate only a real decision or blocker.
- Blocker: report \`none\` unless a real blocker prevents completion.
- Next action: report the next concrete action while work is in progress, or \`none\` when complete.
- Completion return shape:
  \`done: <delivery status>; goal <falsifiable goal>; deliverable <named deliverable path>; evidence <source-ref,...>; acceptance <criterion=pass|fail,...>; blocker <none|...>; next action <none|...>\`
Use the extracted values in status updates and the final completion report. Do not report completion without evidence and per-criterion pass/fail results.
At completion, replace the angle-bracket labels in the return shape with actual values.`;

function scoutBrief(id: string, repo: string, dataDir: string, reportHelper: string, statusFile: string): string {
	return `You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
{TASK}

${ASSIGNMENT_CONTRACT}

# Setup
You are in a disposable git worktree of ${repo}, at a detached HEAD on a clean default branch.
This is a SCOUT task: the deliverable is a written report, not a PR.
The worktree is your laboratory - install, run, edit, and make scratch commits freely; all of it is discarded at teardown.
The report is the only thing that survives, so anything worth keeping must be in it.

# Rules
1. Never push to any remote and never open a PR.
2. Stay inside this worktree; the only files you may write outside it are the report and the status file below.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. When driving a visible pane or remote machine, state the diagnostic intent first, then send short human-legible expert commands one by one.
   Do not paste chained shell blobs, printf sentinels, or noisy echo scaffolding into the pane.
5. Report status by running:
   ${reportHelper} ${statusFile} "{state}: {one short line}"
   States: working, needs-decision, blocked, done, failed.
   Each report records durable fleet attention and may coalesce into one silent attention edge, so report sparingly: only phase changes a supervisor
   would act on and the needs-decision/blocked/done/failed states. No step-by-step
   FYI progress lines; firstmate reads your pane for that.
6. If you hit the same obstacle twice, report blocked: {why} and stop; firstmate will help.
7. Derive decisions from evidence before escalating: for a config, parameter, or design choice, first consult relevant papers/sources, project docs (\`AGENTS.md\`), and prior fleet research (other worktrees, reports, decision journals). If the evidence points to a clearly better option, take it and justify it in your report - do not punt a solvable decision upward.
8. Escalate a decision to a human ONLY for (a) a genuine toss-up between two equally good options after weighing the evidence, or (b) a destructive, irreversible, or live-capital-risk action. Then report needs-decision: {summary of options + the evidence you weighed} and stop. Firstmate will reply with the decision.

${LEAN_LOOP_BLOCK}

${HOUSE_TOOLING_BLOCK}

# Definition of done
Write your findings to ${joinPath(dataDir, id, "report.md")}.
The report must stand alone: what you did, what you found, the evidence (commands run, output, file:line references), and what you recommend.
When the report is complete, append \`done: report ${joinPath(dataDir, id, "report.md")}; goal <falsifiable goal>; deliverable <named deliverable path>; evidence <source-ref,...>; acceptance <criterion=pass|fail,...>; blocker <none|...>; next action <none|...>\` to the status file, then stop. The status file is the supervisor signal; do not require peer-bus access from a disposable scout.
If your findings reveal work that should ship (e.g. you reproduced a bug and the fix is clear), say so in the report; firstmate may promote this task in place, and you would then receive mode-specific ship instructions as a follow-up message.`;
}

interface ShipModeText {
	setup2: string;
	rule1: string;
	dod: string;
}

function shipModeText(mode: string, id: string): ShipModeText {
	if (mode === "trunk") {
		return {
			setup2: "",
			rule1: `1. Never push to any remote and never open a PR. Work only on your \`fm/${id}\` branch; produce a candidate for trunk land.`,
			dod: `# Definition of done
This project ships **trunk**: consolidated local default branch, no GitHub review surface required.
The worker task is complete when a candidate is committed on \`fm/${id}\` with focused checks green. Do NOT push, do NOT open a PR, do NOT merge.
Before you finish, run the focused checks the project already uses (the tests and lints that cover your change) and confirm they pass; fix anything you broke.
Keep your branch a clean fast-forward onto the current default branch - if \`main\` has advanced, rebase onto it so integrate stays a fast-forward.
When it is implemented and committed, append \`done: ready in branch fm/${id}; goal <falsifiable goal>; deliverable <named deliverable path>; evidence <source-ref,...>; acceptance <criterion=pass|fail,...>; blocker <none|...>; next action <none|...>\` to the status file, then stop. The status file is the supervisor signal; do not require peer-bus access from a disposable worker.
Firstmate judges with \`fm accept\` / \`fm revise\`, then drains with \`fm finish\` (integrate, land, backlog close, cleanup).`,
		};
	}
	// pr (default)
	return {
		setup2: "",
		rule1: `1. Never push to the default branch (push only your \`fm/${id}\` branch). Never merge a PR.`,
		dod: `# Definition of done
This project ships **pr**: collaborative delivery via GitHub PR against a moving upstream HEAD.
The worker task is complete only when a PR is open and its URL is reported. Push \`fm/${id}\`, open the PR with \`gh-axi\`, then stop.
Before you finish, run the focused checks the project already uses (the tests and lints that cover your change) and confirm they pass, then review your own diff for correctness and scope.
When it is implemented and committed: push your branch, open a PR with \`gh-axi\`, then append \`done: PR {url}; goal <falsifiable goal>; deliverable <named deliverable path>; evidence <source-ref,...>; acceptance <criterion=pass|fail,...>; blocker <none|...>; next action <none|...>\` to the status file, then stop. Do not report done without a PR URL.
Write the PR body in the standard format: a 1-2 line summary, then \`## Summary\` with a concrete visualize-the-change example - a command and its output, or a short before/after - then \`## Refs\` with the PR/issue/report links. The publish guard requires this.
Firstmate judges with \`fm accept\` / \`fm revise\` (accept requires the PR URL), then drains with \`fm finish\` (observes the PR, lands when merged, closes backlog, cleanup). \`fm send\` is for revise/steer only, never post-accept landing.`,
	};
}

function shipBrief(id: string, repo: string, mode: string, reportHelper: string, statusFile: string, fmRoot: string): string {
	const { setup2, rule1, dod } = shipModeText(mode, id);
	return `You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
{TASK}

${ASSIGNMENT_CONTRACT}

# Setup
You are in a disposable git worktree of ${repo}, already on your branch \`fm/${id}\` (created off a clean default branch).
1. First action: confirm with \`git branch --show-current\`; do not create or switch branches.${setup2}

# Rules
${rule1}
2. Stay inside this worktree; modify nothing outside it.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. When driving a visible pane or remote machine, state the diagnostic intent first, then send short human-legible expert commands one by one.
   Do not paste chained shell blobs, printf sentinels, or noisy echo scaffolding into the pane.
5. Report status by running:
   ${reportHelper} ${statusFile} "{state}: {one short line}"
   States: working, needs-decision, blocked, done, failed.
   Each report records durable fleet attention and may coalesce into one silent attention edge, so report sparingly: only phase changes a supervisor
   would act on (setup done, bug reproduced, fix implemented, validation passed) and the
   needs-decision/blocked/done/failed states. No step-by-step FYI progress lines;
   firstmate reads your pane for that.
6. If you hit the same obstacle twice, report blocked: {why} and stop; firstmate will help.
7. Derive decisions from evidence before escalating: for a config, parameter, or design choice, first consult relevant papers/sources, project docs (\`AGENTS.md\`), and prior fleet research (other worktrees, reports, decision journals). If the evidence points to a clearly better option, take it and justify it in your report - do not punt a solvable decision upward.
8. Escalate a decision to a human ONLY for (a) a genuine toss-up between two equally good options after weighing the evidence, or (b) a destructive, irreversible, or live-capital-risk action (product choices, ask-user findings included). Then report needs-decision: {summary of options + the evidence you weighed} and stop. Firstmate will reply with the decision.

# Project memory
If \`AGENTS.md\` or \`CLAUDE.md\` already exists, or if this task produced durable project-intrinsic knowledge, run \`${joinPath(fmRoot, "sbin", "fm")} ensure-agents-md .\` in the worktree.
If this task produced durable project-intrinsic knowledge, record it in \`AGENTS.md\` as part of your change.
Keep it proportionate: skip \`AGENTS.md\` edits for trivial tasks that produced no durable project knowledge.

${LEAN_LOOP_BLOCK}

${HOUSE_TOOLING_BLOCK}

${dod}`;
}

function secondmateScaffold(id: string, projects: string[], charter: string, scope: string, supervisorId: string): string {
	const projectList = projects.map(p => `- ${p}`).join("\n");
	return `You are a secondmate: a persistent domain supervisor managed by the main firstmate. Work on your own; do not wait for a human.

# Charter
${charter}

# Routing scope
${scope}

# Project clones
${projectList}

# Operating model
You are in an isolated firstmate home. The local \`AGENTS.md\` is your job description, and your local \`data/\`, \`state/\`, \`config/\`, and \`projects/\` dirs are yours to operate.
The projects above are local clones for work you supervise; they are not an exclusive ownership claim.
Delegate project work to your own crewmates with the normal firstmate lifecycle: brief, spawn, direct crewmate status-file reporting, \`fm send\` pane steering, teardown, and recovery.
Do not invent a second delegation system.
When driving a visible pane or remote machine, state the diagnostic intent first, then send short human-legible expert commands one by one.
Do not paste chained shell blobs, printf sentinels, or noisy echo scaffolding into the pane.
You do not generate your own work.
Act only on tasks the main firstmate routes to you.
Never start a survey, audit, or "find improvements" sweep on your own initiative; that is not your job and it is unwanted.
Supervision is automatic and in-process; there is no watcher, wake-queue, beacon, or separate supervisor process.
Relevant fleet changes coalesce into one non-visible attention edge; on that edge, read \`fm fleet\` once for the authoritative snapshot rather than expecting event payloads or per-event continuations.

${LEAN_LOOP_BLOCK}

${HOUSE_TOOLING_BLOCK}

# Escalation to main firstmate
Handle routine work yourself.
Escalate only cap-actionable transition states - \`done\`, \`blocked\`, \`needs-decision\`, \`failed\`, or a material phase change - through the fleet peer bus.
Use the agent tool peer_send when available, or type /peer send ${supervisorId} "{state}: {one short line}" from the composer; set priority only for cap-blocking decisions, failures, or work ready for review.
States: needs-decision, blocked, done, failed.
Use this only for material phase changes, a cap decision, a real blocker, a failure, or work ready for review.
Derive decisions from evidence before escalating: for a config, parameter, or design choice, first consult relevant papers/sources, project docs, and prior fleet research (other mates' worktrees, reports, decision journals). If the evidence points to a clearly better option, take it and justify it - escalate a decision ONLY for a genuine toss-up between equally good options or a destructive/irreversible/live-capital-risk action. Never punt a solvable decision upward.
Routine internal supervision, heartbeats, retries, and crewmate churn stay inside your own home and must not touch the supervisor channel.

# Definition of done
You are persistent by default. Do not exit just because your queue is empty.
On startup and restart, run normal firstmate bootstrap and recovery for your own home, but only to RECONCILE work that is already yours: in-flight crewmates, tracked backlog items, and durable watches recorded in this home.
When you have no assigned or in-flight work after that reconciliation, go idle and wait silently for the main firstmate to route you a task.
An empty queue is a healthy resting state, not a cue to invent work: never spawn a survey, audit, or any self-directed "find work" task on your own initiative.
If this charter cannot be carried out, send blocked: {why} or failed: {why} to the main firstmate through the fleet peer bus and stop.`;
}

// resolveProjectMode(repo, fmRoot): reads the project's delivery mode by
// invoking `fm project-mode <repo>` (the registered dispatcher verb) and
// taking the first whitespace-separated token of its output, mirroring the
// former script's `read -r MODE _ <<< "$(fm project-mode "$REPO")"`.
function resolveProjectMode(repo: string, fmRoot: string): string {
	const result = spawnSync(joinPath(fmRoot, "sbin", "fm"), ["project-mode", repo], { encoding: "utf8" });
	const out = result.stdout ?? "";
	return out.trim().split(/\s+/)[0] ?? "";
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const first = args[0];

	if (first === "-h" || first === "--help") return usage(0);

	const paths = resolvePaths();

	if (first === "--regen") {
		if (args.length !== 2) {
			process.stderr.write("usage: fm brief --regen <id>\n");
			return 1;
		}
		return cmdRegenOrCheck("regen", args[1], paths);
	}
	if (first === "--check") {
		if (args.length !== 2) {
			process.stderr.write("usage: fm brief --check <id>\n");
			return 1;
		}
		return cmdRegenOrCheck("check", args[1], paths);
	}

	let kind: "ship" | "scout" | "secondmate" = "ship";
	const pos: string[] = [];
	for (const a of args) {
		if (a === "--scout") kind = "scout";
		else if (a === "--secondmate") kind = "secondmate";
		else if (a.startsWith("-")) {
			process.stderr.write(`error: unknown flag: ${a}\n`);
			return usage(1);
		} else pos.push(a);
	}
	if (pos.length < 1) return usage(1);
	const id = pos[0];

	const briefPath = joinPath(paths.data, id, "brief.md");
	if (existsSync(briefPath)) {
		process.stderr.write(`error: ${briefPath} already exists\n`);
		return 1;
	}
	mkdirSync(joinPath(paths.data, id), { recursive: true });

	const statusFile = shellQuote(joinPath(paths.state, `${id}.status`));
	const reportHelper = `${shellQuote(joinPath(paths.fmRoot, "sbin", "fm"))} report`;

	if (kind === "secondmate") {
		const secondmateProjects = pos.slice(1);
		if (secondmateProjects.length === 0) {
			process.stderr.write("error: --secondmate requires at least one project\n");
			return 1;
		}
		const envCharter = envOrUndefined("FM_SECONDMATE_CHARTER");
		const charter = envCharter ?? "{TASK}";
		const scope = envOrUndefined("FM_SECONDMATE_SCOPE") ?? charter;
		const supervisorId = supervisorSlug(paths.config);
		const content = secondmateScaffold(id, secondmateProjects, charter, scope, supervisorId);
		writeFileSync(briefPath, `${content}\n`);
		if (charter === "{TASK}") {
			process.stdout.write(`scaffolded: ${briefPath} (secondmate charter; replace {TASK})\n`);
		} else {
			process.stdout.write(`scaffolded: ${briefPath} (secondmate charter)\n`);
		}
		return 0;
	}

	if (pos.length < 2) {
		process.stderr.write(`error: ${kind} briefs need <id> <repo>\n`);
		return usage(1);
	}
	const repo = pos[1];

	if (kind === "scout") {
		const content = scoutBrief(id, repo, paths.data, reportHelper, statusFile);
		writeFileSync(briefPath, `${content}\n`);
		process.stdout.write(`scaffolded: ${briefPath} (scout; replace {TASK})\n`);
		return 0;
	}

	// Ship task: shape Setup / Rule 1 / Definition of done by the project's
	// delivery mode. yolo does not affect the brief (it governs firstmate's
	// approval behaviour), so discard it.
	const mode = resolveProjectMode(repo, paths.fmRoot);
	const content = shipBrief(id, repo, mode, reportHelper, statusFile, paths.fmRoot);
	writeFileSync(briefPath, `${content}\n`);
	process.stdout.write(`scaffolded: ${briefPath} (ship, mode=${mode}; replace {TASK})\n`);
	return 0;
}

export default {
	name: "brief",
	describe: "Scaffold a crewmate brief or persistent secondmate charter, and regenerate/check registry-driven secondmate projections.",
	run,
};
