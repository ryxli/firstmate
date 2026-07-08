#!/usr/bin/env bash
# Hermetic tests for bin/fm-focus: the priority ranking guarantee.
#
# Asserts the total order against fixtures WITHOUT a live herdr (FM_FOCUS_NO_HERDR
# skips the agent_status subprocess), so the status-line-driven classes - the
# captain-facing guarantee - are tested deterministically. A second pass feeds
# items directly (--items) to cover the agent_status-driven classes and the
# proximity tie-break. Mirrors the on-disk ground truth fm-focus reads in prod.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FOCUS="$ROOT/bin/fm-focus.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export FM_FOCUS_NO_HERDR=1

FAILED=0
fail() { printf 'not ok - %s\n' "$1"; FAILED=1; }
pass() { printf 'ok - %s\n' "$1"; }

# --- build a fixture firstmate home + one secondmate home -------------------
H="$TMP/home"
SM="$TMP/fm-sm-deep"
mkdir -p "$H/state" "$H/data" "$SM/state" "$SM/data"

wmeta() { # wmeta <home> <id> <kind> [pane]
  printf 'pane=%s\nkind=%s\nworker=%s\n' "${4:-w1:p0}" "$3" "$2" > "$1/state/$2.meta"
}
wstatus() { printf '%s\n' "$3" > "$1/state/$2.status"; }

wmeta "$H" fix-login ship w1:p1;  wstatus "$H" fix-login "failed: wedged after relaunch"
wmeta "$H" add-tests ship w1:p2;  wstatus "$H" add-tests "needs-decision: which test framework?"
wmeta "$H" wire-api ship w1:p3;   wstatus "$H" wire-api "needs-decision: which auth?"
wmeta "$H" refactor ship w1:p4;   wstatus "$H" refactor "done: PR https://x/9 checks green"
wmeta "$H" cleanup ship w1:p5;    wstatus "$H" cleanup "done: PR merged"
wmeta "$H" plum secondmate w15:p2; wstatus "$H" plum "done: independent audit confirms adopt"

# secondmate home: a forwarded (depth 1) escalation
wmeta "$SM" grandkid ship w20:p1; wstatus "$SM" grandkid "needs-decision: deep choice"
printf '## Queued\n' > "$SM/data/backlog.md"

# register the secondmate + backlog: two queued items blocked by add-tests, one by wire-api
printf -- '- deep - eval (home: %s; scope: x; projects: (none); added 2026-01-01)\n' "$SM" > "$H/data/secondmates.md"
cat > "$H/data/backlog.md" <<'EOF'
## Queued
- [ ] q1 - thing (repo: x) blocked-by: add-tests - needs framework
- [ ] q2 - other (repo: x) blocked-by: add-tests - same
- [ ] q3 - more (repo: x) blocked-by: wire-api - needs auth
## Done
EOF

# --- Part 1: order from the on-disk home (the guarantee) --------------------
"$FOCUS" --home "$H" --json --no-color > "$TMP/out.json" 2>"$TMP/err" \
  || fail "fm-focus --home exited nonzero ($(cat "$TMP/err"))"

if python3 - "$TMP/out.json" <<'PY'
import sys, json
rows = json.load(open(sys.argv[1]))
order = [r["id"] for r in rows]
cls = {r["id"]: r["class"] for r in rows}
idx = {r["id"]: i for i, r in enumerate(rows)}
def check(cond, msg):
    print(("ok - " if cond else "not ok - ") + msg)
    return cond
ok = True
ok &= check(order[0] == "fix-login", "#1 is the failed task (got %r)" % (order[0],))
ok &= check(cls["fix-login"] == "CAPTAIN-BLOCKED", "failed -> CAPTAIN-BLOCKED")
ok &= check(cls["add-tests"] == "CAPTAIN-BLOCKED" and cls["wire-api"] == "CAPTAIN-BLOCKED", "needs-decision -> CAPTAIN-BLOCKED")
ok &= check(idx["add-tests"] < idx["wire-api"], "blast radius floats add-tests (blocks 2) above wire-api (blocks 1)")
ok &= check(idx["wire-api"] < idx["grandkid"], "direct report ranks above forwarded at equal blast/age (proximity)")
ok &= check(cls["refactor"] == "REVIEW-READY" and cls["cleanup"] == "REVIEW-READY", "done/merged -> REVIEW-READY")
ok &= check(idx["refactor"] < idx["cleanup"], "PR-green (sev1) above merged-teardown (sev0) within review-ready")
ok &= check(all(idx[c] < idx["refactor"] for c in ("fix-login","add-tests","wire-api","grandkid")), "every captain-blocked outranks every review-ready")
ok &= check(cls["plum"] == "DORMANT", "secondmate with a done line is DORMANT, not review-ready")
ranks = [r["rank"] for r in rows]
ok &= check(ranks == list(range(1, len(rows)+1)), "ranks are a dense total order 1..N (no ties)")
sys.exit(0 if ok else 1)
PY
then
  :
else
  fail "Part 1 order assertions"
fi

# --- Part 2: agent_status-driven classes + proximity via --items ------------
cat > "$TMP/items.json" <<'EOF'
[
  {"id":"b","statusLine":"failed: x","depth":0},
  {"id":"near","statusLine":"needs-decision: x","depth":0,"statusMtime":100},
  {"id":"far","statusLine":"needs-decision: x","depth":1,"statusMtime":100},
  {"id":"w","agent_status":"working","statusLine":"","depth":0},
  {"id":"i","agent_status":"idle","statusLine":"","depth":0},
  {"id":"u","agent_status":"unknown","statusLine":"","depth":0}
]
EOF
"$FOCUS" --items "$TMP/items.json" --json --no-color > "$TMP/items-out.json" 2>"$TMP/err2" \
  || fail "fm-focus --items exited nonzero ($(cat "$TMP/err2"))"

if python3 - "$TMP/items-out.json" <<'PY'
import sys, json
rows = json.load(open(sys.argv[1]))
order = [r["id"] for r in rows]
cls = {r["id"]: r["class"] for r in rows}
def check(cond, msg):
    print(("ok - " if cond else "not ok - ") + msg); return cond
ok = True
ok &= check(order == ["b","near","far","w","i","u"], "full spectrum order failed/blocked > working > idle > unknown (got %r)" % (order,))
ok &= check(order.index("near") < order.index("far"), "proximity: same blast+age, direct (depth0) before forwarded (depth1)")
ok &= check(cls["w"] == "IN-FLIGHT" and cls["i"] == "DORMANT" and cls["u"] == "UNKNOWN", "agent_status maps working/idle/unknown")
sys.exit(0 if ok else 1)
PY
then
  :
else
  fail "Part 2 items assertions"
fi

# --- Part 3: empty fleet ----------------------------------------------------
mkdir -p "$TMP/empty/state" "$TMP/empty/data"
emptyjson="$("$FOCUS" --home "$TMP/empty" --json --no-color)"
if [ "$emptyjson" = "[]" ]; then pass "empty fleet -> empty json"; else fail "empty fleet json (got: $emptyjson)"; fi
if "$FOCUS" --home "$TMP/empty" --no-color | grep -q "nothing needs you"; then pass "empty fleet -> friendly table"; else fail "empty fleet table"; fi

if [ "$FAILED" = 0 ]; then printf 'PASS fm-focus\n'; exit 0; else printf 'FAIL fm-focus\n'; exit 1; fi
