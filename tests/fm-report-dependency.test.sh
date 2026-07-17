#!/usr/bin/env bash
# Regression: dependency-bearing terminal events must reach named consumers,
# and a consumer BLOCKED on an artifact that already exists must be woken
# immediately. Reproduces the 2026-07-15 incident: Bull's preflight witness
# completed at a stable path, its terminal event reached only Bull's parent
# status file, and Bear (the named consumer) sat blocked on the already-
# existing artifact for ~1h with no wake.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT() { "$ROOT/sbin/fm" report "$@"; }
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-report-dep.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

count() { local c; c=$(grep -Fc "$1" "$2" 2>/dev/null) || true; printf '%s' "${c:-0}"; }
count_match() { local c; c=$(grep -Ec "$1" "$2" 2>/dev/null) || true; printf '%s' "${c:-0}"; }

PARENT="$TMP/state/bull-parent.status"
BEAR="$TMP/state/bear.status"
OTHER="$TMP/state/plum.status"

# --- incident reproduction -------------------------------------------------
# Producer (Bull's witness lane) finishes; artifact exists at a stable path.
ARTIFACT="$TMP/data/deploy-preflight-witness.md"
mkdir -p "$(dirname "$ARTIFACT")"
printf 'witness GO\n' > "$ARTIFACT"

TERMINAL="terminal event=wit-1 artifact=$ARTIFACT consumers=$BEAR producer=bull-witness done: preflight GO"

REPORT "$PARENT" "$TERMINAL"

[ "$(count 'event=wit-1' "$PARENT")" -eq 1 ] || fail "terminal event reaches the parent status file"
# THE incident assertion: the named consumer must receive the same wake line.
[ "$(count 'event=wit-1' "$BEAR")" -eq 1 ] || fail "terminal event reaches the named consumer (incident: it never did)"
pass 'terminal event routes to parent and named consumer'

# Exactly-once: replaying the same terminal event must not double-deliver.
REPORT "$PARENT" "$TERMINAL"
[ "$(count 'event=wit-1' "$PARENT")" -eq 1 ] || fail "duplicate terminal event is idempotent at the parent"
[ "$(count 'event=wit-1' "$BEAR")" -eq 1 ] || fail "duplicate terminal event is idempotent at the consumer"
pass 'duplicate terminal events deliver exactly once'

# --- multiple consumers ----------------------------------------------------
MULTI="terminal event=wit-2 artifact=$ARTIFACT consumers=$BEAR,$OTHER producer=bull-witness done: multi"
REPORT "$PARENT" "$MULTI"
[ "$(count 'event=wit-2' "$BEAR")" -eq 1 ] || fail "first of two consumers woken"
[ "$(count 'event=wit-2' "$OTHER")" -eq 1 ] || fail "second of two consumers woken"
pass 'multiple named consumers each woken exactly once'

# Consumer already completed/cancelled (its status file was removed):
# delivery must neither crash nor storm.
rm -f "$OTHER"
REPORT "$PARENT" "terminal event=wit-3 artifact=$ARTIFACT consumers=$OTHER producer=bull-witness done: late"
[ "$(count 'event=wit-3' "$OTHER")" -eq 1 ] || fail "delivery to a completed consumer recreates its file harmlessly"
pass 'consumer gone before delivery: harmless append, no crash'

# --- BLOCKED contract ------------------------------------------------------
# Valid BLOCKED reports fan out both the BLOCKED state and any immediate
# artifact wake. Existing artifact -> ARTIFACT_READY at every destination.
BLOCKED_CONSUMERS="$BEAR,$OTHER"
BLOCKED_READY="BLOCKED waiting_on=$ARTIFACT owner=bull-witness callback=rereview event=blk-1 consumers=$BLOCKED_CONSUMERS detail: awaiting witness"
REPORT "$PARENT" "$BLOCKED_READY"
for dest in "$PARENT" "$BEAR" "$OTHER"; do
  [ "$(count_match '^BLOCKED.*event=blk-1' "$dest")" -eq 1 ] || fail "valid BLOCKED reaches each destination"
  [ "$(count_match '^ARTIFACT_READY.*event=blk-1' "$dest")" -eq 1 ] || fail "ready wake reaches each destination"
done
pass 'BLOCKED and ready wake fan out to primary and consumers'

# Replaying a valid BLOCKED event must not duplicate its state or wake anywhere.
REPORT "$PARENT" "$BLOCKED_READY"
for dest in "$PARENT" "$BEAR" "$OTHER"; do
  [ "$(count_match '^BLOCKED.*event=blk-1' "$dest")" -eq 1 ] || fail "replayed BLOCKED is idempotent at each destination"
  [ "$(count_match '^ARTIFACT_READY.*event=blk-1' "$dest")" -eq 1 ] || fail "replayed ready wake is idempotent at each destination"
done
pass 'replayed BLOCKED fan-out delivers exactly once'

# Stale identity fans out ARTIFACT_STALE, never ARTIFACT_READY, and remains
# idempotent when replayed.
STALE="BLOCKED waiting_on=$ARTIFACT waiting_on_sha=deadbeef owner=bull callback=rereview event=blk-2 consumers=$BLOCKED_CONSUMERS detail: pinned"
REPORT "$PARENT" "$STALE"
REPORT "$PARENT" "$STALE"
for dest in "$PARENT" "$BEAR" "$OTHER"; do
  [ "$(count_match '^BLOCKED.*event=blk-2' "$dest")" -eq 1 ] || fail "stale BLOCKED reaches each destination once"
  [ "$(count_match '^ARTIFACT_STALE.*event=blk-2' "$dest")" -eq 1 ] || fail "stale wake reaches each destination once"
  [ "$(count_match '^ARTIFACT_READY.*event=blk-2' "$dest")" -eq 0 ] || fail "stale artifact never emits ready at any destination"
done
pass 'stale artifact fans out without a ready wake'

# Missing artifact -> stays blocked at every destination, with no phantom wake.
MISSING="BLOCKED waiting_on=$TMP/data/absent.md owner=bull callback=rereview event=blk-3 consumers=$BLOCKED_CONSUMERS detail: not yet"
REPORT "$PARENT" "$MISSING"
for dest in "$PARENT" "$BEAR" "$OTHER"; do
  [ "$(count_match '^BLOCKED.*event=blk-3' "$dest")" -eq 1 ] || fail "missing-artifact BLOCKED reaches each destination"
  [ "$(count_match '^ARTIFACT_READY.*event=blk-3' "$dest")" -eq 0 ] || fail "missing artifact does not emit ready"
done
pass 'missing artifact remains blocked without a wake'

# Malformed BLOCKED is rejected before any destination, including consumers, is
# created or appended to.
REJECT_PRIMARY="$TMP/state/reject-primary.status"
REJECT_CONSUMER="$TMP/state/reject-consumer.status"
set +e
REPORT "$REJECT_PRIMARY" "BLOCKED waiting_on=$ARTIFACT event=blk-4 consumers=$REJECT_CONSUMER detail: missing owner and callback"
rc=$?
set -e
[ "$rc" -eq 3 ] || fail "malformed BLOCKED is rejected with exit 3 (got $rc)"
[ ! -e "$REJECT_PRIMARY" ] || fail "malformed BLOCKED must not create the primary destination"
[ ! -e "$REJECT_CONSUMER" ] || fail "malformed BLOCKED must not create consumer destinations"
pass 'malformed BLOCKED atomically rejects all destinations'

# --- frozen base interface -------------------------------------------------
# Plain two-arg reporting without dependency grammar is byte-compatible.
PLAIN="$TMP/state/plain.status"
REPORT "$PLAIN" "working: ordinary progress line"
[ "$(cat "$PLAIN")" = "working: ordinary progress line" ] || fail "plain status lines pass through unchanged"
pass 'base interface unchanged for plain lines'

printf 'ok - all dependency-delivery contract cases green\n'
