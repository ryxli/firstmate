#!/usr/bin/env bash
# Focused regression tests for restored herdr agent-slot husks.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/sbin/fm-herdr-lib.sh"
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

classify() {
  local kind fakebin
  kind=$1
  fakebin="$TMP_ROOT/$kind/bin"
  make_fake_herdr "$fakebin"
  PATH="$fakebin:$PATH" FM_HERDR_KIND="$kind" bash -c '. "$1"; fm_herdr_classify_slot slot' _ "$LIB"
}

reap() {
  local kind fakebin log
  kind=$1
  fakebin="$TMP_ROOT/reap-$kind/bin"
  log="$TMP_ROOT/reap-$kind/log"
  make_fake_herdr "$fakebin"
  PATH="$fakebin:$PATH" FM_HERDR_KIND="$kind" FM_HERDR_LOG="$log" FM_HUSK_REAP_SETTLE=0 \
    bash -c '. "$1"; fm_herdr_reap_husk_slot slot >/dev/null 2>&1' _ "$LIB"
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
  bash -c '. "$1"; fm_herdr_reap_husk_slot slot >/dev/null 2>&1' _ "$LIB"; then
  fail "live agent slot must not be reaped"
fi
pass "reap closes only confirmed husks"

spawn_home="$TMP_ROOT/spawn-home"
mkdir -p "$spawn_home/data/label-check-k3" "$spawn_home/projects/demo"
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
  "$ROOT/sbin/fm-spawn.sh" label-check-k3 projects/demo omp 2>&1) \
  || fail "spawn should create a labeled replacement tab: $spawn_out"
case "$spawn_out" in *'spawned label-check-k3'*) : ;; *) fail "spawn did not report success: $spawn_out" ;; esac
grep -qF 'agent start label-check-k3' "$spawn_log" || fail "task id was not used as the herdr slot"
grep -qF 'pane rename w1:p-new label-check' "$spawn_log" || fail "worker label was not applied as display-only pane metadata"
grep -qF 'agent_slot=label-check-k3' "$spawn_home/state/label-check-k3.meta" || fail "spawn metadata omitted agent slot"
grep -qF 'worker=label-check' "$spawn_home/state/label-check-k3.meta" || fail "spawn metadata omitted worker label"
grep -qF 'agent_identity=omp' "$spawn_home/state/label-check-k3.meta" || fail "spawn metadata omitted harness identity"
pass "spawn separates display labels from the durable herdr slot"

secondmate_home="$TMP_ROOT/secondmate-home"
mkdir -p "$secondmate_home/data" "$secondmate_home/state" "$secondmate_home/config" "$secondmate_home/projects" "$secondmate_home/sbin"
printf 'anchor\n' > "$secondmate_home/.fm-secondmate-home"
: > "$secondmate_home/AGENTS.md"
secondmate_home_real=$(cd "$secondmate_home" && pwd -P)
printf 'charter prompt that must not be resent\n' > "$secondmate_home/data/charter.md"
mkdir -p "$spawn_home/state"
printf 'kind=secondmate\nhome=%s\n' "$secondmate_home" > "$spawn_home/state/anchor.meta"
resume_bin="$TMP_ROOT/resume-bin"
make_fake_herdr "$resume_bin"
resume_log="$TMP_ROOT/resume.log"
resume_out=$(PATH="$resume_bin:$PATH" FM_HERDR_KIND=free FM_HERDR_LOG="$resume_log" \
  FM_HOME="$spawn_home" FM_ROOT_OVERRIDE="$ROOT" FM_SPAWN_NO_GUARD=1 \
  "$ROOT/sbin/fm-spawn.sh" anchor omp --secondmate 2>&1) \
  || fail "secondmate OMP recovery spawn should succeed: $resume_out"
grep -qF 'omp --auto-approve -c' "$resume_log" || fail "OMP respawn did not continue the saved session"
if grep -qF 'charter prompt that must not be resent' "$resume_log"; then
  fail "OMP respawn resent the charter instead of continuing"
fi
grep -qF "home=$secondmate_home_real" "$spawn_home/state/anchor.meta" || fail "recovery metadata did not preserve the durable home"
pass "secondmate OMP respawn continues the prior session without reinjecting the charter"
