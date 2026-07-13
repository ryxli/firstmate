#!/usr/bin/env bash
# fm-fleet-updated.sh - read-only activation-proof check for live OMP panes.
#
# A session-file mtime is not evidence that an omp --resume process loaded
# current sources. Each session_start writes an activation receipt, and this
# command compares that receipt with live Herdr identity, pane identity, and
# the exact current load-once manifest digest.
set -u

usage() {
  printf '%s\n' 'usage: fm-fleet-updated.sh [--json]' >&2
  printf '%s\n' '  Report whether live agent sessions have a current activation receipt.' >&2
  printf '%s\n' '  This command is strictly read-only: it only runs herdr pane list and reads files.' >&2
}

OUTPUT_MODE=text
case "${1:-}" in
  '') ;;
  --json) OUTPUT_MODE=json ;;
  -h|--help) usage; exit 0 ;;
  *) printf 'error: unknown argument: %s\n' "$1" >&2; usage; exit 2 ;;
esac
[ "$#" -le 1 ] || { printf 'error: expected at most one argument\n' >&2; usage; exit 2; }

SCRIPT_FILE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_FILE")" && pwd -P)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd -P)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"

set -- AGENTS.md

HERDR_STATE=unknown
PANES_JSON=
CURRENT_PANE_ID=
if command -v herdr >/dev/null 2>&1; then
  PANES_JSON=$(herdr pane list 2>/dev/null || true)
  CURRENT_PANE_ID=$(herdr pane current 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("result",{}).get("pane",{}).get("pane_id",""))' \
    2>/dev/null || true)
  [ -n "$PANES_JSON" ] && HERDR_STATE=ok
fi

printf '%s' "$PANES_JSON" | python3 -c '
import datetime
import hashlib
import json
import re
import os
import subprocess
import sys
mode, root, home, herdr_state, current_pane = sys.argv[1:6]
root = os.path.realpath(root)
paths = ["AGENTS.md"]
extension_root = os.path.join(root, ".omp", "extensions")
manifest_available = os.path.isdir(extension_root)
if manifest_available:
    for directory, subdirs, filenames in os.walk(extension_root):
        subdirs.sort()
        for filename in sorted(filenames):
            full = os.path.join(directory, filename)
            paths.append(os.path.relpath(full, root))
paths.sort()

def iso(value):
    if not isinstance(value, str) or not value:
        return "unknown"
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return "unknown"
        return parsed.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError):
        return "unknown"

entries = []
for rel in paths:
    try:
        data = open(os.path.join(root, rel), "rb").read()
    except OSError:
        continue
    entries.append({"path": rel, "sha256": hashlib.sha256(data).hexdigest()})
required_extension = ".omp/extensions/fm-supervisor.ts"
manifest_available = manifest_available and any(entry["path"] == required_extension for entry in entries)
manifest_hash = hashlib.sha256(
    b"".join(e["path"].encode() + b"\0" + e["sha256"].encode() + b"\0" for e in entries)
).hexdigest() if manifest_available and len(entries) == len(paths) else None

try:
    payload = json.load(sys.stdin)
    panes = payload.get("result", {}).get("panes", [])
    if not isinstance(panes, list):
        panes = []
        herdr_state = "unknown"
except Exception:
    panes = []
    herdr_state = "unknown"

def identity(pane):
    path = pane.get("agent_session_path")
    sid = pane.get("agent_session_id")
    legacy = pane.get("agent_session")
    if isinstance(legacy, dict):
        value = legacy.get("value")
        kind = legacy.get("kind")
        if isinstance(value, str) and value:
            if kind in ("id", "session_id"):
                sid = sid or value
            elif kind in ("path", "session_path", "file"):
                path = path or value
            elif not kind and value.startswith("/"):
                path = path or value
    return (str(path) if isinstance(path, str) and path else None,
            str(sid) if isinstance(sid, str) and sid else None)

def receipt_path(pane):
    explicit = pane.get("activation_receipt_path")
    if isinstance(explicit, str) and explicit:
        return explicit
    cwd = pane.get("cwd")
    if isinstance(cwd, str) and cwd:
        return os.path.join(cwd, "state", "activation-receipt.json")
    return os.path.join(home, "state", "activation-receipt.json")

def valid_receipt(receipt):
    if receipt.get("schema") != "firstmate.activation-receipt/v1":
        return False, "receipt-schema-mismatch"
    listed = receipt.get("manifest")
    if not isinstance(listed, list) or not listed:
        return False, "receipt-manifest-malformed"
    normalized = []
    for entry in listed:
        if not isinstance(entry, dict):
            return False, "receipt-manifest-malformed"
        path = entry.get("path")
        digest = entry.get("sha256")
        if not isinstance(path, str) or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            return False, "receipt-manifest-malformed"
        normalized.append({"path": path, "sha256": digest})
    if normalized != sorted(normalized, key=lambda item: item["path"]):
        return False, "receipt-manifest-malformed"
    if len({entry["path"] for entry in normalized}) != len(normalized):
        return False, "receipt-manifest-malformed"
    digest = hashlib.sha256(
        b"".join(e["path"].encode() + b"\0" + e["sha256"].encode() + b"\0" for e in normalized)
    ).hexdigest()

    if receipt.get("manifest_sha256") != digest:
        return False, "receipt-manifest-mismatch"
    return True, "ok"
expected = {}
self_missing = not bool(current_pane)
if current_pane:
    expected[current_pane] = ("self", home)
state_dir = os.path.join(home, "state")
try:
    for filename in os.listdir(state_dir):
        if not filename.endswith(".meta"):
            continue
        fields = {}
        for line in open(os.path.join(state_dir, filename), encoding="utf-8"):
            if "=" in line:
                key, value = line.rstrip("\n").split("=", 1)
                fields[key] = value
        if fields.get("kind") != "secondmate":
            continue
        task = filename[:-5]
        stored_pane = fields.get("pane")
        expected_home = fields.get("home")
        if not stored_pane:
            expected[f"missing:{task}"] = ("secondmate-missing-pane", expected_home)
            continue
        if not expected_home:
            expected[f"missing-home:{task}"] = ("secondmate-missing-home", None)
            continue
        slot = fields.get("agent_slot") or f"fm-{task}"
        live_pane = None
        try:
            raw = subprocess.run(["herdr", "agent", "get", slot], capture_output=True, text=True, timeout=5).stdout
            live_pane = json.loads(raw).get("result", {}).get("agent", {}).get("pane_id")
            if not live_pane:
                live_pane = json.loads(raw).get("result", {}).get("pane_id")
        except (OSError, subprocess.SubprocessError, ValueError, TypeError):
            pass
        expected[live_pane or stored_pane] = ("secondmate", expected_home)
except OSError:
    pass
pane_by_id = {
    str(pane.get("pane_id")): pane for pane in panes
    if isinstance(pane, dict) and pane.get("pane_id")
}

mates = []
for pane_id, expected_entry in expected.items():
    expected_kind, expected_home = expected_entry
    pane = pane_by_id.get(pane_id)
    if not isinstance(pane, dict):
        if pane_id.startswith("missing-home:"):
            missing_reason = "missing-supervisor-home"
        elif pane_id.startswith("missing:"):
            missing_reason = "missing-supervisor-metadata"
        else:
            missing_reason = "missing-live-pane"
        mates.append({"pane": pane_id, "name": expected_kind, "status": "unknown",
                      "session_path": None, "session_id": None,
                      "receipt": os.path.join(expected_home, "state", "activation-receipt.json") if expected_home else None, "started_at": "unknown",
                      "freshness": "unknown", "reason": missing_reason})
        continue
    session_path, session_id = identity(pane)
    agent = pane.get("agent")
    if agent != "omp":
        mates.append({"pane": pane_id, "name": expected_kind, "status": str(pane.get("agent_status") or "unknown"),
                      "session_path": None, "session_id": None,
                      "receipt": os.path.join(expected_home, "state", "activation-receipt.json") if expected_home else None, "started_at": "unknown",
                      "freshness": "unknown", "reason": "expected-pane-not-omp"})
        continue
    name = str(pane.get("display_agent") or pane.get("label") or agent or "unknown")
    status = str(pane.get("agent_status") or "unknown")
    freshness, reason = "unknown", "missing-activation-receipt"
    receipt = None
    try:
        with open(os.path.join(expected_home, "state", "activation-receipt.json"), encoding="utf-8") as stream:
            receipt = json.load(stream)
    except (OSError, ValueError, TypeError):
        pass
    if not isinstance(receipt, dict):
        reason = "missing-activation-receipt"
    elif not valid_receipt(receipt)[0]:
        reason = valid_receipt(receipt)[1]
    elif not (session_path or session_id):
        reason = "missing-session-identity"
    elif receipt.get("pane_id") != pane_id:
        reason = "pane-id-mismatch"
    elif session_path and receipt.get("session_path") != session_path:
        reason = "session-path-mismatch"
    elif session_id and receipt.get("session_id") != session_id:
        reason = "session-id-mismatch"
    elif receipt.get("manifest_sha256") != manifest_hash:
        freshness, reason = "STALE", "manifest-mismatch"
    elif iso(receipt.get("started_at")) == "unknown":
        reason = "invalid-start-time"
    elif not manifest_hash:
        reason = "current-manifest-unavailable"
    else:
        freshness, reason = "LATEST", "activation-proof-matches"
    mates.append({
        "pane": pane_id,
        "name": name,
        "status": status,
        "session_path": session_path,
        "session_id": session_id,
        "receipt": os.path.join(expected_home, "state", "activation-receipt.json") if expected_home else None,
        "started_at": iso(receipt.get("started_at")) if isinstance(receipt, dict) else "unknown",
        "freshness": freshness,
        "reason": reason,
    })

summary = {
    "total": len(mates),
    "latest": sum(m["freshness"] == "LATEST" for m in mates),
    "stale": sum(m["freshness"] == "STALE" for m in mates),
    "unknown": sum(m["freshness"] == "unknown" for m in mates),
}
observable = herdr_state == "ok" and summary["total"] > 0 and not self_missing
revision_observable = manifest_hash is not None
if not observable or not revision_observable:
    result_state = "unknown"
elif summary["unknown"] or summary["stale"]:
    result_state = "stale" if summary["stale"] else "unknown"
else:
    result_state = "fresh"
result = {
    "latest_load_once": {"sha256": manifest_hash, "paths": paths},
    "herdr": herdr_state,
    "mates": mates,
    "summary": summary,
    "observable": observable,
    "revision_observable": revision_observable,
    "state": result_state,
}
if mode == "json":
    print(json.dumps(result, sort_keys=True))
else:
    for mate in mates:
        identity_text = mate["session_path"] or mate["session_id"] or "unknown"
        print("%s %s %s session~%s -> %s (%s)" % (
            mate["pane"], mate["name"], mate["status"], identity_text,
            mate["freshness"], mate["reason"],
        ))
    print("summary total=%d latest=%d stale=%d unknown=%d herdr=%s manifest~%s observable=%s revision=%s state=%s" % (
        summary["total"], summary["latest"], summary["stale"], summary["unknown"],
        herdr_state, manifest_hash or "unknown", str(observable).lower(),
        str(revision_observable).lower(), result_state,
    ))
sys.exit(0 if result_state == "fresh" else 1)
' "$OUTPUT_MODE" "$FM_ROOT" "$FM_HOME" "$HERDR_STATE" "$CURRENT_PANE_ID" "$@"
