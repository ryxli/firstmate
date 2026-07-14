#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  const seeded = join(temp, "seeded");
  const fakebin = join(temp, "fakebin");
  mkdirSync(seeded);
  mkdirSync(fakebin);
  for (const path of ["AGENTS.md", "package.json", "bun.lock"]) cpSync(join(root, path), join(seeded, path));
  cpSync(join(root, "sbin"), join(seeded, "sbin"), { recursive: true });
  for (const directory of ["config", "data", "projects", "state"]) mkdirSync(join(seeded, directory));
  const fakeTool = join(fakebin, "tool");
  writeFileSync(fakeTool, "#!/bin/sh\nif [ \"${1:-}\" = status ]; then printf '%s\\n' 'status: running'; fi\nexit 0\n");
  chmodSync(fakeTool, 0o755);
  for (const name of ["herdr", "node", "gh", "gh-axi", "chrome-devtools-axi", "lavish-axi"]) {
    cpSync(fakeTool, join(fakebin, name));
  }
  const fakeBun = join(fakebin, "bun");
  const bunLog = join(temp, "bun.log");
  writeFileSync(fakeBun, `#!/bin/sh\nif [ -n "\${FM_TEST_BUN_LOG:-}" ]; then printf '%s\n' "$PWD" >> "$FM_TEST_BUN_LOG"; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  chmodSync(fakeBun, 0o755);
  const seededEnv = {
    ...process.env,
    HOME: seeded,
    FM_HOME: seeded,
    FM_TEST_BUN_LOG: bunLog,
    PATH: `${fakebin}:${process.env.PATH}`,
  };
  const startup = spawnSync("bash", [join(seeded, "sbin", "fm-bootstrap.sh")], {
    cwd: seeded,
    encoding: "utf8",
    env: seededEnv,
  });
  if (startup.status !== 0) fail(`seeded bootstrap exited ${startup.status}: ${startup.stderr}`);
  if (readFileSync(bunLog, "utf8").trim() !== seeded) {
    fail("normal seeded-home bootstrap did not run the locked Bun install from the home root");
  }
  if (!existsSync(join(seeded, "node_modules", "@toon-format", "toon", "package.json"))) {
    fail("normal seeded-home bootstrap did not install the locked TOON dependency");
  }
  const seededHelp = spawnSync(join(seeded, "sbin", "fm-axi"), ["--help"], {
    cwd: seeded,
    encoding: "utf8",
    env: seededEnv,
  });
  if (seededHelp.status !== 0 || decode(seededHelp.stdout).command !== "fm-axi") {
    fail(`seeded home could not run fm-axi after bootstrap: ${seededHelp.stderr}`);
  }
  console.log("ok - normal seeded-home bootstrap installs the locked TOON dependency");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
