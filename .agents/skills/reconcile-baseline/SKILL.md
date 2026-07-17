---
name: reconcile-baseline
description: Reconcile arbitrary local drift in a firstmate home onto today's baseline. Use when a fresh spawn finds local files, state, or clones that diverge from the tracked template or its remote.
user-invocable: true
---

# reconcile-baseline

This skill is a routing map, not a procedure.
Every rule it points at is owned elsewhere; follow the owner, never a restatement.

## Ground truth first

Rank conflicting sources by the truth order in AGENTS.md section 1 (thinking and execution discipline).
A cached belief or local prose never overrides a fresh tool result.

## Classify each drifted item

Decide which layer owns the item using the layer contract in AGENTS.md section 1.
Tracked template material and local fleet material never share a fact (one-fact-one-owner).
Then assign exactly one verb from the six-verb disposition vocabulary in AGENTS.md section 1: keep, merge, relocate, compile, quarantine, or drop.

## Quarantine means verify before cut

Never delete or overwrite a quarantined item blind.
Verify it against live state (tool output, remote, runtime signals) and only then resolve it to keep, merge, relocate, or drop.

## Rewritten remote

If the remote history was rewritten and a fast-forward is impossible, use `sbin/fm-update.sh --adopt-remote`.
Read that script's header for its guarantees; do not hand-craft resets.

## Exit condition

Reconciliation is done when every drifted item has a named verb and its owning home, and no fact lives in two layers.
