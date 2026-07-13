#!/usr/bin/env bash
# Focused behavior tests for read-only activation-proof freshness checks.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fm-fleet-updated-tests.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

make_fixture_repo() {
  local repo=$1
  mkdir -p "$repo/.omp/extensions"
  printf '# Firstmate\n' > "$repo/AGENTS.md"
  printf 'export default {}\n' > "$repo/.omp/extensions/fm-supervisor.ts"
}
make_fake_herdr() {
  local fakebin=$1
  mkdir -p "$fakebin"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
set -u
case "${1:-} ${2:-}" in
  'pane list')
    printf 'pane list\n' >> "${FM_FAKE_HERDR_LOG:?}"
    cat "${FM_FAKE_HERDR_JSON:?}"
    ;;
  'pane current')
    [ -n "${FM_FAKE_NO_CURRENT:-}" ] && exit 1
    printf '{"result":{"pane":{"pane_id":"w1:p1"}}}\n'
    ;;
  'agent get')
    case "${3:-}" in
      fm-sm) printf '{"result":{"agent":{"pane_id":"w1:p5"}}}\n' ;;
      fm-sm-nonomp) printf '{"result":{"agent":{"pane_id":"w1:p4"}}}\n' ;;
      *) printf '{"result":{"agent":{}}}\n' ;;
    esac
    ;;
  *) printf 'unexpected herdr command: %s\n' "$*" >> "${FM_FAKE_HERDR_LOG:?}"; exit 2 ;;
esac
SH
  chmod +x "$fakebin/herdr"
}
manifest_hash() {
  local repo=$1
  python3 - "$repo" <<'PY'
import hashlib, sys
root = sys.argv[1]
paths = ["AGENTS.md", ".omp/extensions/fm-supervisor.ts"]
paths.sort()
h = hashlib.sha256()
for path in paths:
    data = open(f"{root}/{path}", "rb").read()
    h.update(path.encode()); h.update(b"\0")
    h.update(hashlib.sha256(data).hexdigest().encode()); h.update(b"\0")
print(h.hexdigest())
PY
}
write_receipt() {
  local home=$1 pane=$2 identity_value=$3 repo=$4 stale=${5:-0}
  mkdir -p "$home/state"
  python3 - "$home/state/activation-receipt.json" "$pane" "$identity_value" "$repo" "$stale" <<'PY'
import hashlib, json, sys
path, pane, identity_value, repo, stale = sys.argv[1:]
paths = ["AGENTS.md", ".omp/extensions/fm-supervisor.ts"]
paths.sort()
manifest = []
for rel in paths:
    digest = hashlib.sha256(open(f"{repo}/{rel}", "rb").read()).hexdigest()
    manifest.append({"path": rel, "sha256": digest})
if stale == "1":
    manifest[0]["sha256"] = "0" * 64
manifest_sha256 = hashlib.sha256(b"".join(
    e["path"].encode() + b"\0" + e["sha256"].encode() + b"\0" for e in manifest
)).hexdigest()
identity = {"session_path": identity_value} if identity_value.startswith("/") else {"session_id": identity_value}
json.dump({"schema":"firstmate.activation-receipt/v1", **identity,
           "pane_id":pane, "started_at":"2026-07-13T12:00:00.000Z",
           "manifest_sha256":manifest_sha256, "manifest":manifest}, open(path, "w"))
PY
}
write_panes() {
  local path=$1 home=$2
  python3 - "$path" "$home" <<'PY'
import json, sys
out, home = sys.argv[1:]
json.dump({"result":{"panes":[
  {"pane_id":"w1:p1", "display_agent":"Firstmate", "agent":"omp", "agent_status":"working", "cwd":home, "agent_session_path":home+"/session.jsonl"},
  {"pane_id":"w1:p2", "display_agent":"Stale slot", "agent":"omp", "agent_status":"idle", "cwd":home+"/p2", "agent_session_id":"sid-2"},
  {"pane_id":"w1:p5", "display_agent":"Secondmate", "agent":"omp", "agent_status":"idle", "cwd":home+"/p2/project", "agent_session_id":"sid-2"},
  {"pane_id":"w1:p4", "display_agent":"Not OMP", "agent":"shell", "agent_status":"idle", "cwd":home+"/p4"},
  {"pane_id":"w1:p3", "display_agent":"Missing receipt", "agent":"omp", "agent_status":"idle", "cwd":home+"/p3", "agent_session_id":"sid-3"},
]}}, open(out, "w"))
PY
}
run_check() {
  local repo=$1 fakebin=$2 panes=$3 log=$4
  shift 4
  if [ -n "${FM_TEST_UNSET_HOME:-}" ]; then
    env -u FM_HOME PATH="$fakebin:$PATH" FM_ROOT_OVERRIDE="$repo" \
      FM_FAKE_HERDR_JSON="$panes" FM_FAKE_HERDR_LOG="$log" FM_FAKE_NO_CURRENT="${FM_FAKE_NO_CURRENT:-}" \
      "$ROOT/sbin/fm-fleet-updated.sh" "$@"
  else
    PATH="$fakebin:$PATH" FM_HOME="${FM_TEST_HOME:-$repo}" FM_ROOT_OVERRIDE="$repo" \
      FM_FAKE_HERDR_JSON="$panes" FM_FAKE_HERDR_LOG="$log" FM_FAKE_NO_CURRENT="${FM_FAKE_NO_CURRENT:-}" \
      "$ROOT/sbin/fm-fleet-updated.sh" "$@"
  fi
}

test_fresh_stale_missing_and_mismatched() {
  local repo fakebin home panes log digest out
  repo="$TMP_ROOT/repo"; fakebin="$TMP_ROOT/fakebin"; home="$TMP_ROOT/home"
  panes="$TMP_ROOT/panes.json"; log="$TMP_ROOT/herdr.log"
  make_fixture_repo "$repo"; make_fake_herdr "$fakebin"
  digest="$(manifest_hash "$repo")"
  write_receipt "$home" "w1:p1" "${home}/session.jsonl" "$repo"
  mkdir -p "$home/p2"
  mkdir -p "$home/state"
  printf 'pane=w1:p2\nkind=secondmate\nhome=%s\n' "$home/p2" > "$home/state/sm.meta"
  printf 'pane=w1:p3\nkind=secondmate\nhome=%s\n' "$home/p3" > "$home/state/sm-missing.meta"
  printf 'pane=w1:p4\nkind=secondmate\nagent_slot=fm-sm-nonomp\nhome=%s\n' "$home" > "$home/state/sm-nonomp.meta"
  printf 'kind=secondmate\n' > "$home/state/sm-no-pane.meta"
  write_receipt "$home/p2" "w1:p5" "sid-2" "$repo" 1
  write_panes "$panes" "$home"; : > "$log"
  if out=$(FM_TEST_HOME="$home" run_check "$repo" "$fakebin" "$panes" "$log"); then fail "unknown proof did not fail"; fi
  printf '%s\n' "$out" | grep -F 'w1:p1 Firstmate working session~' | grep -F 'LATEST (activation-proof-matches)' >/dev/null || fail "path identity proof was not fresh"
  printf '%s\n' "$out" | grep -F 'w1:p5 Secondmate idle session~sid-2 -> STALE (manifest-mismatch)' >/dev/null || fail "stale manifest was not explicit"
  printf '%s\n' "$out" | grep -F 'w1:p5 Secondmate idle session~sid-2' >/dev/null || fail "stale secondmate meta was not resolved to live pane"
  printf '%s\n' "$out" | grep -F 'w1:p2 ' >/dev/null && fail "stale secondmate pane was trusted"
  printf '%s\n' "$out" | grep -F 'w1:p4 secondmate idle session~unknown -> unknown (expected-pane-not-omp)' >/dev/null || fail "non-OMP expected pane was omitted"
  printf '%s\n' "$out" | grep -F 'missing:sm-no-pane secondmate-missing-pane unknown session~unknown -> unknown (missing-supervisor-metadata)' >/dev/null || fail "pane-less secondmate metadata was omitted"
  printf '%s\n' "$out" | grep -F 'w1:p3 Missing receipt idle session~sid-3 -> unknown (missing-activation-receipt)' >/dev/null || fail "missing receipt was not explicit"
  FM_FAKE_NO_CURRENT=1 out=$(FM_TEST_HOME="$home" run_check "$repo" "$fakebin" "$panes" "$log") || true
  printf '%s\n' "$out" | grep -F 'observable=false' >/dev/null || fail "missing current pane was treated as observable"
  printf '%s\n' "$out" | grep -F 'state=unknown' >/dev/null || fail "missing current pane was treated as fresh"
  printf '%s\n' "$out" | grep -F 'Plain terminal' >/dev/null && fail "plain terminal was included"
  grep -E 'pane run|tab create|agent rename' "$log" >/dev/null && fail "check was not read-only"
  pass "fresh, stale, missing, and mismatched activation proof is classified explicitly"
  unset FM_FAKE_NO_CURRENT
}

test_json_output_is_parseable() {
  local repo fakebin home panes log digest json
  repo="$TMP_ROOT/json-repo"; fakebin="$TMP_ROOT/json-fakebin"; home="$TMP_ROOT/json-home"
  panes="$TMP_ROOT/json-panes.json"; log="$TMP_ROOT/json-herdr.log"
  make_fixture_repo "$repo"; make_fake_herdr "$fakebin"; digest="$(manifest_hash "$repo")"
  mkdir -p "$home/state"
  printf 'pane=w1:p2\nkind=secondmate\nhome=%s\n' "$home" > "$home/state/sm.meta"
  printf 'pane=w1:p3\nkind=secondmate\nhome=%s\n' "$home" > "$home/state/sm-missing.meta"
  write_receipt "$home" "w1:p1" "${home}/session.jsonl" "$repo"; write_panes "$panes" "$home"; : > "$log"
  json=$(FM_TEST_HOME="$home" run_check "$repo" "$fakebin" "$panes" "$log" --json 2>/dev/null) || true
  printf '%s' "$json" | python3 -c '
import json, sys
r=json.load(sys.stdin)
assert r["summary"] == {"total":3,"latest":1,"stale":0,"unknown":2}
fresh = [m for m in r["mates"] if m["pane"] == "w1:p1"][0]
assert fresh["freshness"] == "LATEST"
assert fresh["reason"] == "activation-proof-matches"
assert r["state"] == "unknown" and r["observable"] and r["revision_observable"]
assert len(r["latest_load_once"]["sha256"]) == 64
' || fail "--json did not emit expected proof schema"
  pass "--json emits parseable activation-proof schema"
}

test_fresh_stale_missing_and_mismatched
test_json_output_is_parseable
