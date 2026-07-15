#!/usr/bin/env bun
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "@toon-format/toon";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "sbin", "fm-axi");
const temp = mkdtempSync(join(tmpdir(), "fm-axi-home-test-"));
const codeRoot = join(temp, "code-root");
const firstmate = join(temp, "firstmate");
const plum = join(temp, "plum");
const sage = join(temp, "sage");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FM_HOME: firstmate,
      FM_CODE_ROOT_OVERRIDE: codeRoot,
      FM_ROOT_OVERRIDE: root,
    },
  });
}

function toon(result, context, status = 0) {
  if (result.status !== status) throw new Error(`${context} exited ${result.status}, expected ${status}: ${result.stderr}\n${result.stdout}`);
  try {
    return decode(result.stdout, { expandPaths: "safe" });
  } catch (error) {
    throw new Error(`${context} did not emit TOON: ${error.message}\n${result.stdout}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertRecord(record, expected) {
  for (const [field, value] of Object.entries(expected)) {
    assert(record[field] === value, `${expected.command} ${expected.target} had ${field}=${JSON.stringify(record[field])}, expected ${JSON.stringify(value)}`);
  }
  assert(Array.isArray(record.diagnostics), `${expected.command} ${expected.target} omitted diagnostics`);
  assert(record.diagnostics.every(line => typeof line === "string"), `${expected.command} ${expected.target} diagnostics were not raw lines`);
  assert(record.diagnostics.some(line => line === `home=${realpathSync(expected.home)}`), `${expected.command} ${expected.target} omitted helper home diagnostic: ${JSON.stringify(record)}`);
  assert(record.diagnostics.some(line => line.startsWith("mode=")), `${expected.command} ${expected.target} omitted helper mode diagnostic`);
}

function setupHome(home) {
  for (const directory of ["data", "state", "config", "projects"]) mkdirSync(join(home, directory), { recursive: true });
  writeFileSync(join(home, ".fm-secondmate-home"), "fixture secondmate\n");
  for (const name of ["AGENTS.md", "sbin", ".agents", ".tasks.toml", ".claude", ".omp"]) {
    symlinkSync(join(codeRoot, name), join(home, name));
  }
}

try {
  for (const directory of ["sbin", ".agents", ".claude", ".omp", ".omp/extensions"]) mkdirSync(join(codeRoot, directory), { recursive: true });
  writeFileSync(join(codeRoot, "AGENTS.md"), "fixture code root\n");
  writeFileSync(join(codeRoot, ".tasks.toml"), "[tasks]\n");
  mkdirSync(join(firstmate, "sbin"), { recursive: true });
  writeFileSync(join(firstmate, "sbin", "fm-spawn.sh"), "");
  mkdirSync(join(firstmate, "data"), { recursive: true });
  writeFileSync(join(firstmate, "data", "secondmates.md"), `- plum - persistent mate (home: ${plum}; scope: tests)\n`);
  mkdirSync(join(plum, "data"), { recursive: true });
  writeFileSync(join(plum, "data", "secondmates.md"), `- sage - nested persistent mate (home: ${sage}; scope: tests)\n`);
  setupHome(plum);
  setupHome(sage);

  const rootHelp = toon(run(["--help"]), "root help");
  assert(rootHelp.command === "fm-axi", `root help command was ${JSON.stringify(rootHelp.command)}`);
  assert(rootHelp.commands.some(command => command.command === "home"), "root help omitted home command");
  assert(String(rootHelp.usage).includes("home <check|repair> <mate|--all>"), "root help omitted exact home grammar");
  console.log("ok - root help is TOON and documents home grammar");

  const homeHelp = toon(run(["home", "--help"]), "home help");
  assert(homeHelp.command === "fm-axi home", `home help command was ${JSON.stringify(homeHelp.command)}`);
  assert(String(homeHelp.usage).includes("fm-axi home <check|repair> <mate|--all>"), "home help omitted exact grammar");
  console.log("ok - home subcommand help is TOON");

  const named = toon(run(["home", "check", "plum"]), "named healthy check");
  assert(named.command === "home check" && named.result.length === 1, `named check returned the wrong envelope: ${JSON.stringify(named)}`);
  assertRecord(named.result[0], { command: "home check", target: "plum", home: plum, action: "check", result: "ok" });
  assert(named.result[0].diagnostics.some(line => line === "result=ok"), "healthy check omitted helper result diagnostic");
  console.log("ok - named healthy target carries complete raw helper receipt");

  const allHealthy = toon(run(["home", "check", "--all"]), "recursive check");
  assert(allHealthy.command === "home check", `recursive check command was ${JSON.stringify(allHealthy.command)}`);
  assert(allHealthy.result.length === 2, `recursive check did not include both nested homes: ${JSON.stringify(allHealthy)}`);
  assert(new Set(allHealthy.result.map(record => record.target)).size === 2, "recursive check returned duplicate targets");
  for (const record of allHealthy.result) {
    const expectedHome = record.target === "plum" ? plum : record.target === "sage" ? sage : null;
    assert(expectedHome, `recursive check returned unregistered target ${record.target}`);
    assertRecord(record, { command: "home check", target: record.target, home: expectedHome, action: "check", result: "ok" });
  }

  const badTarget = toon(run(["home", "check", "missing-mate"]), "unknown target", 2);
  assert(badTarget.code === "NOT_FOUND", `unknown target did not use NOT_FOUND validation convention: ${JSON.stringify(badTarget)}`);
  assert(typeof badTarget.error === "string" && Array.isArray(badTarget.help), "unknown target omitted structured validation fields");
  console.log("ok - unknown target is a structured validation error");

  const malformed = toon(run(["home"]), "missing home arguments", 2);
  assert(malformed.code === "VALIDATION_ERROR" && Array.isArray(malformed.help), `missing arguments were not structured validation: ${JSON.stringify(malformed)}`);
  const malformedExtra = toon(run(["home", "check", "plum", "extra"]), "extra home argument", 2);
  assert(malformedExtra.code === "VALIDATION_ERROR" && Array.isArray(malformedExtra.help), `extra argument was not structured validation: ${JSON.stringify(malformedExtra)}`);
  console.log("ok - malformed home arguments reuse structured validation errors");

  rmSync(join(sage, "AGENTS.md"), { force: true });
  const unsafeTarget = join(temp, "not-code-root", "AGENTS.md");
  symlinkSync(unsafeTarget, join(sage, "AGENTS.md"));
  const unhealthy = toon(run(["home", "check", "sage"]), "non-repair unhealthy check", 1);
  assert(unhealthy.command === "home check" && unhealthy.result.length === 1, `unhealthy check returned the wrong envelope: ${JSON.stringify(unhealthy)}`);
  const unhealthyRecord = unhealthy.result[0];
  assertRecord(unhealthyRecord, { command: "home check", target: "sage", home: sage, action: "check", result: "blocked" });
  assert(unhealthyRecord.diagnostics.some(line => line === "link.AGENTS.md=blocked:wrong-link"), "unhealthy check omitted wrong-link diagnostic");
  assert(readlinkSync(join(sage, "AGENTS.md")) === unsafeTarget, "check repaired the deliberately broken safe link");
  console.log("ok - unhealthy check reports wrong-link without repairing it");

  const repaired = toon(run(["home", "repair", "sage"]), "named repair");
  assert(repaired.command === "home repair" && repaired.result.length === 1, `named repair returned the wrong envelope: ${JSON.stringify(repaired)}`);
  assertRecord(repaired.result[0], { command: "home repair", target: "sage", home: sage, action: "repair", result: "ok" });
  assert(repaired.result[0].diagnostics.some(line => line === "link.AGENTS.md=repaired"), "repair omitted repaired-link diagnostic");
  assert(readlinkSync(join(sage, "AGENTS.md")) === realpathSync(join(codeRoot, "AGENTS.md")), "repair did not restore expected safe link");
  console.log("ok - named repair restores the safe helper-managed link");

  const idempotent = toon(run(["home", "repair", "--all"]), "idempotent recursive repair");
  assert(idempotent.command === "home repair" && idempotent.result.length === 2, `recursive repair returned the wrong envelope: ${JSON.stringify(idempotent)}`);
  for (const record of idempotent.result) {
    const expectedHome = record.target === "plum" ? plum : record.target === "sage" ? sage : null;
    assert(expectedHome, `recursive repair returned unregistered target ${record.target}`);
    assertRecord(record, { command: "home repair", target: record.target, home: expectedHome, action: "repair", result: "ok" });
  }
  assert(idempotent.result.some(record => record.target === "sage" && record.diagnostics.some(line => line === "link.AGENTS.md=ok")), "idempotent repair did not preserve healthy nested link state");
  assert(readlinkSync(join(sage, "AGENTS.md")) === realpathSync(join(codeRoot, "AGENTS.md")), "idempotent repair changed an already healthy link");
  console.log("ok - --all repair is idempotent across nested homes");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
