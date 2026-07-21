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
if [ -n "${FM_HERDR_RELEASE_FILE:-}" ] && [ -f "$FM_HERDR_RELEASE_FILE" ]; then
  kind=free
fi
case "${1:-} ${2:-}" in
  "agent get")
    if [ "$kind" = generic-failure ]; then
      printf '{"error":{"code":"transport_error","message":"herdr unavailable"}}\n'
      exit 1
    fi
    if [ "$kind" = embedded-error ]; then
      printf '{"error":{"code":"agent_not_found","details":{"error":{"code":"permission_denied"}}}}\n'
      exit 1
    fi
    if [ "$kind" = unstructured-agent-not-found ]; then
      printf 'agent not found\n'
      exit 1
    fi
    if [ "$kind" = message-only-agent-not-found ]; then
      printf '{"error":{"message":"agent not found"}}\n'
      exit 1
    fi
    if [ "$kind" = generic-not-found ]; then
      printf '{"error":"not found"}\n'
      exit 1
    fi
    if [ "$kind" = malformed-success ]; then
      printf '{"result":{"agent":'
      exit 0
    fi
    if [ "$kind" = missing-pane ]; then
      printf '{"result":{"agent":{"tab_id":"w1:t-old","workspace_id":"w1"}}}\n'
      exit 0
    fi
    if [ "$kind" = free ]; then
      printf '{"error":{"code":"agent_not_found"}}\n'
      exit 1
    fi
    printf '{"result":{"agent":{"pane_id":"w1:p-old","tab_id":"w1:t-old","workspace_id":"w1"}}}\n'
    ;;
  "pane list")
    printf '{"result":{"panes":[]}}\n'
    ;;
  "pane get")
    if [ "$kind" = dead ]; then
      printf '{"error":{"code":"pane_not_found"}}\n'
      exit 1
    fi
    case "$kind" in live) status=working ;; stale-idle-shell) status=idle ;; *) status=unknown ;; esac
    if [ "$kind" = malformed-pane-success ]; then
      printf '{"result":{"pane":{"agent_status":"%s"}}}\n' "$status"
    else
      printf '{"result":{"pane":{"pane_id":"w1:p-old","agent_status":"%s"}}}\n' "$status"
    fi
    ;;
  "pane process-info")
    case "$kind" in booting|live) process='bun /opt/omp/scripts/omp.ts' ;; *) process='-zsh' ;; esac
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
  "tab close")
    if [ "$kind" = last-tab ]; then
      printf '{"error":{"code":"tab_close_failed","message":"cannot close the last tab in a workspace"}}\n'
      exit 1
    fi
    [ -n "${FM_HERDR_RELEASE_FILE:-}" ] && : > "$FM_HERDR_RELEASE_FILE"
    exit 0 ;;
  "pane close"|"workspace close")
    [ -n "${FM_HERDR_RELEASE_FILE:-}" ] && : > "$FM_HERDR_RELEASE_FILE"
    exit 0 ;;
  "pane rename") exit 0 ;;
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
  local kind fakebin log rc
  kind=$1
  fakebin="$TMP_ROOT/reap-$kind/bin"
  log="$TMP_ROOT/reap-$kind/log"
  make_fake_herdr "$fakebin"
  PATH="$fakebin:$PATH" FM_HERDR_KIND="$kind" FM_HERDR_LOG="$log" \
    FM_HERDR_RELEASE_FILE="$TMP_ROOT/reap-$kind/released" FM_HUSK_REAP_SETTLE=0 \
    ts_reap_husk_slot slot >/dev/null 2>&1
  rc=$?
  printf '%s\n' "$log"
  return "$rc"
}

[ "$(classify free)" = free ] || fail "unregistered slot must be free"
[ "$(classify dead)" = husk ] || fail "dead restored pane must be a husk"
[ "$(classify shell)" = husk ] || fail "agent-less shell must be a husk"
[ "$(classify stale-idle-shell)" = husk ] || fail "stale idle status must not conceal an agent-less shell"
[ "$(classify generic-failure)" = unknown ] || fail "generic agent get failure must remain unknown"
[ "$(classify malformed-success)" = unknown ] || fail "malformed successful agent get must remain unknown"
[ "$(classify embedded-error)" = unknown ] || fail "embedded non-not-found agent error must remain unknown"
[ "$(classify missing-pane)" = unknown ] || fail "agent get without pane_id must remain unknown"
[ "$(classify malformed-pane-success)" = unknown ] || fail "pane get without pane_id must remain unknown"
[ "$(classify live)" = live ] || fail "bound agent must remain live"
[ "$(classify booting)" = unknown ] || fail "booting harness must fail closed"
pass "slot classification distinguishes reusable husks from live and booting agents"

[ "$(classify unstructured-agent-not-found)" = unknown ] || fail "unstructured agent not found must remain unknown"
[ "$(classify message-only-agent-not-found)" = unknown ] || fail "message-only agent not found must remain unknown"
[ "$(classify generic-not-found)" = unknown ] || fail "generic not found must remain unknown"
log=$(reap shell) || fail "confirmed husk must be reaped"
grep -qF 'tab close w1:t-old' "$log" || fail "husk reap must close the restored tab"
[ "$(grep -cF 'agent get slot' "$log")" -ge 3 ] \
  || fail "husk reap must verify the slot became free after close"
last_tab_log=$(reap last-tab) || fail "last-tab husk workspace must be reaped"
grep -qF 'tab close w1:t-old' "$last_tab_log" || fail "last-tab reap must try the restored tab first"
grep -qF 'workspace close w1' "$last_tab_log" || fail "last-tab reap must close the obsolete workspace"
live_bin="$TMP_ROOT/live-reap/bin"
make_fake_herdr "$live_bin"
if PATH="$live_bin:$PATH" FM_HERDR_KIND=live FM_HUSK_REAP_SETTLE=0 \
  ts_reap_husk_slot slot >/dev/null 2>&1; then
  fail "live agent slot must not be reaped"
fi
for uncertain in generic-failure malformed-success embedded-error missing-pane malformed-pane-success unstructured-agent-not-found message-only-agent-not-found generic-not-found; do
  uncertain_log=$(reap "$uncertain") \
    && fail "$uncertain slot observation must not be reaped"
  if grep -Eq '^(tab|pane|workspace) close |^agent start ' "$uncertain_log"; then
    fail "$uncertain slot observation triggered close/start: $(cat "$uncertain_log")"
  fi
done
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
  "$ROOT/sbin/fm" spawn label-check-k3 projects/demo omp --visible 2>&1) \
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
  "$ROOT/sbin/fm" spawn scout-check-k4 projects/demo omp --scout --visible 2>&1) \
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
  "$ROOT/sbin/fm" spawn batch-a-k5=projects/demo batch-b-k6=projects/demo --visible 2>&1) \
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
printf 'charter prompt refreshed on resume\n' > "$secondmate_home/data/charter.md"
mkdir -p "$secondmate_home/.omp/skills" "$secondmate_home/config"
: > "$secondmate_home/config/shared-skills"
: > "$secondmate_home/config/local-skills"
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
grep -qF "FM_HOME='$secondmate_home_real' '$secondmate_home_real'/sbin/fm start" "$resume_log" \
  || fail "secondmate respawn did not use the canonical home-local fm start"
for forbidden in 'omp --auto-approve' '--auto-approve -c' '--config' '--append-system-prompt'; do
  if grep -qF -- "$forbidden" "$resume_log"; then
    fail "secondmate respawn retained direct OMP launch fragment: $forbidden"
  fi
done
grep -qF "home=$secondmate_home_real" "$spawn_home/state/anchor.meta" || fail "recovery metadata did not preserve the durable home"
grep -qF 'tab create --workspace w-anchor --label Plum' "$resume_log" || fail "secondmate tab did not use the registered display name"
grep -qF 'pane rename w1:p-new Plum' "$resume_log" || fail "secondmate pane did not use the registered display name"
grep -qF 'worker=Plum' "$spawn_home/state/anchor.meta" || fail "secondmate metadata did not record the registered display name"
[ "$(grep -c 'label-check-k3' "$spawn_home/data/backlog.md")" -eq 1 ] \
  || fail "secondmate spawn should not add an in-flight backlog entry"
pass "secondmate respawn uses the registered display name"

fallback_home="$TMP_ROOT/fallback-secondmate-home"
mkdir -p "$fallback_home/data" "$fallback_home/state" "$fallback_home/config" "$fallback_home/projects" "$fallback_home/sbin" "$fallback_home/.omp/skills"
printf 'fallback\n' > "$fallback_home/.fm-secondmate-home"
: > "$fallback_home/AGENTS.md"
: > "$fallback_home/config/shared-skills"
: > "$fallback_home/config/local-skills"
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
grep -qF 'pane rename w1:p-new fallback' "$fallback_log" || fail "malformed name registry entry did not fall back to the mate id label"
grep -qF 'worker=fallback' "$spawn_home/state/fallback.meta" || fail "malformed name registry entry did not record the mate id as worker"
pass "secondmate malformed or name-less registry entries fall back to the mate id"
