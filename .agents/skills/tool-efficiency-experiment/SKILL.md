---
name: tool-efficiency-experiment
description: "Run reproducible A/B token-cost experiments for tool or context integrations with fair comparison, auditable artifacts, gates, and evidence-bounded claims."
---

Use this when measuring whether a tool, skill, CLI, MCP, or context helps.

## Contract
Compare real configs and researched baselines.
Label estimates.
Primary metric: context tokens to reach command-in-hand for one task = always-on injection plus per-task discovery; measure exact bytes and estimate tokens as bytes/4.
Also record second-nature behavior: direct tool use vs detours.
Report behavior-only wins honestly.

## Method
1. Define question, configs, representative task, and source paths.
2. Measure injected payloads, discovery docs, and proposed additions.
3. Compute totals, deltas, and break-even against any always-on cost.
4. Run a real before/after task before claiming observed savings.
5. List threats to validity and never claim causality beyond evidence.

## Required bundle
Store `data/research/<slug>/` with:
- `measure.py` that re-measures live artifacts, embeds recorded values, prints drift, and includes proposed text verbatim.
- `README.md` with question, metric, configs, results table, two-axis finding, manifest of measured paths plus environment facts, threats to validity, and next step.
- Copies of charts or artifacts, not only `.lavish/` outputs.

Run `measure.py` before recording and require no unexplained drift.
Keep raw artifacts intact.
