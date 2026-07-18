#!/usr/bin/env bash
# Focused regression tests for restored herdr agent-slot husks.
#
# These exercise herdrClassifySlot and herdrReapHuskSlot in
# .omp/extensions/cli/lib/herdr.ts (the slot classification/reaping helpers).
# They used to source sbin/fm-herdr-lib.sh directly and call its bash
# functions (fm_herdr_classify_slot, fm_herdr_reap_husk_slot) in-process; that
# bash lib is dead now that runtime code lives in herdr.ts, which sbin/fm's
# verbs import.
#
# Each case shells out to a tiny `bun -e` harness that imports the real
# exported functions and calls them in a fresh process, with the fake herdr
# on PATH and the fixture env vars set for that process from the start. This
# is required, not just stylistic: Bun's spawnSync (used internally by
# herdr.ts) resolves its executable and env from the env the *process* had
# at startup, not from in-process process.env mutations made afterward, so a
# single long-lived bun process cannot swap out the fake `herdr` between
# cases by mutating its own process.env.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERDR_TS="$ROOT/.omp/extensions/cli/lib/herdr.ts"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-husk-respawn.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

make_fake_herdr() {
  local fakebin=$1
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -u
[ -n "${FM_HERDR_LOG:-}" ] && printf '%s\n' "$*" >> "$FM_HERDR_LOG"
kind=${FM_HERDR_KIND:-free}
case "${1:-} ${2:-}" in
  "agent get")
    if [ "$kind" = free ]; then
      printf '{"error":{"code":"agent_not_found"}}\n'
      exit 1
    fi
    printf '{"result":{"agent":{"pane_id":"w1:p-old","tab_id":"w1:t-old"}}}\n'
    ;;
  "pane get")
    if [ "$kind" = dead ]; then
      printf '{"error":{"code":"pane_not_found"}}\n'
      exit 1
    fi
    case "$kind" in live) status=working ;; *) status=unknown ;; esac
    printf '{"result":{"pane":{"agent_status":"%s"}}}\n' "$status"
    ;;
  "pane process-info")
    case "$kind" in booting) process='bun /opt/omp/scripts/omp.ts' ;; *) process='-zsh' ;; esac
    printf '{"result":{"process_info":{"foreground_processes":[{"argv0":"%s","name":"%s","cmdline":"%s"}]}}}\n' "$process" "$process" "$process"
    ;;
  "pane current")
    printf '{"result":{"pane":{"pane_id":"w1:p-self","workspace_id":"w1"}}}\n'
    ;;
  "tab create")
    printf '{"result":{"tab":{"tab_id":"w1:t-new"},"root_pane":{"pane_id":"w1:p-root"}}}\n'
    ;;
  "agent start")
    printf '{"result":{"agent":{"pane_id":"w1:p-new"}}}\n'
    ;;
  "tab close"|"pane close"|"pane rename") exit 0 ;;
esac
SH
  chmod +x "$fakebin/herdr"
}

# ts_classify_slot <slot>: print herdrClassifySlot(slot) - free|husk|live|unknown.
ts_classify_slot() {
  bun -e '
import { herdrClassifySlot } from "'"$HERDR_TS"'";
console.log(herdrClassifySlot(process.argv[process.argv.length - 1]));
' -- "$1"
}

# ts_reap_husk_slot <slot>: rc 0 iff herdrReapHuskSlot(slot) resolves true.
ts_reap_husk_slot() {
  bun -e '
import { herdrReapHuskSlot } from "'"$HERDR_TS"'";
const ok = await herdrReapHuskSlot(process.argv[process.argv.length - 1]);
process.exit(ok ? 0 : 1);
' -- "$1"
}

classify() {
  local kind fakebin
  kind=$1
  fakebin="$TMP_ROOT/$kind/bin"
  make_fake_herdr "$fakebin"
  PATH="$fakebin:$PATH" FM_HERDR_KIND="$kind" ts_classify_slot slot
}

reap() {
  local kind fakebin log
  kind=$1
  fakebin="$TMP_ROOT/reap-$kind/bin"
  log="$TMP_ROOT/reap-$kind/log"
  make_fake_herdr "$fakebin"
  PATH="$fakebin:$PATH" FM_HERDR_KIND="$kind" FM_HERDR_LOG="$log" FM_HUSK_REAP_SETTLE=0 \
    ts_reap_husk_slot slot >/dev/null 2>&1
  printf '%s\n' "$log"
}

[ "$(classify free)" = free ] || fail "unregistered slot must be free"
[ "$(classify dead)" = husk ] || fail "dead restored pane must be a husk"
[ "$(classify shell)" = husk ] || fail "agent-less shell must be a husk"
[ "$(classify live)" = live ] || fail "bound agent must remain live"
[ "$(classify booting)" = unknown ] || fail "booting harness must fail closed"
pass "slot classification distinguishes reusable husks from live and booting agents"

log=$(reap shell) || fail "confirmed husk must be reaped"
grep -qF 'tab close w1:t-old' "$log" || fail "husk reap must close the restored tab"
live_bin="$TMP_ROOT/live-reap/bin"
make_fake_herdr "$live_bin"
if PATH="$live_bin:$PATH" FM_HERDR_KIND=live FM_HUSK_REAP_SETTLE=0 \
  ts_reap_husk_slot slot >/dev/null 2>&1; then
  fail "live agent slot must not be reaped"
fi
pass "reap closes only confirmed husks"

spawn_home="$TMP_ROOT/spawn-home"
mkdir -p "$spawn_home/config" "$spawn_home/data/label-check-k3" "$spawn_home/projects/demo"
printf 'omp\n' > "$spawn_home/config/crew-harness"
(
  cd "$spawn_home/projects/demo" || exit 1
  git init -q
  git config user.email tests@example.com
  git config user.name tests
  printf 'seed\n' > seed.txt
  git add seed.txt
  git commit -qm seed
)
printf 'brief\n' > "$spawn_home/data/label-check-k3/brief.md"
spawn_bin="$TMP_ROOT/spawn-bin"
make_fake_herdr "$spawn_bin"
cat > "$spawn_bin/omp" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$spawn_bin/omp"
spawn_log="$TMP_ROOT/spawn.log"
spawn_out=$(PATH="$spawn_bin:$PATH" FM_HERDR_KIND=free FM_HERDR_LOG="$spawn_log" \
  FM_HOME="$spawn_home" FM_ROOT_OVERRIDE="$ROOT" FM_SPAWN_NO_GUARD=1 \
  "$ROOT/sbin/fm" spawn label-check-k3 projects/demo omp 2>&1) \
  || fail "spawn should create a labeled replacement tab: $spawn_out"
case "$spawn_out" in *'spawned label-check-k3'*) : ;; *) fail "spawn did not report success: $spawn_out" ;; esac
grep -qF 'agent start label-check-k3' "$spawn_log" || fail "task id was not used as the herdr slot"
grep -qF 'pane rename w1:p-new label-check' "$spawn_log" || fail "worker label was not applied as display-only pane metadata"
grep -qF 'agent_slot=label-check-k3' "$spawn_home/state/label-check-k3.meta" || fail "spawn metadata omitted agent slot"
grep -qF 'worker=label-check' "$spawn_home/state/label-check-k3.meta" || fail "spawn metadata omitted worker label"
grep -qF 'agent_identity=omp' "$spawn_home/state/label-check-k3.meta" || fail "spawn metadata omitted harness identity"
grep -qE -- '^- \[ \] label-check-k3 - ship task .*\(repo: demo\).*\(since [0-9]{4}-[0-9]{2}-[0-9]{2}\)$' "$spawn_home/data/backlog.md" \
  || fail "ship spawn did not record its in-flight backlog entry"
if [ "$(grep -c 'label-check-k3' "$spawn_home/data/backlog.md")" -ne 1 ]; then
  fail "ship spawn recorded its backlog entry more than once"
fi

mkdir -p "$spawn_home/data/scout-check-k4"
printf 'brief\n' > "$spawn_home/data/scout-check-k4/brief.md"
scout_out=$(PATH="$spawn_bin:$PATH" FM_HERDR_KIND=free FM_HERDR_LOG="$spawn_log" \
  FM_HOME="$spawn_home" FM_ROOT_OVERRIDE="$ROOT" FM_SPAWN_NO_GUARD=1 \
  "$ROOT/sbin/fm" spawn scout-check-k4 projects/demo omp --scout 2>&1) \
  || fail "scout spawn should create a labeled replacement tab: $scout_out"
grep -qE -- '^- \[ \] scout-check-k4 - scout task .*\(repo: demo\).*\(since [0-9]{4}-[0-9]{2}-[0-9]{2}\)$' "$spawn_home/data/backlog.md" \
  || fail "scout spawn did not record its in-flight backlog entry"
pass "spawn separates display labels from the durable herdr slot"

mkdir -p "$spawn_home/data/batch-a-k5" "$spawn_home/data/batch-b-k6"
printf 'brief\n' > "$spawn_home/data/batch-a-k5/brief.md"
printf 'brief\n' > "$spawn_home/data/batch-b-k6/brief.md"
batch_log="$TMP_ROOT/batch.log"
batch_out=$(PATH="$spawn_bin:$PATH" FM_HERDR_KIND=free FM_HERDR_LOG="$batch_log" \
  FM_HOME="$spawn_home" FM_ROOT_OVERRIDE="$ROOT" FM_SPAWN_NO_GUARD=1 \
  "$ROOT/sbin/fm" spawn batch-a-k5=projects/demo batch-b-k6=projects/demo 2>&1) \
  || fail "batch dispatch through fm spawn should succeed: $batch_out"
case "$batch_out" in *'spawned batch-a-k5'*'spawned batch-b-k6'*) : ;; *) fail "batch dispatch did not spawn both tasks: $batch_out" ;; esac
grep -qF 'agent start batch-a-k5' "$batch_log" || fail "batch dispatch omitted first task"
grep -qF 'agent start batch-b-k6' "$batch_log" || fail "batch dispatch omitted second task"
grep -qE -- '^- \[ \] batch-a-k5 - ship task .*\(repo: demo\).*\(since [0-9]{4}-[0-9]{2}-[0-9]{2}\)$' "$spawn_home/data/backlog.md" \
  || fail "batch dispatch did not record first backlog entry"
grep -qE -- '^- \[ \] batch-b-k6 - ship task .*\(repo: demo\).*\(since [0-9]{4}-[0-9]{2}-[0-9]{2}\)$' "$spawn_home/data/backlog.md" \
  || fail "batch dispatch did not record second backlog entry"
pass "spawn batch dispatch re-enters the fm spawn entrypoint for each pair"

secondmate_home="$TMP_ROOT/secondmate-home"
mkdir -p "$secondmate_home/data" "$secondmate_home/state" "$secondmate_home/config" "$secondmate_home/projects" "$secondmate_home/sbin"
printf 'anchor\n' > "$secondmate_home/.fm-secondmate-home"
: > "$secondmate_home/AGENTS.md"
secondmate_home_real=$(cd "$secondmate_home" && pwd -P)
printf 'charter prompt that must not be resent\n' > "$secondmate_home/data/charter.md"
mkdir -p "$spawn_home/state"
printf 'kind=secondmate\nhome=%s\n' "$secondmate_home" > "$spawn_home/state/anchor.meta"
printf '%s\n' '- anchor - anchor domain (home: '"$secondmate_home"'; workspace: w-anchor; name: Plum; scope: anchor domain; projects: (none); added 2026-07-11)' > "$spawn_home/data/secondmates.md"
resume_bin="$TMP_ROOT/resume-bin"
make_fake_herdr "$resume_bin"
resume_log="$TMP_ROOT/resume.log"
resume_out=$(PATH="$resume_bin:$PATH" FM_HERDR_KIND=free FM_HERDR_LOG="$resume_log" \
  FM_HOME="$spawn_home" FM_ROOT_OVERRIDE="$ROOT" FM_SPAWN_NO_GUARD=1 \
  "$ROOT/sbin/fm" spawn anchor omp --secondmate 2>&1) \
  || fail "secondmate OMP recovery spawn should succeed: $resume_out"
grep -qF 'omp --append-system-prompt=' "$resume_log" || fail "OMP respawn did not inject the runtime role contract"
grep -qF -- '--auto-approve -c' "$resume_log" || fail "OMP respawn did not continue the saved session"
if grep -qF 'charter prompt that must not be resent' "$resume_log"; then
  fail "OMP respawn resent the charter instead of continuing"
fi
grep -qF "home=$secondmate_home_real" "$spawn_home/state/anchor.meta" || fail "recovery metadata did not preserve the durable home"
grep -qF 'tab create --workspace w-anchor --label Plum' "$resume_log" || fail "secondmate tab did not use the registered display name"
grep -qF 'pane rename w1:p-new Plum' "$resume_log" || fail "secondmate pane did not use the registered display name"
grep -qF 'worker=Plum' "$spawn_home/state/anchor.meta" || fail "secondmate metadata did not record the registered display name"
[ "$(grep -c 'label-check-k3' "$spawn_home/data/backlog.md")" -eq 1 ] \
  || fail "secondmate spawn should not add an in-flight backlog entry"
pass "secondmate respawn uses the registered display name"

fallback_home="$TMP_ROOT/fallback-secondmate-home"
mkdir -p "$fallback_home/data" "$fallback_home/state" "$fallback_home/config" "$fallback_home/projects" "$fallback_home/sbin"
printf 'fallback\n' > "$fallback_home/.fm-secondmate-home"
: > "$fallback_home/AGENTS.md"
printf 'charter prompt for fallback\n' > "$fallback_home/data/charter.md"
printf '%s\n' '- fallback - fallback domain (home: '"$fallback_home"'; name: ; scope: fallback domain; projects: (none); added 2026-07-11)' >> "$spawn_home/data/secondmates.md"
printf 'kind=secondmate\nhome=%s\n' "$fallback_home" > "$spawn_home/state/fallback.meta"
fallback_log="$TMP_ROOT/fallback.log"
fallback_bin="$TMP_ROOT/fallback-bin"
make_fake_herdr "$fallback_bin"
fallback_out=$(PATH="$fallback_bin:$PATH" FM_HERDR_KIND=free FM_HERDR_LOG="$fallback_log" \
  FM_HOME="$spawn_home" FM_ROOT_OVERRIDE="$ROOT" FM_SPAWN_NO_GUARD=1 \
  "$ROOT/sbin/fm" spawn fallback omp --secondmate 2>&1) \
  || fail "malformed name registry fallback should still spawn: $fallback_out"
grep -qF 'pane rename w1:p-new home' "$fallback_log" || fail "malformed name registry entry changed the fallback display label"
grep -qF 'worker=home' "$spawn_home/state/fallback.meta" || fail "malformed name registry entry changed fallback metadata"
pass "secondmate malformed or name-less registry entries retain home fallback"
