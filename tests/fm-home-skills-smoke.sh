#!/usr/bin/env bash
# Fresh-process smoke: prove loaded skill names and source paths for a disposable
# specialist home. Does not use the current process's cached skill registry.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FM="$ROOT/sbin/fm"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-home-skills-smoke.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

code="$TMP/code"
home="$TMP/home"
mkdir -p "$code/.agents/skills" "$home/config" "$home/state" "$home/data" "$home/projects" "$home/.omp/skills" "$home/.omp/extensions/local-pack/skills/local-ext"
printf '# code\n' > "$code/AGENTS.md"
for name in core-a core-b; do
  mkdir -p "$code/.agents/skills/$name"
  printf -- '---\nname: %s\ndescription: smoke %s\n---\n# %s\n' "$name" "$name" "$name" > "$code/.agents/skills/$name/SKILL.md"
done
mkdir -p "$home/.omp/skills/local-x"
printf -- '---\nname: local-x\ndescription: local smoke\n---\n# local-x\n' > "$home/.omp/skills/local-x/SKILL.md"
printf -- '---\nname: local-ext\ndescription: ext smoke\n---\n# local-ext\n' > "$home/.omp/extensions/local-pack/skills/local-ext/SKILL.md"
printf 'fixture\n' > "$home/.fm-secondmate-home"
printf '%s\n' 'core-a' > "$home/config/shared-skills"
printf '%s\n' 'local-ext' > "$home/config/local-skills"

out=$(FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1) \
  || fail "sync failed: $out"
case "$out" in *effective=core-a,local-ext,local-x*) : ;; *) fail "bad effective set: $out" ;; esac

# Fresh bun process reads the reconciler plan / omp.yml and resolves source paths.
report=$(
  HOME_PATH="$home" CODE_PATH="$code" bun --eval '
    import { lstatSync, readlinkSync, realpathSync } from "node:fs";
    import { join } from "node:path";
    const home = process.env.HOME_PATH;
    const code = process.env.CODE_PATH;
    const y = Bun.YAML.parse(await Bun.file(join(home, "config/omp.yml")).text());
    const names = y.skills.includeSkills;
    if (y.skills.enabled !== true) throw new Error("enabled");
    if (JSON.stringify(names) !== JSON.stringify(["core-a","local-ext","local-x"])) {
      throw new Error("names=" + JSON.stringify(names));
    }
    const coreLink = join(home, ".omp/skills/core-a");
    if (!lstatSync(coreLink).isSymbolicLink()) throw new Error("core-a not symlink");
    const coreTarget = realpathSync(coreLink);
    const expectCore = realpathSync(join(code, ".agents/skills/core-a"));
    if (coreTarget !== expectCore) throw new Error("core target " + coreTarget);
    const localX = realpathSync(join(home, ".omp/skills/local-x/SKILL.md"));
    const localExt = realpathSync(join(home, ".omp/extensions/local-pack/skills/local-ext/SKILL.md"));
    console.log("LOADED=" + names.join(","));
    console.log("core-a=" + coreTarget);
    console.log("local-x=" + localX);
    console.log("local-ext=" + localExt);
  '
) || fail "fresh-process verification failed"

echo "$report"
case "$report" in
  *LOADED=core-a,local-ext,local-x*) : ;;
  *) fail "fresh process loaded wrong names" ;;
esac
pass "fresh-process smoke loaded exact names with resolved source paths"
echo "# home-skills fresh-process smoke passed"
