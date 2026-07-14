#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decode } from "@toon-format/toon";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const cli = join(root, "sbin", "fm-axi");
const temp = mkdtempSync(join(tmpdir(), "fm-axi-update-test-"));
const origin = join(temp, "origin.git");
const seed = join(temp, "seed");
const source = join(temp, "source");
const target = join(temp, "target");
const other = join(temp, "other");
const operational = join(temp, "operational");
const panes = join(temp, "panes.json");
const registry = join(operational, "data", "fleet-capabilities.json");
const transaction = join(operational, "state", "fleet-update.json");
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
  const digest = createHash("sha256");
  for (const entry of manifest.sort((a, b) => a.path.localeCompare(b.path))) digest.update(`${entry.path}\0${entry.sha256}\0`);
  return { schema: "firstmate.activation-receipt/v1", source_revision: revision, manifest_sha256: digest.digest("hex"), pane_id: pane, session_id: session, started_at: "2026-07-14T00:00:00Z", required_probe_result: probe, manifest };
}

try {
  mkdirSync(join(operational, "data"), { recursive: true });
  mkdirSync(join(operational, "state"), { recursive: true });
  run("git", ["init", "--bare", origin]);
  run("git", ["init", seed]);
  git(["config", "user.email", "fmtest@example.com"], seed);
  git(["config", "user.name", "fmtest"], seed);
  mkdirSync(join(seed, ".omp", "extensions"), { recursive: true });
  writeFileSync(join(seed, "AGENTS.md"), "v1\n");
  writeFileSync(join(seed, ".omp", "extensions", "bridge.ts"), "export const revision = 1;\n");
  git(["add", "-A"], seed);
  git(["commit", "-qm", "v1"], seed);
  git(["branch", "-M", "main"], seed);
  git(["remote", "add", "origin", origin], seed);
  git(["push", "-q", "origin", "main"], seed);
  run("git", ["clone", "-q", origin, source]);
  run("git", ["clone", "-q", origin, target]);
  run("git", ["clone", "-q", origin, other]);
  mkdirSync(join(target, ".git", "info"), { recursive: true });
  writeFileSync(join(target, ".git", "info", "exclude"), "state/\n");
  for (const repo of [source, target, other]) {
    git(["config", "user.email", "fmtest@example.com"], repo);
    git(["config", "user.name", "fmtest"], repo);
  }
  const oldRevision = git(["rev-parse", "HEAD"], source);
  writeFileSync(join(seed, "AGENTS.md"), "v2\n");
  writeFileSync(join(seed, ".omp", "extensions", "bridge.ts"), "export const revision = 2;\n");
  git(["add", "-A"], seed);
  git(["commit", "-qm", "v2"], seed);
  git(["push", "-q", "origin", "main"], seed);
  git(["pull", "-q", "--ff-only", "origin", "main"], source);
  const newRevision = git(["rev-parse", "HEAD"], source);

  mkdirSync(join(target, "state"), { recursive: true });
  writeFileSync(join(target, "state", "activation-receipt.json"), JSON.stringify(receipt(target, oldRevision, "w1:p1", "session-target", { ok: true })));
  writeFileSync(panes, JSON.stringify({ result: { panes: [
    { pane_id: "w1:p1", cwd: target, agent: "omp", agent_status: "idle", agent_session_id: "session-target" },
    { pane_id: "w1:p2", cwd: other, agent: "omp", agent_status: "working", agent_session_id: "session-other" },
  ] } }));
  writeFileSync(reload, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${reloadLog}'\ncat > '${join(target, "state", "activation-receipt.json")}' <<'JSON'\n${JSON.stringify(receipt(source, newRevision, "w1:p1", "session-target", { ok: true }))}\nJSON\n`);
  chmodSync(reload, 0o755);
  writeFileSync(registry, JSON.stringify({ schema: "firstmate.capability-registry/v1", targets: [{ id: "target", home: target, source_revision: oldRevision, required_probe_result: { ok: true }, reload_target: "fm-target" }] }));

  const env = { FM_HOME: operational, FM_FLEET_SOURCE_HOME: source, FM_FLEET_CAPABILITY_REGISTRY: registry, FM_FLEET_UPDATE_STATE: transaction, FM_FLEET_RELOAD_SCRIPT: reload, FM_FLEET_PANES_FILE: panes };
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
  if (first.status !== 0) throw new Error(`successful update exited ${first.status}: ${first.stdout}\n${first.stderr}\nreceipt=${readFileSync(join(target, "state", "activation-receipt.json"), "utf8")}`);
  const firstPayload = decode(first.stdout, { expandPaths: "safe" });
  const firstResult = firstPayload.result.results[0];
  if (firstResult.status !== "ready" || firstResult.action !== "reload") throw new Error(`successful receipt path was not ready/reload: ${first.stdout}`);
  if (firstResult.proof.source_revision !== newRevision || !firstResult.proof.manifest_sha256 || firstResult.proof.session_identity.session_id !== "session-target" || firstResult.proof.required_probe_result.ok !== true) throw new Error(`receipt proof incomplete: ${first.stdout}`);
  if (git(["rev-parse", "HEAD"], other) !== oldRevision) throw new Error("unregistered home was updated");
  console.log("ok - registry selects only affected homes and proves the receipt path");

  const beforeReloads = readFileSync(reloadLog, "utf8");
  const second = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (second.status !== 0) throw new Error(`no-op rerun exited ${second.status}: ${second.stdout}`);
  const secondPayload = decode(second.stdout, { expandPaths: "safe" });
  if (secondPayload.result.results[0].status !== "ready" || secondPayload.result.results[0].action !== "noop") throw new Error(`rerun was not a ready no-op: ${second.stdout}`);
  if (readFileSync(reloadLog, "utf8") !== beforeReloads) throw new Error("no-op rerun restarted the session");
  console.log("ok - durable transaction makes a second run a no-op");
  const incompleteReceipt = JSON.parse(readFileSync(join(target, "state", "activation-receipt.json"), "utf8"));
  delete incompleteReceipt.required_probe_result;
  writeFileSync(join(target, "state", "activation-receipt.json"), JSON.stringify(incompleteReceipt));
  const incomplete = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (incomplete.status !== 1) throw new Error(`incomplete receipt exited ${incomplete.status}: ${incomplete.stdout}`);
  const incompletePayload = decode(incomplete.stdout, { expandPaths: "safe" });
  if (incompletePayload.result.results[0].status !== "pending" || !incompletePayload.result.results[0].reason.includes("incomplete")) throw new Error(`incomplete receipt was not pending: ${incomplete.stdout}`);
  if (readFileSync(reloadLog, "utf8") !== beforeReloads) throw new Error("incomplete receipt restarted the session");
  console.log("ok - incomplete receipt is pending without a reload");

  const unavailable = join(temp, "unavailable");
  writeFileSync(registry, JSON.stringify({ schema: "firstmate.capability-registry/v1", targets: [
    { id: "target", home: target, source_revision: oldRevision, required_probe_result: { ok: true }, reload_target: "fm-target" },
    { id: "unavailable", home: unavailable, source_revision: oldRevision, required_probe_result: { ok: true }, reload_target: "fm-unavailable" },
  ] }));
  const third = spawnSync(process.execPath, [cli, "fleet", "update"], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  if (third.status !== 1) throw new Error(`pending unavailable target exited ${third.status}: ${third.stdout}`);
  const thirdPayload = decode(third.stdout, { expandPaths: "safe" });
  const pending = thirdPayload.result.results.find(row => row.target === "unavailable");
  if (!pending || pending.status !== "pending" || !pending.reason.includes("unavailable")) throw new Error(`unavailable target was not pending: ${third.stdout}`);
  console.log("ok - unavailable target is pending without a destructive action");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
