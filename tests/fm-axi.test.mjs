#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { decode } from "@toon-format/toon";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "sbin", "fm-axi");
const temp = mkdtempSync(join(tmpdir(), "fm-axi-test-"));
const home = join(temp, "home");
const secondmate = join(temp, "plum");
const panes = join(temp, "panes.json");
const stats = join(temp, "stats.json");
const fakebin = join(temp, "bin");
const ompLog = join(temp, "omp.log");

function run(args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FM_HOME: home,
      FM_FLEET_PANES_FILE: panes,
      PATH: `${fakebin}:${process.env.PATH}`,
      FM_FLEET_STATS_FILE: stats,
      FM_ROOT_OVERRIDE: root,
      ...extra,
    },
  });
}

function toon(result, context) {
  if (result.status !== 0) throw new Error(`${context} exited ${result.status}: ${result.stderr}`);
  try {
    return decode(result.stdout, { expandPaths: "safe" });
  } catch (error) {
    throw new Error(`${context} did not emit TOON: ${error.message}\n${result.stdout}`);
  }
}

function manifestHash(content) {
  const digest = createHash("sha256").update(content).digest("hex");
  return createHash("sha256").update(`AGENTS.md\0${digest}\0`).digest("hex");
}

try {
  for (const path of [join(home, "data"), join(home, "state"), join(home, "config"), join(home, "sbin"), join(secondmate, "data"), join(secondmate, "state"), join(secondmate, "config")]) mkdirSync(path, { recursive: true });
  mkdirSync(fakebin, { recursive: true });
  writeFileSync(join(fakebin, "omp"), `#!/bin/sh\nprintf 'omp called\\n' >> '${ompLog}'\nexit 99\n`);
  chmodSync(join(fakebin, "omp"), 0o755);
  writeFileSync(join(home, "sbin", "fm-spawn.sh"), "");
  writeFileSync(join(home, "data", "backlog.md"), [
    "## In flight",
    "- **self** - active work (repo: app)",
    "## Queued",
    "- [ ] **queued** - waiting (repo: app)",
    "## Done",
    "- [x] **done** - landed (repo: app)",
  ].join("\n"));
  writeFileSync(join(secondmate, "data", "backlog.md"), "## In flight\n- **self** - plum work (repo: app)\n");
  writeFileSync(join(home, "data", "secondmates.md"), `- plum - persistent mate (home: ${secondmate}; scope: tests)\n`);
  const homeManifest = "axi home manifest\n";
  const secondmateManifest = "axi secondmate manifest\n";
  writeFileSync(join(home, "AGENTS.md"), homeManifest);
  writeFileSync(join(secondmate, "AGENTS.md"), secondmateManifest);
  writeFileSync(join(home, "state", "activation-receipt.json"), JSON.stringify({
    schema: "firstmate.activation-receipt/v1",
    manifest_sha256: manifestHash(homeManifest),
    pane_id: "w1:p1",
    session_id: "home-session",
  }));
  writeFileSync(join(secondmate, "state", "activation-receipt.json"), JSON.stringify({
    schema: "firstmate.activation-receipt/v1",
    manifest_sha256: manifestHash(secondmateManifest),
    pane_id: "w1:p2",
    session_id: "plum-session",
  }));
  writeFileSync(join(home, "state", "self.meta"), "pane=w1:p1\nkind=ship\nworker=self\n");
  writeFileSync(join(home, "state", "self.status"), "working: active\n");
  writeFileSync(join(home, "state", "plum.meta"), `kind=secondmate\nhome=${secondmate}\npane=w1:p2\n`);
  writeFileSync(join(secondmate, "state", "self.meta"), "kind=ship\nworker=self\n");
  writeFileSync(panes, JSON.stringify({ result: { panes: [
    { pane_id: "w1:p1", cwd: home, agent_status: "working", workspace_id: "w1", tab_id: "t1", agent_session_id: "home-session", agent: "omp" },
    { pane_id: "w1:p2", cwd: join(secondmate, "project"), agent_status: "idle", workspace_id: "w1", tab_id: "t2", agent_session_id: "plum-session", agent: "omp" },
  ] } }));
  writeFileSync(stats, JSON.stringify({ byFolder: [] }));

  const overview = toon(run(["fleet"]), "fleet overview");
  if (overview.command !== "fleet" || overview.result.schema !== "fleet-snapshot/1") throw new Error(`overview was not the canonical snapshot: ${JSON.stringify(overview)}`);
  if (!overview.result.tasks.some(task => task.key === "home/self")) throw new Error("overview omitted canonical task key");
  console.log("ok - fleet itself returns compact TOON overview");
  if (existsSync(ompLog)) throw new Error("default overview called OMP statistics");
  const healthyGate = run(["fleet", "--check"]);
  if (healthyGate.status !== 0) throw new Error(`healthy activation gate exited ${healthyGate.status}, expected 0: ${healthyGate.stderr}\n${healthyGate.stdout}`);
  const healthy = decode(healthyGate.stdout, { expandPaths: "safe" });
  if (healthy.result.activation.state !== "fresh" || healthy.result.identity.state !== "bound" || healthy.result.topology.state !== "complete" || healthy.result.health.state !== "healthy") throw new Error(`healthy gate state was not visible: ${healthyGate.stdout}`);
  console.log("ok - healthy activation gate exits zero with bound OMP panes");
  rmSync(join(home, "state", "activation-receipt.json"));
  rmSync(join(secondmate, "state", "activation-receipt.json"));
  const gate = run(["fleet", "--check"]);
  if (gate.status !== 1) throw new Error(`degraded activation gate exited ${gate.status}, expected 1`);
  const gated = decode(gate.stdout, { expandPaths: "safe" });
  if (gated.result.activation.state !== "unknown" || gated.result.health.state !== "degraded") throw new Error(`degraded activation state was not visible: ${gate.stdout}`);
  console.log("ok - activation gate preserves nonzero degraded result while emitting TOON");

  const tasks = toon(run(["fleet", "tasks", "--state", "in-flight"]), "in-flight tasks");
  if (tasks.command !== "fleet tasks" || tasks.result.length !== 2 || !tasks.result.every(task => task.key)) throw new Error(`ranked task list was wrong: ${JSON.stringify(tasks)}`);
  console.log("ok - task list is ranked and owner-qualified");

  const targeted = toon(run(["fleet", "task", "get", "home/self"]), "targeted task");
  if (targeted.result.key !== "home/self" || targeted.result.topology.home !== home) throw new Error(`targeted task lost topology: ${JSON.stringify(targeted)}`);
  const agent = toon(run(["fleet", "agent", "get", "home/self"]), "targeted agent");
  if (agent.result.key !== "home/self" || agent.result.topology.home !== home) throw new Error(`targeted agent lost topology: ${JSON.stringify(agent)}`);
  console.log("ok - targeted task and agent records include topology");

  const ambiguous = run(["fleet", "task", "get", "self"]);
  if (ambiguous.status !== 2) throw new Error(`ambiguous task unexpectedly exited ${ambiguous.status}`);
  const ambiguity = decode(ambiguous.stdout, { expandPaths: "safe" });
  if (ambiguity.code !== "AMBIGUOUS_IDENTIFIER" || ambiguity.candidates.join(",") !== "home/self,plum/self") throw new Error(`ambiguity error was not structured: ${ambiguous.stdout}`);
  console.log("ok - duplicate bare ids require canonical candidates");

  const metrics = toon(run(["fleet", "metrics"]), "metrics");
  if (metrics.command !== "fleet metrics" || metrics.result.tasks_in_flight !== 2 || metrics.result.tasks_queued !== 1 || metrics.result.tasks_landed !== 1) throw new Error(`metrics did not use shared inventory: ${JSON.stringify(metrics)}`);
  console.log("ok - metrics counts derive from shared inventory");

  const help = toon(run(["fleet", "--help"]), "help");
  if (help.command !== "fm-axi fleet" || help.commands.length !== 5) throw new Error(`help contract changed: ${JSON.stringify(help)}`);
  const old = run(["fleet", "focus"]);
  if (old.status !== 2) throw new Error(`removed compatibility command accepted: ${old.status}`);
  console.log("ok - help and compatibility validation are TOON");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
