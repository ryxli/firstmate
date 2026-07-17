#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decode } from "@toon-format/toon";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const cli = join(root, "sbin", "fm");
const temp = mkdtempSync(join(tmpdir(), "fm-axi-update-test-"));
const origin = join(temp, "origin.git");
const seed = join(temp, "seed");
const source = join(temp, "source");
const target = join(temp, "target");
const other = join(temp, "other");
const legacy = join(temp, "legacy");
const seeded = join(temp, "seeded");
const seededPanes = join(temp, "seeded-panes.json");
const seededTransaction = join(temp, "seeded-state", "fleet-update.json");
const seededReload = join(temp, "seeded-reload.sh");
const seededReloadLog = join(temp, "seeded-reload.log");
const wholeSeeded = join(temp, "whole-seeded");
const wholePanes = join(temp, "whole-panes.json");
const wholeTransaction = join(temp, "whole-state", "fleet-update.json");
const wholeReload = join(temp, "whole-reload.sh");
const wholeReloadLog = join(temp, "whole-reload.log");
const panes = join(temp, "panes.json");
const registry = join(source, ".omp", "fleet-capabilities.json");
const transaction = join(source, "state", "fleet-update.json");
const reload = join(temp, "reload.sh");
const reloadLog = join(temp, "reload.log");

function run(command, args, cwd = root, extra = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...extra } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function git(args, cwd) {
  return run("git", args, cwd);
}

function receipt(home, revision, pane, session, probe) {
  const manifest = [
    { path: "AGENTS.md", sha256: createHash("sha256").update(readFileSync(join(home, "AGENTS.md"))).digest("hex") },
    { path: ".omp/extensions/bridge.ts", sha256: createHash("sha256").update(readFileSync(join(home, ".omp", "extensions", "bridge.ts"))).digest("hex") },
  ];
  const registry = join(home, ".omp", "fleet-capabilities.json");
  if (existsSync(registry)) manifest.push({ path: ".omp/fleet-capabilities.json", sha256: createHash("sha256").update(readFileSync(registry)).digest("hex") });
  const digest = createHash("sha256");
  for (const entry of manifest.sort((a, b) => a.path.localeCompare(b.path))) digest.update(`${entry.path}\0${entry.sha256}\0`);
  return { schema: "firstmate.activation-receipt/v1", source_revision: revision, manifest_sha256: digest.digest("hex"), pane_id: pane, session_id: session, started_at: "2026-07-14T00:00:00Z", required_probe_result: probe, manifest };
}

function linkedReceipt(home, sourceRoot, revision, pane, session, probe, overrides = {}) {
  const paths = ["AGENTS.md", ".omp/fleet-capabilities.json", ".omp/extensions/bridge.ts", ".omp/extensions/linked/entry.ts"];
  const manifest = paths.map((path) => {
    const bytes = overrides[path] ?? readFileSync(path === ".omp/fleet-capabilities.json" ? join(sourceRoot, path) : join(home, path));
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const digest = createHash("sha256");
  for (const entry of manifest) digest.update(`${entry.path}\0${entry.sha256}\0`);
  return { schema: "firstmate.activation-receipt/v1", source_revision: revision, manifest_sha256: digest.digest("hex"), pane_id: pane, session_id: session, started_at: "2026-07-14T00:00:00Z", required_probe_result: probe, manifest };
}

try {
  run("git", ["init", "--bare", "--initial-branch=main", origin]);
  run("git", ["init", seed]);
  git(["config", "user.email", "fmtest@example.com"], seed);
  git(["config", "user.name", "fmtest"], seed);
  mkdirSync(join(seed, ".omp", "extensions"), { recursive: true });
  writeFileSync(join(seed, "AGENTS.md"), "v1\n");
  writeFileSync(join(seed, ".omp", "extensions", "bridge.ts"), "export const revision = 1;\n");
  writeFileSync(join(seed, ".omp", "fleet-capabilities.json"), JSON.stringify({ schema: "firstmate.capability-registry/v1", targets: [
    { id: "target", home: target, source_revision: "0000000000000000000000000000000000000000", surfaces: ["AGENTS.md", ".omp/extensions/bridge.ts"], required_probe_result: { activation: "ok" }, reload_target: "wrong-target" },
    { id: "unaffected", home: other, source_revision: "0000000000000000000000000000000000000000", surfaces: ["README.md"], required_probe_result: { activation: "ok" }, reload_target: "wrong-unaffected-target" },
  ] }));
  git(["add", "-A"], seed);
  git(["commit", "-q", "--no-verify", "-m", "v1"], seed);
  git(["branch", "-M", "main"], seed);
  git(["remote", "add", "origin", origin], seed);
  git(["push", "-q", "origin", "main"], seed);
  run("git", ["clone", "-q", origin, source]);
  run("git", ["clone", "-q", origin, target]);
  run("git", ["clone", "-q", origin, other]);
  run("git", ["clone", "-q", origin, legacy]);
  mkdirSync(join(legacy, ".git", "info"), { recursive: true });
  writeFileSync(join(legacy, ".git", "info", "exclude"), "state/\n");
  mkdirSync(join(target, ".git", "info"), { recursive: true });
  writeFileSync(join(target, ".git", "info", "exclude"), "state/\n");
  for (const repo of [source, target, other, legacy]) {
    git(["config", "user.email", "fmtest@example.com"], repo);
    git(["config", "user.name", "fmtest"], repo);
  }
  const oldRevision = git(["rev-parse", "HEAD"], source);
  writeFileSync(join(seed, "AGENTS.md"), "v2\n");
  writeFileSync(join(seed, ".omp", "extensions", "bridge.ts"), "export const revision = 2;\n");
  git(["add", "-A"], seed);
  git(["commit", "-q", "--no-verify", "-m", "v2"], seed);
  git(["push", "-q", "origin", "main"], seed);
  git(["pull", "-q", "--ff-only", "origin", "main"], source);
  const newRevision = git(["rev-parse", "HEAD"], source);

  mkdirSync(join(target, "state"), { recursive: true });
  writeFileSync(join(target, "state", "activation-receipt.json"), JSON.stringify(receipt(target, oldRevision, "w1:p1", "session-target", { activation: "ok" })));
  writeFileSync(panes, JSON.stringify({ result: { panes: [
    { pane_id: "w1:p1", cwd: target, agent: "omp", agent_status: "idle", agent_session_id: "session-target" },
  ] } }));
  writeFileSync(reload, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${reloadLog}'\ncat > '${join(target, "state", "activation-receipt.json")}' <<'JSON'\n${JSON.stringify(receipt(source, newRevision, "w1:p1", "session-target", { activation: "ok" }))}\nJSON\n`);
  chmodSync(reload, 0o755);

  const env = { FM_HOME: source, FM_FLEET_UPDATE_STATE: transaction, FM_FLEET_RELOAD_SCRIPT: reload, FM_FLEET_PANES_FILE: panes };
  writeFileSync(panes, JSON.stringify({ result: { panes: [
    { pane_id: "w1:p1", cwd: target, agent: "omp", agent_status: "working", agent_session_id: "session-target" },
    { pane_id: "w1:p2", cwd: other, agent: "omp", agent_status: "working", agent_session_id: "session-other" },
  ] } }));
  const working = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (working.status !== 1) throw new Error(`working target was not pending: ${working.stdout}`);
  if (git(["rev-parse", "HEAD"], target) !== oldRevision || existsSync(reloadLog)) throw new Error("working target was changed");
  writeFileSync(panes, JSON.stringify({ result: { panes: [
    { pane_id: "w1:p1", cwd: target, agent: "omp", agent_status: "idle", agent_session_id: "session-target" },
    { pane_id: "w1:p2", cwd: other, agent: "omp", agent_status: "working", agent_session_id: "session-other" },
  ] } }));
  const first = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (first.status !== 0) throw new Error(`successful update exited ${first.status}: ${first.stdout}`);
  const firstPayload = decode(first.stdout, { expandPaths: "safe" });
  if (!firstPayload.result?.results) throw new Error(`successful update returned no result: ${first.stdout}`);
  const firstResult = firstPayload.result.results[0];
  if (firstResult.status !== "ready" || firstResult.action !== "reload") throw new Error(`successful receipt path was not ready/reload: ${first.stdout}`);
  if (firstResult.proof.source_revision !== newRevision || !firstResult.proof.manifest_sha256 || firstResult.proof.session_identity.session_id !== "session-target" || firstResult.proof.required_probe_result.activation !== "ok") throw new Error(`receipt proof incomplete: ${first.stdout}`);
  const unaffectedResult = firstPayload.result.results.find(row => row.target === "unaffected");
  if (unaffectedResult) throw new Error(`registered unaffected home was selected: ${first.stdout}`);
  if (git(["rev-parse", "HEAD"], other) !== oldRevision) throw new Error("registered unaffected home was updated");
  if (readFileSync(reloadLog, "utf8") !== "w1:p1\n") throw new Error(`reload used an unrelated target: ${readFileSync(reloadLog, "utf8")}`);
  console.log("ok - registry selects only affected homes and proves the receipt path");
  const beforeReadyNoopReloads = readFileSync(reloadLog, "utf8");
  const readyNoop = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (readyNoop.status !== 0) throw new Error(`complete ready receipt rerun exited ${readyNoop.status}: ${readyNoop.stdout}`);
  const readyNoopPayload = decode(readyNoop.stdout, { expandPaths: "safe" });
  if (readyNoopPayload.result.results.length !== 0 || readFileSync(reloadLog, "utf8") !== beforeReadyNoopReloads) throw new Error(`complete ready receipt rerun was not an empty no-op: ${readyNoop.stdout}`);
  console.log("ok - complete bound ready receipt permits an empty no-op");

  mkdirSync(join(legacy, "state"), { recursive: true });
  const legacyReceipt = receipt(legacy, oldRevision, "w1:p3", "session-legacy", { activation: "ok" });
  legacyReceipt.schema = "firstmate.activation-receipt/v0";
  delete legacyReceipt.required_probe_result;
  writeFileSync(join(legacy, "state", "activation-receipt.json"), JSON.stringify(legacyReceipt));
  writeFileSync(registry, JSON.stringify({ schema: "firstmate.capability-registry/v1", targets: [
    { id: "target", home: target, source_revision: oldRevision, surfaces: ["AGENTS.md", ".omp/extensions/bridge.ts"], required_probe_result: { activation: "ok" }, reload_target: "wrong-target" },
    { id: "legacy", home: legacy, source_revision: oldRevision, surfaces: ["AGENTS.md"], required_probe_result: { activation: "ok" }, reload_target: "wrong-legacy-target" },
  ] }));
  writeFileSync(reload, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${reloadLog}'\ncat > '${join(target, "state", "activation-receipt.json")}' <<'JSON'\n${JSON.stringify(receipt(source, newRevision, "w1:p1", "session-target", { activation: "ok" }))}\nJSON\n`);
  chmodSync(reload, 0o755);
  writeFileSync(panes, JSON.stringify({ result: { panes: [
    { pane_id: "w1:p1", cwd: target, agent: "omp", agent_status: "idle", agent_session_id: "session-target" },
    { pane_id: "w1:p3", cwd: legacy, agent: "omp", agent_status: "idle", agent_session_id: "session-legacy" },
  ] } }));
  const beforeLegacyReloads = existsSync(reloadLog) ? readFileSync(reloadLog, "utf8") : "";
  const legacyRun = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (legacyRun.status !== 1) throw new Error(`legacy receipt run exited ${legacyRun.status}: ${legacyRun.stdout}`);
  const legacyPayload = decode(legacyRun.stdout, { expandPaths: "safe" });
  const legacyResult = legacyPayload.result.results.find(row => row.target === "legacy");
  if (!legacyResult || legacyResult.status !== "pending" || legacyResult.action !== "fast-forward" || !legacyResult.reason.includes("incomplete")) throw new Error(`legacy receipt was not fast-forwarded before pending: ${legacyRun.stdout}`);
  if (git(["rev-parse", "HEAD"], legacy) !== newRevision) throw new Error("legacy target was not fast-forwarded");
  if ((existsSync(reloadLog) ? readFileSync(reloadLog, "utf8") : "") !== `${beforeLegacyReloads}w1:p1\n`) throw new Error("registry revision did not reload every selected live target");
  console.log("ok - legacy receipt fast-forwarded before pending");

  const beforeReloads = readFileSync(reloadLog, "utf8");
  const second = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (second.status !== 1) throw new Error(`pending rerun exited ${second.status}: ${second.stdout}`);
  const secondPayload = decode(second.stdout, { expandPaths: "safe" });
  const preserved = secondPayload.result.results.find(row => row.target === "legacy");
  if (!preserved || preserved.status !== "pending" || !preserved.reason.includes("incomplete")) throw new Error(`incomplete prior target was erased on rerun: ${second.stdout}`);
  if (readFileSync(reloadLog, "utf8") !== beforeReloads) throw new Error("pending rerun restarted the session");
  console.log("ok - incomplete prior target remains pending on rerun");
  mkdirSync(join(source, "data"), { recursive: true });
  writeFileSync(join(source, "data", "secondmates.md"), `- legacy - test secondmate (home: ${legacy}; scope: test; projects: test)\n`);
  writeFileSync(registry, JSON.stringify({ schema: "firstmate.capability-registry/v2", roles: [
    { id: "secondmate", selector: { role: "secondmate" }, surfaces: ["AGENTS.md"], required_probe_result: { activation: "ok" } },
  ] }));
  const roleRun = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (roleRun.status !== 1) throw new Error(`dynamic role update exited ${roleRun.status}: ${roleRun.stdout}`);
  const rolePayload = decode(roleRun.stdout, { expandPaths: "safe" });
  if (!rolePayload.result?.results) throw new Error(`dynamic role update returned no result: ${roleRun.stdout}`);
  if (!rolePayload.result.results.some(row => row.target === "secondmate:legacy") || rolePayload.result.results.some(row => row.target === "target")) throw new Error(`dynamic role selector did not resolve current home: ${roleRun.stdout}`);
  console.log("ok - dynamic role selector resolves the current registered home");
  writeFileSync(registry, JSON.stringify({ schema: "firstmate.capability-registry/v1", revision: newRevision, targets: [
    { id: "target", home: target, source_revision: oldRevision, surfaces: ["AGENTS.md", ".omp/extensions/bridge.ts"], required_probe_result: { activation: "ok" }, reload_target: "wrong-target" },
  ] }));
  writeFileSync(reload, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${reloadLog}'\ncat > '${join(target, "state", "activation-receipt.json")}' <<'JSON'\n${JSON.stringify(receipt(source, newRevision, "w1:p1", "session-target", { activation: "ok" }))}\nJSON\n`);
  chmodSync(reload, 0o755);
  const stale = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (stale.status !== 0) throw new Error(`current-head stale receipt was not reloaded: ${stale.stdout}`);
  const stalePayload = decode(stale.stdout, { expandPaths: "safe" });
  const staleResult = stalePayload.result.results.find(row => row.target === "target");
  if (!staleResult || staleResult.status !== "ready" || staleResult.action !== "reload") throw new Error(`current-head stale receipt did not produce a reload: ${stale.stdout}`);
  const beforeIncompleteReloads = readFileSync(reloadLog, "utf8");
  console.log("ok - current-head stale receipt reloads the bound idle session");
  const incompleteReceipt = JSON.parse(readFileSync(join(target, "state", "activation-receipt.json"), "utf8"));
  delete incompleteReceipt.required_probe_result;
  writeFileSync(join(target, "state", "activation-receipt.json"), JSON.stringify(incompleteReceipt));
  writeFileSync(registry, JSON.stringify({ schema: "firstmate.capability-registry/v1", revision: `${newRevision}-receipt`, targets: [
    { id: "target", home: target, source_revision: oldRevision, surfaces: ["AGENTS.md", ".omp/extensions/bridge.ts"], required_probe_result: { activation: "ok" }, reload_target: "wrong-target" },
  ] }));
  const incomplete = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (incomplete.status !== 1) throw new Error(`incomplete receipt exited ${incomplete.status}: ${incomplete.stdout}`);
  const incompletePayload = decode(incomplete.stdout, { expandPaths: "safe" });
  if (incompletePayload.result.results[0].status !== "pending" || !incompletePayload.result.results[0].reason.includes("incomplete")) throw new Error(`incomplete receipt was not pending: ${incomplete.stdout}`);
  if (readFileSync(reloadLog, "utf8") !== beforeIncompleteReloads) throw new Error("incomplete receipt restarted the session");
  console.log("ok - incomplete receipt is pending without a reload");

  const unavailable = join(temp, "unavailable");
  writeFileSync(registry, JSON.stringify({ schema: "firstmate.capability-registry/v1", targets: [
    { id: "target", home: target, source_revision: oldRevision, surfaces: ["AGENTS.md", ".omp/extensions/bridge.ts"], required_probe_result: { activation: "ok" }, reload_target: "wrong-target" },
    { id: "unavailable", home: unavailable, source_revision: oldRevision, surfaces: ["AGENTS.md"], required_probe_result: { activation: "ok" }, reload_target: "wrong-unavailable-target" },
  ] }));
  const third = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (third.status !== 1) throw new Error(`pending unavailable target exited ${third.status}: ${third.stdout}`);
  const thirdPayload = decode(third.stdout, { expandPaths: "safe" });
  const pending = thirdPayload.result.results.find(row => row.target === "unavailable");
  if (!pending || pending.status !== "pending" || !pending.reason.includes("unavailable")) throw new Error(`unavailable target was not pending: ${third.stdout}`);
  console.log("ok - unavailable target is pending without a destructive action");
  writeFileSync(registry, JSON.stringify({ schema: "firstmate.capability-registry/v1", targets: [
    { id: "unbound", home: target, source_revision: oldRevision, surfaces: ["AGENTS.md"], required_probe_result: { activation: "ok" } },
  ] }));
  writeFileSync(panes, JSON.stringify({ result: { panes: [
    { pane_id: "w1:p9", cwd: target, agent: "omp", agent_status: "idle", agent_session_id: "session-other" },
  ] } }));
  const unboundReceipt = JSON.parse(readFileSync(join(target, "state", "activation-receipt.json"), "utf8"));
  unboundReceipt.pane_id = "w1:p9";
  unboundReceipt.session_id = "session-target";
  writeFileSync(join(target, "state", "activation-receipt.json"), JSON.stringify(unboundReceipt));
  const beforeUnboundReloads = readFileSync(reloadLog, "utf8");
  const unbound = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (unbound.status !== 1) throw new Error(`unbound target exited ${unbound.status}: ${unbound.stdout}`);
  const unboundPayload = decode(unbound.stdout, { expandPaths: "safe" });
  const unboundResult = unboundPayload.result.results.find(row => row.target === "unbound");
  if (!unboundResult || unboundResult.status !== "pending" || !unboundResult.reason.includes("unbound")) throw new Error(`unbound target was not pending: ${unbound.stdout}`);
  if (readFileSync(reloadLog, "utf8") !== beforeUnboundReloads) throw new Error("unbound target was reloaded");
  const unboundRerun = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (unboundRerun.status !== 1) throw new Error(`unbound rerun exited ${unboundRerun.status}: ${unboundRerun.stdout}`);
  const unboundRerunPayload = decode(unboundRerun.stdout, { expandPaths: "safe" });
  const preservedUnbound = unboundRerunPayload.result.results.find(row => row.target === "unbound");
  if (!preservedUnbound || preservedUnbound.status !== "pending" || !preservedUnbound.reason.includes("unbound")) throw new Error(`unbound prior target was erased: ${unboundRerun.stdout}`);
  if (readFileSync(reloadLog, "utf8") !== beforeUnboundReloads) throw new Error("unbound rerun reloaded the session");
  console.log("ok - unbound prior target remains pending on rerun");
  const beforeUnsupportedReloads = readFileSync(reloadLog, "utf8");
  writeFileSync(registry, JSON.stringify({ schema: "firstmate.capability-registry/v1", targets: [
    { id: "unsupported", home: target, surfaces: ["AGENTS.md"], required_probe_result: { activation: "ok", version: 1 } },
  ] }));
  const unsupported = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (unsupported.status !== 1 || !unsupported.stdout.includes("OPERATIONAL_ERROR") || !unsupported.stdout.includes("unsupported required_probe_result schema")) throw new Error(`unsupported probe schema was not rejected: ${unsupported.stdout}`);
  if (readFileSync(reloadLog, "utf8") !== beforeUnsupportedReloads) throw new Error("unsupported probe schema triggered a reload");
  console.log("ok - unsupported required probe schema is rejected before pending");
  mkdirSync(join(source, ".omp", "extensions", "linked"), { recursive: true });
  writeFileSync(join(source, ".omp", "extensions", "linked", "entry.ts"), "export const linked = true;\n");
  mkdirSync(join(seeded, ".omp", "extensions"), { recursive: true });
  mkdirSync(join(seeded, "state"), { recursive: true });
  writeFileSync(join(seeded, ".fm-secondmate-home"), "seeded\n");
  writeFileSync(join(seeded, "AGENTS.md"), "v2\n");
  symlinkSync(join(source, ".omp", "extensions", "bridge.ts"), join(seeded, ".omp", "extensions", "bridge.ts"));
  symlinkSync(join(source, ".omp", "extensions", "linked"), join(seeded, ".omp", "extensions", "linked"), "dir");
  writeFileSync(registry, JSON.stringify({ schema: "firstmate.capability-registry/v1", targets: [
    { id: "seeded", home: seeded, source_revision: oldRevision, surfaces: [".omp/extensions/bridge.ts", ".omp/extensions/linked"], required_probe_result: { activation: "ok" } },
  ] }));
  const oldLinkedReceipt = linkedReceipt(seeded, source, oldRevision, "w1:p4", "session-seeded", { activation: "ok" }, {
    "AGENTS.md": Buffer.from("v1\n"),
    ".omp/fleet-capabilities.json": Buffer.from("old-registry\n"),
    ".omp/extensions/bridge.ts": Buffer.from("export const revision = 1;\n"),
  });
  writeFileSync(join(seeded, "state", "activation-receipt.json"), JSON.stringify(oldLinkedReceipt));
  writeFileSync(seededPanes, JSON.stringify({ result: { panes: [
    { pane_id: "w1:p4", cwd: seeded, agent: "omp", agent_status: "idle", agent_session_id: "session-seeded" },
  ] } }));
  const seededCurrentReceipt = linkedReceipt(seeded, source, newRevision, "w1:p4", "session-seeded", { activation: "ok" });
  writeFileSync(seededReload, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${seededReloadLog}'\ncat > '${join(seeded, "state", "activation-receipt.json")}' <<'JSON'\n${JSON.stringify(seededCurrentReceipt)}\nJSON\n`);
  chmodSync(seededReload, 0o755);
  const gitGuardDir = join(temp, "git-guard");
  const gitGuardLog = join(temp, "git-guard.log");
  const realGit = run("which", ["git"]);
  mkdirSync(gitGuardDir, { recursive: true });
  writeFileSync(join(gitGuardDir, "git"), `#!/bin/sh\ncase "$*" in\n  *"${seeded}"*) printf '%s\\n' "$*" >> '${gitGuardLog}'; exit 99;;\nesac\nexec '${realGit}' "$@"\n`);
  chmodSync(join(gitGuardDir, "git"), 0o755);
  const seededEnv = { ...process.env, FM_HOME: seeded, FM_FLEET_UPDATE_STATE: seededTransaction, FM_FLEET_RELOAD_SCRIPT: seededReload, FM_FLEET_PANES_FILE: seededPanes, PATH: `${gitGuardDir}:${process.env.PATH}` };
  for (const key of ["FM_FLEET_SOURCE_HOME", "FM_FLEET_SOURCE_REVISION", "FM_FLEET_CAPABILITY_REGISTRY", "FM_ROOT_OVERRIDE", "FM_ROOT"]) delete seededEnv[key];
  const seededRun = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: seeded, encoding: "utf8", env: seededEnv });
  if (seededRun.status !== 0) throw new Error(`seeded non-Git update failed: ${seededRun.stdout}`);
  const seededPayload = decode(seededRun.stdout, { expandPaths: "safe" });
  const seededResult = seededPayload.result.results.find(row => row.target === "seeded");
  if (!seededResult || seededResult.status !== "ready" || seededResult.action !== "reload") throw new Error(`seeded non-Git target was not receipt-ready: ${seededRun.stdout}`);
  if (seededResult.proof.source_revision !== newRevision || seededResult.proof.required_probe_result.activation !== "ok" || !seededResult.proof.manifest_sha256) throw new Error(`seeded non-Git proof incomplete: ${seededRun.stdout}`);
  if (existsSync(gitGuardLog)) throw new Error(`seeded non-Git target invoked Git: ${readFileSync(gitGuardLog, "utf8")}`);
  if (readFileSync(seededReloadLog, "utf8") !== "w1:p4\n") throw new Error(`seeded non-Git target did not reload its bound session: ${readFileSync(seededReloadLog, "utf8")}`);
  console.log("ok - seeded non-Git home derives source and follows linked extension manifests without target Git");
  mkdirSync(join(wholeSeeded, "state"), { recursive: true });
  symlinkSync(join(source, ".omp"), join(wholeSeeded, ".omp"), "dir");
  writeFileSync(join(wholeSeeded, ".fm-secondmate-home"), "whole\n");
  writeFileSync(join(wholeSeeded, "AGENTS.md"), "v2\n");
  writeFileSync(registry, JSON.stringify({ schema: "firstmate.capability-registry/v1", targets: [
    { id: "whole-seeded", home: wholeSeeded, surfaces: ["AGENTS.md", ".omp/extensions/bridge.ts"], required_probe_result: { activation: "ok" } },
  ] }));
  writeFileSync(wholePanes, JSON.stringify({ result: { panes: [
    { pane_id: "w1:p5", cwd: wholeSeeded, agent: "omp", agent_status: "idle", agent_session_id: "session-whole" },
  ] } }));
  writeFileSync(wholeReload, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${wholeReloadLog}'\n`);
  chmodSync(wholeReload, 0o755);
  const wholeEnv = { ...process.env, FM_HOME: wholeSeeded, FM_FLEET_UPDATE_STATE: wholeTransaction, FM_FLEET_RELOAD_SCRIPT: wholeReload, FM_FLEET_PANES_FILE: wholePanes, PATH: `${gitGuardDir}:${process.env.PATH}` };
  for (const key of ["FM_FLEET_SOURCE_HOME", "FM_FLEET_SOURCE_REVISION", "FM_FLEET_CAPABILITY_REGISTRY", "FM_ROOT_OVERRIDE", "FM_ROOT"]) delete wholeEnv[key];
  const wholeRun = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: wholeSeeded, encoding: "utf8", env: wholeEnv });
  if (wholeRun.status !== 1 || wholeRun.stdout.includes("OPERATIONAL_ERROR")) throw new Error(`whole-.omp symlink update failed: ${wholeRun.stdout}`);
  const wholePayload = decode(wholeRun.stdout, { expandPaths: "safe" });
  const wholeResult = wholePayload.result.results.find(row => row.target === "whole-seeded");
  if (!wholeResult || wholeResult.status !== "pending" || !wholeResult.reason.includes("unbound")) throw new Error(`whole-.omp symlink missing receipt was not pending: ${wholeRun.stdout}`);
  if (wholeResult.proof.source_revision !== newRevision) throw new Error(`whole-.omp symlink did not resolve canonical source: ${wholeRun.stdout}`);
  if (existsSync(wholeReloadLog)) throw new Error("whole-.omp symlink missing receipt triggered a reload");
  console.log("ok - legacy whole-.omp symlink resolves canonical source and missing first receipt remains pending");
  writeFileSync(join(source, ".omp", "extensions", "linked", "entry.ts"), "export const linked = false;\n");
  run("git", ["add", ".omp/extensions/linked/entry.ts"], source);
  run("git", ["commit", "-q", "--no-verify", "-m", "linked divergence source"], source);
  const divergedRevision = git(["rev-parse", "HEAD"], source).trim();
  writeFileSync(registry, JSON.stringify({ schema: "firstmate.capability-registry/v1", targets: [
    { id: "seeded", home: seeded, source_revision: newRevision, surfaces: [".omp/extensions/bridge.ts", ".omp/extensions/linked"], required_probe_result: { activation: "ok" } },
  ] }));
  rmSync(join(seeded, ".omp", "extensions", "linked"), { recursive: true, force: true });
  mkdirSync(join(seeded, ".omp", "extensions", "linked"), { recursive: true });
  writeFileSync(join(seeded, ".omp", "extensions", "linked", "entry.ts"), "export const linked = true;\n");
  const beforeDivergedReloads = readFileSync(seededReloadLog, "utf8");
  const divergedRun = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: seeded, encoding: "utf8", env: seededEnv });
  if (divergedRun.status !== 1) throw new Error(`diverged seeded target did not return pending: ${divergedRun.stdout}`);
  const divergedPayload = decode(divergedRun.stdout, { expandPaths: "safe" });
  const divergedResult = divergedPayload.result.results.find(row => row.target === "seeded");
  if (!divergedResult || divergedResult.status !== "pending" || !divergedResult.reason.includes("diverged")) throw new Error(`diverged registered surface was not pending: ${divergedRun.stdout}`);
  if (divergedResult.proof.source_revision !== divergedRevision) throw new Error(`diverged proof omitted source revision: ${divergedRun.stdout}`);
  if (readFileSync(seededReloadLog, "utf8") !== beforeDivergedReloads) throw new Error("diverged registered surface triggered a reload");
  if (existsSync(gitGuardLog)) throw new Error(`diverged seeded target invoked Git: ${readFileSync(gitGuardLog, "utf8")}`);
  console.log("ok - changed non-Git registered surface divergence remains pending before reload");
  const beforeRetryReloads = readFileSync(seededReloadLog, "utf8");
  const retryRun = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: seeded, encoding: "utf8", env: seededEnv });
  if (retryRun.status !== 1) throw new Error(`same-head divergence retry did not return pending: ${retryRun.stdout}`);
  const retryPayload = decode(retryRun.stdout, { expandPaths: "safe" });
  const retryResult = retryPayload.result.results.find(row => row.target === "seeded");
  if (!retryResult || retryResult.status !== "pending" || !retryResult.reason.includes("diverged")) throw new Error(`same-head divergence retry was not pending: ${retryRun.stdout}`);
  if (readFileSync(seededReloadLog, "utf8") !== beforeRetryReloads) throw new Error("same-head divergence retry triggered a reload");
  console.log("ok - same-head divergence retry verifies surfaces before reload");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
