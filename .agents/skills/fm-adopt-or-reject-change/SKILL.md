---
name: fm-adopt-or-reject-change
description: "Evaluate harness changes with proportionate gates and fresh-state proof."
---

Never modify the target: use an isolated copy for destructive gates and remove only artifacts that run created.
Verdict: **ADOPT** or **REJECT**.

## Gates

- Adoption gets the full suite plus isolated live e2e; iteration may run narrow gates, list deferrals, and never claim full coverage.
- Load-once changes need an independent evaluator, isolated temp home, or restarted session.
- Consequential ADOPT needs a negative control in the isolated copy: break the guard and prove rejection.
- ADOPT requires every gate to pass or improve without behavior, invariant, or benchmark regression.

Report target, depth, fresh-state method, gate evidence, negative control, and verdict.
