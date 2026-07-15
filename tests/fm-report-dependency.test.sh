#!/usr/bin/env bash
# Regression: dependency-bearing terminal events must reach named consumers,
# and a consumer BLOCKED on an artifact that already exists must be woken
# immediately. Reproduces the 2026-07-15 incident: Bull's preflight witness
# completed at a stable path, its terminal event reached only Bull's parent
# status file, and Bear (the named consumer) sat blocked on the already-
# existing artifact for ~1h with no wake.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT="$ROOT/sbin/fm-report.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-report-dep.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

count() { local c; c=$(grep -Fc "$1" "$2" 2>/dev/null) || true; printf '%s' "${c:-0}"; }

PARENT="$TMP/state/bull-parent.status"
BEAR="$TMP/state/bear.status"
OTHER="$TMP/state/plum.status"

# --- incident reproduction -------------------------------------------------
# Producer (Bull's witness lane) finishes; artifact exists at a stable path.
ARTIFACT="$TMP/data/deploy-preflight-witness.md"
mkdir -p "$(dirname "$ARTIFACT")"
printf 'witness GO\n' > "$ARTIFACT"

TERMINAL="terminal event=wit-1 artifact=$ARTIFACT consumers=$BEAR producer=bull-witness done: preflight GO"

"$REPORT" "$PARENT" "$TERMINAL"

[ "$(count 'event=wit-1' "$PARENT")" -eq 1 ] || fail "terminal event reaches the parent status file"
# THE incident assertion: the named consumer must receive the same wake line.
[ "$(count 'event=wit-1' "$BEAR")" -eq 1 ] || fail "terminal event reaches the named consumer (incident: it never did)"
pass 'terminal event routes to parent and named consumer'

# Exactly-once: replaying the same terminal event must not double-deliver.
"$REPORT" "$PARENT" "$TERMINAL"
[ "$(count 'event=wit-1' "$PARENT")" -eq 1 ] || fail "duplicate terminal event is idempotent at the parent"
[ "$(count 'event=wit-1' "$BEAR")" -eq 1 ] || fail "duplicate terminal event is idempotent at the consumer"
pass 'duplicate terminal events deliver exactly once'

# --- multiple consumers ----------------------------------------------------
MULTI="terminal event=wit-2 artifact=$ARTIFACT consumers=$BEAR,$OTHER producer=bull-witness done: multi"
"$REPORT" "$PARENT" "$MULTI"
[ "$(count 'event=wit-2' "$BEAR")" -eq 1 ] || fail "first of two consumers woken"
[ "$(count 'event=wit-2' "$OTHER")" -eq 1 ] || fail "second of two consumers woken"
pass 'multiple named consumers each woken exactly once'

# Consumer already completed/cancelled (its status file was removed):
# delivery must neither crash nor storm.
rm -f "$OTHER"
"$REPORT" "$PARENT" "terminal event=wit-3 artifact=$ARTIFACT consumers=$OTHER producer=bull-witness done: late"
[ "$(count 'event=wit-3' "$OTHER")" -eq 1 ] || fail "delivery to a completed consumer recreates its file harmlessly"
pass 'consumer gone before delivery: harmless append, no crash'

# --- BLOCKED contract ------------------------------------------------------
# Well-formed BLOCKED on an artifact that ALREADY exists -> immediate wake.
"$REPORT" "$BEAR" "BLOCKED waiting_on=$ARTIFACT owner=bull-witness callback=rereview event=blk-1 detail: awaiting witness"
[ "$(count 'ARTIFACT_READY' "$BEAR")" -eq 1 ] || fail "consumer blocked on an existing artifact is woken immediately (incident: it never was)"
pass 'BLOCKED on existing artifact wakes immediately'

# Idempotent: same BLOCKED replay does not stack wakes.
"$REPORT" "$BEAR" "BLOCKED waiting_on=$ARTIFACT owner=bull-witness callback=rereview event=blk-1 detail: awaiting witness"
[ "$(count 'ARTIFACT_READY' "$BEAR")" -eq 1 ] || fail "replayed BLOCKED does not create a wake storm"
pass 'no wake storm on replayed BLOCKED'

# Missing artifact -> stays blocked, no phantom wake.
"$REPORT" "$BEAR" "BLOCKED waiting_on=$TMP/data/absent.md owner=bull callback=rereview event=blk-2 detail: not yet"
[ "$(count "event=blk-2 detail" "$BEAR")" -eq 1 ] || fail "BLOCKED on missing artifact is recorded"
[ "$(grep -c 'ARTIFACT_READY.*absent.md' "$BEAR" 2>/dev/null || true)" -eq 0 ] || fail "no phantom wake for a missing artifact"
pass 'BLOCKED on missing artifact stays blocked'

# Stale artifact identity: declared sha does not match the file on disk.
GOOD_SHA=$(shasum -a 256 "$ARTIFACT" | cut -d' ' -f1)
"$REPORT" "$BEAR" "BLOCKED waiting_on=$ARTIFACT waiting_on_sha=deadbeef owner=bull callback=rereview event=blk-3 detail: pinned"
[ "$(count 'ARTIFACT_STALE' "$BEAR")" -eq 1 ] || fail "sha mismatch marks the artifact stale instead of waking"
[ "$(count 'ARTIFACT_READY' "$BEAR")" -eq 1 ] || fail "sha mismatch must not emit a ready wake"
# Matching sha -> ready wake.
"$REPORT" "$BEAR" "BLOCKED waiting_on=$ARTIFACT waiting_on_sha=$GOOD_SHA owner=bull callback=rereview event=blk-4 detail: pinned"
[ "$(count 'ARTIFACT_READY' "$BEAR")" -eq 2 ] || fail "matching sha wakes"
pass 'stale artifact sha blocks the wake; matching sha wakes'

# Malformed BLOCKED (missing waiting_on/owner/callback) is rejected, exit 3.
set +e
"$REPORT" "$BEAR" "BLOCKED event=blk-5 detail: no fields at all"
rc=$?
set -e
[ "$rc" -eq 3 ] || fail "malformed BLOCKED is rejected with exit 3 (got $rc)"
[ "$(count 'event=blk-5' "$BEAR")" -eq 0 ] || fail "malformed BLOCKED is not recorded"
pass 'malformed BLOCKED rejected'

# --- frozen base interface -------------------------------------------------
# Plain two-arg reporting without dependency grammar is byte-compatible.
PLAIN="$TMP/state/plain.status"
"$REPORT" "$PLAIN" "working: ordinary progress line"
[ "$(cat "$PLAIN")" = "working: ordinary progress line" ] || fail "plain status lines pass through unchanged"
pass 'base interface unchanged for plain lines'

printf 'ok - all dependency-delivery contract cases green\n'
