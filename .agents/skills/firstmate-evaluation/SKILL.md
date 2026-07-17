---
name: firstmate-evaluation
description: "Independently decide gate depth and evaluate firstmate changes, including benchmark fairness and fresh-process verification of load-once surfaces."
---

# Firstmate evaluation

Use this for an evaluator's adopt-or-reject decision on a firstmate or harness change.
It combines gate-depth selection, suite execution, benchmark fairness, and fresh-state honesty.
Evaluator work is read-only: never modify the target tree, and snapshot then remove only files a gate creates.

## Choose depth before running

- A landing or adoption verdict MUST use the complete evaluation suite, including the live isolated e2e probe.
- During bounded iteration with familiar failure modes, use the cheap deterministic gates first for feedback speed.
- State every gate run and every deferred gate. A subset MUST NOT be represented as full coverage.
- Green gates prove the gates pass, not that they detect regressions. For a consequential verdict, add a negative control that deliberately breaks the guarded mechanism and confirm the relevant gate rejects it.

## Establish an uncontaminated target

1. Record the target commit and current tree state.
2. If the requested target is already checked out and clean, run read-only checks there. Never check out or otherwise disrupt a live home.
3. Classify every self-edit:
   - Fresh per invocation: scripts and their new-process test suites can be verified in session.
   - Load once: extensions, operating instructions, skills, and process behavior require a fresh process.
4. Validate load-once behavioral changes through an independent evaluator, an isolated temporary-home e2e or bench that starts fresh processes, or a restarted session followed by the checks.
5. Do not claim in-session verification of a load-once surface. Comment-only behavior-free edits may skip behavior verification only when explicitly called out.

## Complete suite

Run the repository's current equivalents of all seven gates and record a pass or fail for each:

1. Behavior suite, restricted to the CI test entrypoints, with no state or data pollution afterward.
2. Shell lint, with zero findings.
3. Repository invariants, including required compatibility symlinks and confirmation that local operational directories are untracked.
4. Deterministic OLD-versus-NEW benchmark rule. It must produce the required adoption verdict, improve the target cost metric, avoid a false-wake regression, and miss no relevant event. Remove only benchmark artifacts created by this run.
5. Live e2e benchmark in an isolated temporary home. It must clean up processes and herdr resources exactly.
6. Read-only lineage or topology checks, proving operational state, git status, and workspaces are unchanged before and after.
7. Demo or integration flow, proving its disposable resources self-clean and the evaluator's home remains untouched.

For a brief-generation mechanism, exercise it in a temporary home and assert that it invokes the reporting helper with quoted paths rather than issuing an agent-owned output redirect.

## Audit the benchmark before trusting its verdict

The gate suite treats a benchmark as a gate. This audit determines whether it is fair.

1. Run it twice and compare metrics apart from timestamps. Nondeterministic numbers cannot justify adoption.
2. Decompose OLD and NEW into cost components. Shared components cancel; evaluate only asymmetric costs.
3. Recover real deleted baseline code and protocol from history. Every OLD-only cost must be a mandated real behavior, not a hand-built strawman.
4. Require the real classifier to hard-assert every corpus relevance label. Spot-check realism and seek scenarios that expose NEW's weaknesses.
5. Require independent guardrails, not merely a headline cost win. Zero missed relevant events and no false-positive regression are minimum examples. A recall win can justify adoption independent of token math.
6. Stress the verdict by stripping or reducing suspicious components. Report the conservative floor and flag metrics that conflate unlike quantities.
7. Return CONFIRM or REFUTE. Separate verdict-flipping defects from non-flipping caveats. Never rubber-stamp and never reject solely for a caveat that survives sensitivity testing.

## Decision and report

ADOPT only if every required gate holds or improves with no regression in behavior, lint, repository invariants, or benchmark guardrails.
Any failed gate is REJECT, naming the failing signal.
Report the target commit, depth decision, fresh-state method, per-gate PASS or FAIL, negative-control result when used, benchmark-audit verdict when run, cleanup evidence, and the binary final verdict.
