#!/usr/bin/env bash
# Focused contracts for fm home-skills isolation.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FM="$ROOT/sbin/fm"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-home-skills.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

canonical() { cd "$1" && pwd -P; }

write_skill() {
  local dir=$1 name=$2
  mkdir -p "$dir"
  printf -- '---\nname: %s\ndescription: fixture skill %s\n---\n# %s\n' "$name" "$name" "$name" > "$dir/SKILL.md"
}

make_code() {
  local code=$1
  mkdir -p "$code/.agents/skills" "$code/.omp/extensions"
  write_skill "$code/.agents/skills/core-a" core-a
  write_skill "$code/.agents/skills/core-b" core-b
  write_skill "$code/.agents/skills/fm-only" fm-only
  printf 'ext\n' > "$code/.omp/extensions/ship-ext.ts"
  printf '# code\n' > "$code/AGENTS.md"
  ln -s "$ROOT/sbin" "$code/sbin"
}

make_home() {
  local code=$1 home=$2 id=${3:-fixture}
  code=$(canonical "$code")
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects" "$home/.omp/skills" "$home/.omp/extensions"
  printf '%s\n' "$id" > "$home/.fm-secondmate-home"
  ln -s "$code/AGENTS.md" "$home/AGENTS.md"
  ln -s "$code/sbin" "$home/sbin"
  ln -s "$code/.omp/extensions/ship-ext.ts" "$home/.omp/extensions/ship-ext.ts"
}

fingerprint() {
  # Stable content fingerprint of mutable skill surfaces (excludes receipt timestamps).
  local home=$1
  {
    printf 'SHARED\n'; [ -f "$home/config/shared-skills" ] && cat "$home/config/shared-skills"
    printf 'LOCAL\n'; [ -f "$home/config/local-skills" ] && cat "$home/config/local-skills"
    printf 'OMP\n'; [ -f "$home/config/omp.yml" ] && cat "$home/config/omp.yml"
    printf 'SKILLS\n'
    if [ -d "$home/.omp/skills" ]; then
      find "$home/.omp/skills" -maxdepth 1 \( -type l -o -type d \) ! -name skills | sort | while read -r p; do
        name=$(basename "$p")
        if [ -L "$p" ]; then
          printf 'L %s -> %s\n' "$name" "$(readlink "$p")"
        else
          printf 'D %s\n' "$name"
        fi
      done
    fi
    printf 'AGENTS\n'
    if [ -L "$home/.agents" ]; then printf 'L -> %s\n' "$(readlink "$home/.agents")"
    elif [ -e "$home/.agents" ]; then printf 'E\n'
    else printf '%s\n' '-' ; fi
    printf 'RECEIPT_LINKS\n'
    if [ -f "$home/state/home-skills.receipt.json" ]; then
      bun -e 'const j=JSON.parse(await Bun.file(process.argv[1]).text()); console.log(JSON.stringify(j.links,Object.keys(j.links).sort()))' \
        "$home/state/home-skills.receipt.json"
    fi
  } | shasum -a 256 | awk '{print $1}'
}

# --- 1/2/9/10: effective set, exclusions, idempotency, unrelated overlay fields ---
test_effective_union_and_exclusions() {
  local code="$TMP/eff-code" home="$TMP/eff-home" out before after
  make_code "$code"
  code=$(canonical "$code")
  make_home "$code" "$home"
  write_skill "$home/.omp/skills/local-x" local-x
  mkdir -p "$home/.omp/extensions/local-pack/skills/local-ext"
  write_skill "$home/.omp/extensions/local-pack/skills/local-ext" local-ext
  # Distractors that must not enter the effective set
  mkdir -p "$TMP/user-skills/core-b" "$home/.claude/skills/claude-only" "$TMP/managed/auto-learn"
  write_skill "$TMP/user-skills/core-b" core-b
  write_skill "$home/.claude/skills/claude-only" claude-only
  write_skill "$TMP/managed/auto-learn" auto-learn
  mkdir -p "$home/.omp/extensions/noise-pack/skills/noise-skill"
  write_skill "$home/.omp/extensions/noise-pack/skills/noise-skill" noise-skill

  printf '%s\n' 'core-a' > "$home/config/shared-skills"
  printf '%s\n' 'local-ext' > "$home/config/local-skills"
  printf '%s\n' 'keep: true' 'model: fixture-model' > "$home/config/omp.yml"

  out=$(FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1) \
    || fail "sync failed: $out"
  assert_contains() { case "$1" in *"$2"*) : ;; *) fail "$3"$'\n'"$1" ;; esac; }
  assert_contains "$out" "effective=core-a,local-ext,local-x" "effective set wrong"
  assert_contains "$out" "result=ok" "sync not ok"
  [ -L "$home/.omp/skills/core-a" ] || fail "missing managed core-a"
  [ ! -e "$home/.omp/skills/core-b" ] || fail "core-b leaked"
  [ ! -e "$home/.omp/skills/fm-only" ] || fail "fm-only leaked"
  [ -d "$home/.omp/skills/local-x" ] && [ ! -L "$home/.omp/skills/local-x" ] || fail "local-x not preserved as real dir"
  grep -q 'keep: true' "$home/config/omp.yml" || fail "unrelated omp field lost"
  grep -q 'model: fixture-model' "$home/config/omp.yml" || fail "model field lost"
  grep -q 'enabled: true' "$home/config/omp.yml" || fail "skills.enabled missing"
  bun -e '
    const y = Bun.YAML.parse(await Bun.file(process.argv[1]).text());
    const inc = y.skills.includeSkills;
    if (JSON.stringify(inc) !== JSON.stringify(["core-a","local-ext","local-x"])) {
      throw new Error("includeSkills=" + JSON.stringify(inc));
    }
  ' "$home/config/omp.yml" || fail "includeSkills not exact sorted effective set"

  before=$(fingerprint "$home")
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null \
    || fail "idempotent sync failed"
  FM_CODE_ROOT_OVERRIDE="$code" FM_ROOT_OVERRIDE="$code" "$FM" home-skills check "$home" >/dev/null \
    || fail "idempotent check failed"
  after=$(fingerprint "$home")
  [ "$before" = "$after" ] || fail "idempotent sync mutated fingerprint"
  pass "effective union, exclusions, overlay preserve, idempotency"
}

# --- 3/4: native wins; extension-only requires local-skills ---
test_extension_cannot_replace_native_and_requires_local_skills() {
  local code="$TMP/ext-code" home="$TMP/ext-home" out
  make_code "$code"; code=$(canonical "$code")
  make_home "$code" "$home"
  write_skill "$home/.omp/skills/shared-name" shared-name
  mkdir -p "$home/.omp/extensions/competitor/skills/shared-name"
  printf -- '---\nname: shared-name\ndescription: competitor\n---\nCOMPETITOR\n' \
    > "$home/.omp/extensions/competitor/skills/shared-name/SKILL.md"
  : > "$home/config/shared-skills"
  : > "$home/config/local-skills"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "sync with native shared-name failed"
  grep -q 'shared-name' "$home/config/omp.yml" || fail "native skill not included"
  # Name only from extension, not listed in local-skills
  rm -rf "$home/.omp/skills/shared-name"
  printf '%s\n' 'shared-name' > "$home/config/local-skills"
  # Wait - if listed in local-skills and resolves under extensions, it should succeed.
  # First prove unlisted extension-only name is rejected when forced into include via... 
  # Actually effective set only gets extension names from local-skills. So unlisted
  # never enters. Contract 4: included name supplied only by extension rejected unless
  # in local-skills. Our builder won't include it unless listed. Test listed+resolves ok,
  # and listed but resolving outside home extensions fails.
  : > "$home/config/local-skills"
  mkdir -p "$home/.omp/extensions/only-ext/skills/ext-only"
  write_skill "$home/.omp/extensions/only-ext/skills/ext-only" ext-only
  # Not listed -> not in effective (sync ok with empty)
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "sync without ext-only failed"
  grep -q 'ext-only' "$home/config/omp.yml" && fail "unlisted extension skill included"
  printf '%s\n' 'ext-only' > "$home/config/local-skills"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "listed local-ext sync failed"
  grep -q 'ext-only' "$home/config/omp.yml" || fail "listed local-ext not included"
  # Ship-linked (symlink) extension skill must not satisfy local-skills
  mkdir -p "$code/.omp/extensions/ship-pack/skills/ship-skill"
  write_skill "$code/.omp/extensions/ship-pack/skills/ship-skill" ship-skill
  ln -sfn "$code/.omp/extensions/ship-pack" "$home/.omp/extensions/ship-pack"
  printf '%s\n' 'ship-skill' > "$home/config/local-skills"
  if out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1); then
    fail "accepted ship-linked extension skill as local-skills"
  fi
  case "$out" in *local-ext-missing*|*blocked*) : ;; *) fail "wrong error for ship-linked local-skills: $out" ;; esac
  pass "native wins; local-skills requires real home-local extension"
}

# --- 5: empty effective set disables skills ---
test_empty_effective_disables_skills() {
  local code="$TMP/empty-code" home="$TMP/empty-home"
  make_code "$code"; code=$(canonical "$code")
  make_home "$code" "$home"
  : > "$home/config/shared-skills"
  : > "$home/config/local-skills"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "empty sync failed"
  bun -e '
    const y = Bun.YAML.parse(await Bun.file(process.argv[1]).text());
    if (y.skills.enabled !== false) throw new Error("enabled");
    if (!Array.isArray(y.skills.includeSkills) || y.skills.includeSkills.length !== 0) throw new Error("includes");
  ' "$home/config/omp.yml" || fail "empty set did not disable skills"
  pass "empty effective set sets skills.enabled false"
}

# --- 6: remove shared name removes only owned link ---
test_remove_shared_removes_owned_link() {
  local code="$TMP/rm-code" home="$TMP/rm-home"
  make_code "$code"; code=$(canonical "$code")
  make_home "$code" "$home"
  write_skill "$home/.omp/skills/local-x" local-x
  printf '%s\n' 'core-a' 'core-b' > "$home/config/shared-skills"
  : > "$home/config/local-skills"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "initial sync failed"
  [ -L "$home/.omp/skills/core-a" ] && [ -L "$home/.omp/skills/core-b" ] || fail "expected both links"
  printf '%s\n' 'core-a' > "$home/config/shared-skills"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "removal sync failed"
  [ -L "$home/.omp/skills/core-a" ] || fail "core-a removed incorrectly"
  [ ! -e "$home/.omp/skills/core-b" ] || fail "core-b link not removed"
  [ -d "$home/.omp/skills/local-x" ] || fail "local-x was disturbed"
  pass "removing shared name removes only owned managed link"
}

# --- 7: fail-closed zero mutation cases ---
test_fail_closed_zero_mutation() {
  local code="$TMP/fail-code" home="$TMP/fail-home" before after out
  make_code "$code"; code=$(canonical "$code")
  make_home "$code" "$home"
  printf '%s\n' 'core-a' > "$home/config/shared-skills"
  : > "$home/config/local-skills"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "baseline sync failed"

  # invalid glob name — fingerprint after intentional manifest edit
  printf '%s\n' 'core-*' > "$home/config/shared-skills"
  before=$(fingerprint "$home")
  if out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1); then fail "accepted glob name"; fi
  after=$(fingerprint "$home"); [ "$before" = "$after" ] || fail "glob name mutated state"
  printf '%s\n' 'core-a' > "$home/config/shared-skills"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "rebaseline after glob failed"

  # duplicate across sources (local real dir claiming shared name)
  rm -f "$home/.omp/skills/core-a"
  write_skill "$home/.omp/skills/core-a" core-a
  before=$(fingerprint "$home")
  if out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1); then fail "accepted duplicate"; fi
  after=$(fingerprint "$home"); [ "$before" = "$after" ] || fail "duplicate mutated state"
  rm -rf "$home/.omp/skills/core-a"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "rebaseline after duplicate failed"

  # missing source
  printf '%s\n' 'missing-skill' > "$home/config/shared-skills"
  before=$(fingerprint "$home")
  if out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1); then fail "accepted missing source"; fi
  after=$(fingerprint "$home"); [ "$before" = "$after" ] || fail "missing source mutated"
  printf '%s\n' 'core-a' > "$home/config/shared-skills"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "rebaseline after missing failed"

  # frontmatter mismatch
  mkdir -p "$code/.agents/skills/bad-name"
  printf -- '---\nname: other-name\ndescription: x\n---\n' > "$code/.agents/skills/bad-name/SKILL.md"
  printf '%s\n' 'bad-name' > "$home/config/shared-skills"
  before=$(fingerprint "$home")
  if out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1); then fail "accepted name mismatch"; fi
  after=$(fingerprint "$home"); [ "$before" = "$after" ] || fail "mismatch mutated"
  printf '%s\n' 'core-a' > "$home/config/shared-skills"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "rebaseline after mismatch failed"

  # foreign link
  ln -sfn /tmp/foreign-skill "$home/.omp/skills/foreign"
  before=$(fingerprint "$home")
  if out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1); then fail "accepted foreign link"; fi
  after=$(fingerprint "$home"); [ "$before" = "$after" ] || fail "foreign link mutated state"
  rm -f "$home/.omp/skills/foreign"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "rebaseline after foreign failed"

  # retargeted recorded link (points away from both receipt and desired)
  ln -sfn "$code/.agents/skills/core-b" "$home/.omp/skills/core-a"
  before=$(fingerprint "$home")
  if out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1); then fail "accepted retargeted link"; fi
  after=$(fingerprint "$home"); [ "$before" = "$after" ] || fail "retarget mutated state"
  ln -sfn "$code/.agents/skills/core-a" "$home/.omp/skills/core-a"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "restore after retarget test failed"

  # correct link + missing receipt must converge (partial sync recovery)
  rm -f "$home/state/home-skills.receipt.json"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null \
    || fail "correct link with missing receipt did not self-recover"
  [ -f "$home/state/home-skills.receipt.json" ] || fail "recovery did not rewrite receipt"
  [ -L "$home/.omp/skills/core-a" ] || fail "recovery disturbed correct managed link"

  # malformed yaml
  printf 'skills: [\n' > "$home/config/omp.yml"
  before=$(fingerprint "$home")
  if out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1); then fail "accepted malformed yaml"; fi
  after=$(fingerprint "$home"); [ "$before" = "$after" ] || fail "malformed yaml mutated state"
  rm -f "$home/config/omp.yml"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "restore omp failed"

  # missing shared-skills on seeded home is migration-required
  rm -f "$home/config/shared-skills"
  before=$(fingerprint "$home")
  if out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills check "$home" 2>&1); then
    fail "check accepted seeded home without shared-skills"
  fi
  case "$out" in *migration-required*|*blocked*) : ;; *) fail "expected migration-required: $out" ;; esac
  after=$(fingerprint "$home"); [ "$before" = "$after" ] || fail "migration-required check mutated state"
  printf '%s\n' 'core-a' > "$home/config/shared-skills"
  : > "$home/config/local-skills"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "restore after migration-required failed"

  # drift: check fails without mutation when manifest ahead of reconciled state
  printf '%s\n' 'core-a' 'core-b' > "$home/config/shared-skills"
  before=$(fingerprint "$home")
  if out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills check "$home" 2>&1); then
    fail "check accepted drift"
  fi
  case "$out" in *result=drift*|*blocked*) : ;; *) fail "expected drift: $out" ;; esac
  after=$(fingerprint "$home"); [ "$before" = "$after" ] || fail "drift check mutated state"
  printf '%s\n' 'core-a' > "$home/config/shared-skills"

  # symlinked config container
  rm -rf "$home/config"
  ln -s "$TMP/config-elsewhere" "$home/config"
  mkdir -p "$TMP/config-elsewhere"
  if out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1); then fail "accepted symlinked config"; fi
  rm -f "$home/config"
  mkdir -p "$home/config"
  printf '%s\n' 'core-a' > "$home/config/shared-skills"
  : > "$home/config/local-skills"
  pass "fail-closed cases refuse mutation; recovery converges after partial sync"
}

# --- 8: legacy .agents handling ---
test_legacy_agents_handling() {
  local code="$TMP/agents-code" home="$TMP/agents-home" out
  make_code "$code"; code=$(canonical "$code")
  make_home "$code" "$home"
  : > "$home/config/shared-skills"
  : > "$home/config/local-skills"

  ln -sfn "$code/.agents" "$home/.agents"
  FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" >/dev/null || fail "canonical .agents sync failed"
  [ ! -e "$home/.agents" ] || fail "canonical .agents not removed"

  mkdir -p "$home/.agents/skills/keep"
  write_skill "$home/.agents/skills/keep" keep
  out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1) || fail "real .agents sync failed: $out"
  case "$out" in *legacy.agents=preserve-real*) : ;; *) fail "did not report preserve-real: $out" ;; esac
  [ -d "$home/.agents/skills/keep" ] || fail "real .agents removed"

  rm -rf "$home/.agents"
  mkdir -p "$TMP/other-agents/skills"
  ln -sfn "$TMP/other-agents" "$home/.agents"
  out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1) || fail "foreign .agents sync failed: $out"
  case "$out" in *legacy.agents=preserve-foreign*) : ;; *) fail "did not report preserve-foreign: $out" ;; esac
  [ -L "$home/.agents" ] || fail "foreign .agents removed"

  rm -f "$home/.agents"
  ln -sfn "$TMP/missing-agents-target" "$home/.agents"
  out=$(FM_CODE_ROOT_OVERRIDE="$code" "$FM" home-skills sync "$home" 2>&1) || fail "broken .agents sync failed: $out"
  case "$out" in *legacy.agents=preserve-broken*) : ;; *) fail "did not report preserve-broken: $out" ;; esac
  [ -L "$home/.agents" ] || fail "broken .agents removed"
  pass "legacy .agents removal/preserve rules"
}

# --- 11: seed rollback removes skill artifacts after later failure ---
test_seed_rollback_removes_skill_artifacts() {
  local main="$TMP/seed-main" subhome="$TMP/seed-sub" err remote
  mkdir -p "$main/data" "$main/state" "$main/config" "$main/projects" "$TMP/remotes"
  mkdir -p "$main/projects/alpha"
  git -C "$main/projects/alpha" init -q
  printf '# alpha\n' > "$main/projects/alpha/README.md"
  git -C "$main/projects/alpha" add README.md
  git -C "$main/projects/alpha" -c user.name='Firstmate Tests' -c user.email='tests@example.invalid' commit -qm initial
  remote="$TMP/remotes/seed-alpha.git"
  git clone --quiet --bare "$main/projects/alpha" "$remote"
  git -C "$main/projects/alpha" remote add origin "file://$(cd "$remote" && pwd -P)"
  printf '%s\n' '- alpha [pr] - alpha project (added 2026-07-20)' > "$main/data/projects.md"
  printf '# Firstmate\n' > "$main/AGENTS.md"
  mkdir -p "$main/sbin"

  # Skills sync runs before the charter gate; omit charter to fail after skills.
  # Newly created homes are removed entirely on rollback (skill artifacts included).
  if err=$(FM_HOME="$main" FM_ROOT_OVERRIDE="$ROOT" FM_CODE_ROOT_OVERRIDE="$ROOT" \
    "$FM" home-seed rollskill "$subhome" alpha 2>&1); then
    fail "seed unexpectedly succeeded without charter"
  fi
  case "$err" in *"no filled secondmate charter brief"*) : ;; *) fail "unexpected seed error: $err" ;; esac
  [ ! -e "$subhome" ] || fail "failed seed left subhome (and skill artifacts) behind"
  pass "seed rollback removes generated skill artifacts"
}

test_effective_union_and_exclusions
test_extension_cannot_replace_native_and_requires_local_skills
test_empty_effective_disables_skills
test_remove_shared_removes_owned_link
test_fail_closed_zero_mutation
test_legacy_agents_handling
test_seed_rollback_removes_skill_artifacts

echo "# fm-home-skills focused contracts passed"
