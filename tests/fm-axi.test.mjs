#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "@toon-format/toon";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "sbin", "fm-axi");
const temp = mkdtempSync(join(tmpdir(), "fm-axi-test-"));
const home = join(temp, "home");

function fail(message) {
  throw new Error(message);
}

function run(args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FM_HOME: home,
      FM_ROOT_OVERRIDE: root,
      FM_FOCUS_NO_HERDR: "1",
      ...extra,
    },
  });
}

function toon(result, context) {
  if (result.status !== 0) fail(`${context} exited ${result.status}: ${result.stderr}`);
  try {
    return decode(result.stdout, { expandPaths: "safe" });
  } catch (error) {
    fail(`${context} did not emit TOON: ${error.message}\n${result.stdout}`);
  }
}

try {
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "state", "review.meta"), "pane=w1:p1\nkind=ship\nworker=reviewer\n");
  writeFileSync(join(home, "state", "review.status"), "needs-decision: choose rollout\n");

  const populated = toon(run(["fleet", "focus"]), "populated focus");
  if (populated.command !== "fleet focus" || populated.result.length !== 1) {
    fail(`populated focus result was not preserved: ${JSON.stringify(populated)}`);
  }
  if (populated.result[0].id !== "review" || populated.result[0].class !== "CAPTAIN-BLOCKED") {
    fail(`populated focus ranking was not preserved: ${JSON.stringify(populated.result[0])}`);
  }
  console.log("ok - populated fleet result is TOON");

  rmSync(join(home, "state", "review.meta"));
  rmSync(join(home, "state", "review.status"));
  const empty = toon(run(["fleet", "focus"]), "empty focus");
  if (empty.command !== "fleet focus" || !Array.isArray(empty.result) || empty.result.length !== 0) {
    fail(`empty fleet result was not preserved: ${JSON.stringify(empty)}`);
  }
  console.log("ok - empty fleet result is TOON");

  const stale = toon(run(["fleet", "updated"]), "non-fresh updated");
  if (stale.command !== "fleet updated" || stale.result.state !== "unknown") {
    fail(`non-fresh fleet state was not returned successfully: ${JSON.stringify(stale)}`);
  }
  console.log("ok - non-fresh fleet result exits successfully as TOON");

  const kpi = toon(run(["fleet", "kpi"]), "kpi");
  if (kpi.command !== "fleet kpi" || kpi.result.schema !== "fm-kpi/1") {
    fail(`kpi dispatcher did not preserve the result: ${JSON.stringify(kpi)}`);
  }
  const lineage = toon(run(["fleet", "lineage"]), "lineage");
  if (lineage.command !== "fleet lineage" || lineage.result.home !== home) {
    fail(`lineage dispatcher did not preserve the result: ${JSON.stringify(lineage)}`);
  }
  console.log("ok - kpi and lineage dispatcher commands are TOON");

  const help = toon(run(["fleet", "--help"]), "help");
  if (help.command !== "fm-axi fleet" || help.commands.length !== 4) {
    fail(`help was not structured TOON: ${JSON.stringify(help)}`);
  }
  console.log("ok - help is TOON");

  const invalid = run(["fleet", "missing"]);
  if (invalid.status !== 2) fail(`validation error exited ${invalid.status}, expected 2`);
  const error = decode(invalid.stdout, { expandPaths: "safe" });
  if (error.code !== "VALIDATION_ERROR" || !error.error || !Array.isArray(error.help)) {
    fail(`validation error was not AXI-shaped TOON: ${invalid.stdout}`);
  }
  console.log("ok - validation error is AXI-shaped TOON");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
