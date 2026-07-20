---
name: fm-reconcile-home-drift
description: >-
  Classifies local home drift onto today's baseline. Use when a fresh spawn
  finds diverged files, state, or clones.
user-invocable: true
---

# fm-reconcile-home-drift

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

Only after cap approval and a sanctioned `--force-with-lease` rewrite on the other machine, run `sbin/fm update --adopt-remote`.
Let the updater enforce its clean-tree, diverged-history, and no-local-only-commits gates; never hand-craft a reset.

## Exit condition

Reconciliation is done when every drifted item has one named verb and one owning file/layer, with its home named where relevant, and no fact lives in two layers.
