---
name: tool-efficiency-experiment
description: "Run a reproducible token-cost experiment on a tool/context-injection integration (e.g. an omp session extension, skill, or AXI CLI) and record it as a paper-grade artifact bundle. Use when asked to measure whether/how an integration helps in tokens or second-nature, to compare configurations, or to stash findings reproducibly."
---

Measure whether a tool integration actually helps, in the captain's terms, and preserve it so it's reproducible (toward an eventual paper).

## Metric (the captain's framing)
Ease of completing a task of a given complexity, on two axes:
- **Tokens** - context tokens to go from a fresh session to *command-in-hand for one task* = per-session injection (paid once) + per-task discovery read (e.g. reading the skill to find the command).
- **Second-nature / behavior** - does the agent reach for the right tool/command immediately, or deliberate/discover/fall back? This axis is often where a guidance injection helps even when tokens don't drop.

Report both. A change can be a *behavior* win (more reliable use) without being a *token* win - say so honestly; don't force every bar to go down.

## Method
1. **Identify configurations to compare** by research, not assumption - usually the real evolution: cold (no integration) -> current -> proposed change. Verify what actually exists (e.g. search configs for a competing MCP) so baselines are MEASURED, not estimated; mark any estimate clearly.
2. **Measure bytes on disk exactly** for each cost component: the injected payload (extract the actual injected text, not the whole file), the per-task discovery read (the SKILL.md / docs), and any proposed addition. Tokens = bytes/4 (heuristic; bytes are exact - state this).
3. **Compute per-config totals** and the deltas. Lead with the delta that answers "why make THIS change."
4. **Confirm a real before/after** on an actual task before claiming the saving as fact (the byte math predicts; an A/B confirms). Weigh always-on ambient cost against task frequency (Goodhart: keep only if measured saving beats the per-session tax; revert otherwise).

## Reproducibility bundle (mandatory - this is the science)
Store each experiment as a dated folder `data/research/<slug>/` containing:
- `measure.py` - re-measures the LIVE artifacts, embeds RECORDED snapshot values, and prints DRIFT vs recorded so a future run self-verifies. Keep proposed text (e.g. a candidate cheatsheet) verbatim in the script so the measurement survives later edits to the live files.
- `README.md` - question, metric, results table, two-axis finding, **reproducibility manifest** (exact source paths measured + environment facts), **threats-to-validity**, next step.
- A **copy** of any chart/artifact (`chart.html`). Never leave the only copy in `.lavish/` - it gets housekept.
Run `measure.py` and confirm "drift none" before recording. Preserve all raw artifacts intact - reproducibility is the tenet.

## Presenting the chart
Build a hand-designed dark artifact (not generic DaisyUI boilerplate; the captain's design-elevation + dark-mode preferences). Header names the firstmate who routed it + your own role. Show the bars with transition annotations between them ("going from this to this, and why"), and a data table with measured/estimate labels. Open with `bunx lavish-axi`; the published build's composer send may be broken, so also offer chat feedback.
