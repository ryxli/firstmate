---
name: fm-adopt-or-reject-change
description: >-
  Independent ADOPT/REJECT evaluation of harness changes. Use when choosing
  gate depth, fresh-process checks, or benchmark fairness.
---

# fm-adopt-or-reject-change

Evaluator work is read-only: never modify the target tree; snapshot then remove only files a gate creates.
Binary contract: **ADOPT** or **REJECT**. No soft landings.

## Depth

- Landing/adoption verdict → complete suite including live isolated e2e.
- Bounded iteration with familiar failures → cheap deterministic gates first; state every deferred gate.
- A subset must not be represented as full coverage.
- Consequential verdict → add a negative control that breaks the guarded mechanism and confirm the gate rejects it.

## Fresh process

Classify each surface: fresh-per-invocation (scripts/tests) vs load-once (extensions, AGENTS.md, skills, process behavior).
Load-once changes require an independent evaluator, isolated temporary-home e2e, or restarted session - never claim in-session verification.
Never check out or disrupt a live home; run read-only on a clean requested target.

## Negative control

Green gates prove gates pass, not that they detect regressions.
For ADOPT on a consequential change, deliberately break the guarded mechanism once and confirm rejection.

## Decision

ADOPT only if every required gate holds or improves with no regression in behavior, lint, repository invariants, or benchmark guardrails.
Any failed required gate is REJECT naming the failing signal.
Report: target commit, depth, fresh-state method, per-gate PASS/FAIL, negative-control result when used, binary verdict.
