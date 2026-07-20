#!/usr/bin/env bash
# Verify fleet view rejects flag values, honors explicit homes, and preserves
# live status when rendering an input snapshot.
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

make_home() {
  local home=$1
  mkdir -p "$home/data" "$home/state" "$home/config" "$home/sbin"
  : > "$home/sbin/fm" spawn
  printf '%s\n' '## In flight' '- **active** - running (repo: app)' '## Queued' '## Done' > "$home/data/backlog.md"
  printf '%s\n' 'fixture manifest' > "$home/AGENTS.md"
}

A="$TMP/home-a"
B="$TMP/home-b"
make_home "$A"
make_home "$B"
printf '%s\n' '{"result":{"panes":[]}}' > "$TMP/panes.json"
FOLDER="${B//\//-}"
printf '%s\n' '{"byFolder":[{"folder":"'"$FOLDER"'","totalCost":1.25,"totalInputTokens":100,"totalOutputTokens":50,"totalCacheReadTokens":30,"totalCacheWriteTokens":20,"totalRequests":2,"failedRequests":0}]}' > "$TMP/stats.json"

if FM_HOME="$A" FM_FLEET_PANES_FILE="$TMP/panes.json" \
  bun "$ROOT/sbin/fm" fleet view --home --no-open >/dev/null 2>&1; then
  echo "fleet view accepted a following flag as --home value" >&2
  exit 1
elif [ "$?" -ne 2 ]; then
  echo "fleet view returned the wrong missing-value status" >&2
  exit 1
fi

FM_HOME="$A" FM_FLEET_PANES_FILE="$TMP/panes.json" \
  bun "$ROOT/sbin/fm" fleet view --home "$B" --no-open --output "$TMP/fleet.html" >/dev/null

python3 - "$B" "$TMP/fleet.html" <<'PY'
import sys
home, fleet = sys.argv[1:]
assert home in open(fleet).read(), home
PY

printf '%s\n' '{"schema":"fleet-snapshot/1","home":"/tmp/home-a","homePaths":["/tmp/home-a","/tmp/plum","/tmp/gauge"],"health":{"state":"degraded","homes":3,"missingHomes":0,"livePanes":0,"herdr":"ok"},"agents":[],"tasks":[],"attention":[],"pending":[],"mates":[],"otherLivePanes":[],"notes":[]}' > "$TMP/count-input.json"
bun "$ROOT/sbin/fm" fleet view --input "$TMP/count-input.json" --no-open --output "$TMP/count.html" >/dev/null
python3 - "$TMP/count.html" <<'PY'
import json, re, sys
html = open(sys.argv[1]).read()
m = re.search(r'<script type="application/json" id="fv-payload">(.*?)</script>', html, re.S)
assert m, "missing fv-payload data island"
payload = json.loads(m.group(1))
fleet = payload["fleet"]
paths = fleet["homePaths"]
assert set(paths) == {"/tmp/home-a", "/tmp/plum", "/tmp/gauge"}, paths
assert len(paths) == 3, paths
assert fleet["health"]["homes"] == 3, fleet["health"]
PY
printf '%s\n' 'ok - visual projection carries authoritative multi-home count'

cat > "$TMP/live-status-input.json" <<'JSON'
{"schema":"fleet-snapshot/1","home":"/tmp/home-a","homePaths":["/tmp/home-a"],"health":{"state":"healthy","homes":1,"missingHomes":0,"livePanes":2,"herdr":"ok"},"agents":[{"key":"home-a/done-idle","id":"done-idle","owner":"home-a","kind":"ship","status":"done","statusFile":{"state":"done","text":"finished"},"home":"/tmp/home-a","topology":{"home":"/tmp/home-a","pane":"w1:p1","workspace":"w1","tab":"t1","agentStatus":"idle"}},{"key":"home-a/done-working","id":"done-working","owner":"home-a","kind":"ship","status":"done","statusFile":{"state":"done","text":"finished"},"home":"/tmp/home-a","topology":{"home":"/tmp/home-a","pane":"w1:p2","workspace":"w1","tab":"t1","agentStatus":"working"}},{"key":"home-a/done-missing","id":"done-missing","owner":"home-a","kind":"ship","status":"done","statusFile":{"state":"done","text":"finished"},"home":"/tmp/home-a","topology":{"home":"/tmp/home-a","degraded":"missing-pane"}}],"tasks":[],"attention":[],"pending":[],"mates":[],"otherLivePanes":[],"notes":[]}
JSON
bun "$ROOT/sbin/fm" fleet view --input "$TMP/live-status-input.json" --no-open --output "$TMP/live-status.html" >/dev/null
bun - "$TMP/live-status.html" <<'JS'
import { readFileSync } from "node:fs";

const html = readFileSync(process.argv[2], "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
const source = scripts.at(-1)?.[1] ?? "";
const exposed = source.replace(
  /\n  render\(\);\n\}\)\(\);\s*$/,
  "\n  globalThis.__fleetSnapshotTree = snapshotTree;\n})();",
);
if (exposed === source) throw new Error("could not expose snapshotTree fixture seam");
(0, eval)(exposed);
const payloadText = html.match(/<script type="application\/json" id="fv-payload">([\s\S]*?)<\/script>/)?.[1];
if (!payloadText) throw new Error("missing embedded fleet payload");
const tree = globalThis.__fleetSnapshotTree(JSON.parse(payloadText).fleet);
const panes = tree.workspaces.flatMap(workspace => workspace.tabs.flatMap(tab => tab.panes));
const byLabel = new Map(panes.map(pane => [pane.label, pane.agent_status]));
if (byLabel.get("done-idle") !== "idle") throw new Error(`done file plus live idle displayed ${byLabel.get("done-idle")}`);
if (byLabel.get("done-working") !== "working") throw new Error(`done file plus live working displayed ${byLabel.get("done-working")}`);
if (byLabel.get("done-missing") !== "done") throw new Error("missing pane did not fall back to persisted status");
JS
printf '%s\n' 'ok - fleet view prefers reachable live status over persisted done status'
printf '%s\n' 'ok - fleet view rejects flag values and honors explicit homes'
