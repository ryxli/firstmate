# action-bench

A live agentic-coding benchmark that isolates the **effect of the harness**. Each scenario gives a
real agent (omp) a task in a controlled fixture with real tools; the only thing varied between arms
is the system-prompt scaffold - `control` (none, the floor) vs `harness` (the firstmate discipline
scaffold, `arms/harness.txt`). Everything else is held constant (same model, tools, corpus,
tokenizer), so a metric delta is the isolated causal effect of the harness.

Runs on **bun** (like `benchmarks/thinking`): the deterministic core (integrity gates + corpus
metrics + replay aggregation) is pure and CI-tested; only the live A/B path spends tokens and is
flag-gated out of CI. Complements `benchmarks/thinking/` (thinking-efficiency A/B) and the
deterministic supervision benchmark: those measure narrow decision rules, this measures end-to-end
agentic behavior.

## What it measures (three axes)

1. **Correctness incl. procedural [primary]** - did the agent reach the intended outcome by a valid,
   non-corrupt path. Judged by end-state goal-progress (multi-path, never a gold tool sequence) AND
   a procedural guard, so a reward-hacked or corrupt pass does not count.
2. **Cost-of-pass efficiency [secondary, on correct runs only]** - token generation (reproducible,
   provider-independent primary), reasoning tokens + turns, and wall-clock/throughput/cost sourced
   from `omp stats --json` (dual measurement; wall-clock is the noisy real-world secondary).
3. **Capability across difficulty** - how far up the difficulty ladder (easy -> medium -> hard ->
   aspirational) the arm stays correct. Difficulty-adaptive: fast on easy, deep on hard.

## The corpus: synthetic + sanitized real-history

Most scenarios are hand-built synthetic puzzles. A subset (`scenarios/reallog.ts`,
`scenarios/reallog_history.ts`) is instead derived from sanitized firstmate operational history -
backlog-done records, state-status lines, and session/turn-board history (see `history.sourceClass`
on a `Scenario`) - so the corpus also measures the harness against the shapes of judgment calls
firstmate actually makes. Only sanitized, generic building blocks are ever committed; `corpus.ts`'s
sanitizer scans every real-history scenario's materialized fixture, prompt, and leak markers for
operational data (absolute home paths, emails, IPs, private-key headers, credential/secret-like
tokens) before any live run is allowed to trust the corpus - see the **real-history-safe** gate below.
`bench.ts corpus` prints the machine-readable split (total, synthetic vs real-history, per-source-class
counts, difficulty distribution, sanitize verdict) without spending a token.

## Integrity gates (deterministic, hard-assert, abort on failure)

`gates.ts` enforces the corpus is fair before any result is trusted; `bench.ts gates` runs all 6 and
exits non-zero on any failure:

- **prompt-symmetry** - both arms get identical task text; the only delta is the generic scaffold.
- **scaffold-agnostic** - the harness scaffold names no scenario id and carries no solution token.
- **no-leak** - a scenario's solution tokens appear in neither arm's prompt.
- **real-difficulty** - a no-op agent FAILS every scenario and the grader can score < 1.0.
- **ground-truth-pinned** - each scenario's own oracle solution scores exactly correct + clean +
  progress 1.0, and grading is deterministic. Ground truth is spec-computed, never hand-annotated.
- **real-history-safe** - every real-history scenario's fixture/prompt/leak markers are free of
  operational data; the sanitizer self-tests against known poison first, so a broken matcher fails
  loudly instead of silently waving unsafe content through (`corpus.ts`). Honors
  `FM_ACTION_BENCH_POISON=abspath|secret` to inject a deliberately-leaking negative control into the
  scan (the gate MUST then fail) - this is how the sanitizer itself is tested.

## Long-horizon (multi-session)

A scenario may set `steps` (a list of `[task, inject]`), turning a run into a SEQUENCE of fresh omp
sessions over one persisting fixture: `inject` evolves the state between sessions, and the agent's
only memory is the fixture on disk. This measures sustained cross-session consistency (the real
first-mate failure mode across restarts), where errors compound.

## Usage

```
sbin/fm-action-bench.sh gates                        # integrity gates only (pure, no tokens) - what CI runs
sbin/fm-action-bench.sh corpus                       # corpus metrics + sanitize verdict (pure, no tokens)
sbin/fm-action-bench.sh replay results/<r>.runs.json # re-aggregate a recorded run (pure)
sbin/fm-action-bench.sh run --live --trials 3 --model gpt-5.4-mini --thinking low   # LIVE A/B (costs tokens)

bun benchmarks/action-bench/compare.ts   results/<a>.runs.json ...   # cross-model narrative markdown
bun benchmarks/action-bench/charts.ts    results/<a>.runs.json ...   # tidy chart-consumable JSON (offload viz)
bun benchmarks/action-bench/calibrate.ts results/<a>.runs.json ...   # flag non-discriminating (saturated) scenarios
bun benchmarks/action-bench/verify-scenario.ts scenarios/<f>.ts     # gate one scenario file in isolation (authoring)

benchmarks/action-bench/milestone.sh <label> [sha] [trials]         # MILESTONE cadence: full tri-model + ledger
```

The live path refuses without `--live` (or `FM_ACTION_BENCH_LIVE=1`). Claude arms run
`--thinking off` (omp `-p` sends an `effort` param Anthropic rejects otherwise), so reasoning-tokens
are N/A for them; generation tokens + turns carry axis-2. gpt runs `--thinking low`. Scenarios that
grade a code fixture may generate a small script at runtime and shell to `python3` to run its test;
no such file is tracked - fixtures are created by `setup()` at run time.

## Cadence

Run the full suite at **milestone cadence** (not continuously) to track macro harness progress over
time. `milestone.sh` runs the integrity gates, then the full corpus across all models, then appends
one comparable macro row to the durable ledger `results/milestones.{jsonl,md}`.

`milestone.sh` also accepts test/override knobs so the whole pipeline can be exercised without
network or tokens: `FM_MILESTONE_OMP` points at a stub standing in for the `omp` binary,
`FM_MILESTONE_MODELS` restricts the model set, `FM_MILESTONE_ONLY` restricts the scenario corpus
(must include at least one real-history scenario id, or the real-history-safe gate fails by design),
and `FM_MILESTONE_OUT` redirects every written artifact to an isolated directory instead of the
committed `results/`. None of these are needed for a real milestone run; all default to the real
tri-model, full-corpus, real-`omp`, real-`results/` behavior.

## Layout

```
types.ts             the contract (Scenario/Trace/ToolCall/GoalResult/ProcResult + constructors); a leaf module
engine.ts            the live runner (single- + multi-session), 3-axis aggregation, dual measurement, markdown render
gates.ts             the 6 deterministic integrity gates
corpus.ts            corpus metrics + the real-history sanitizer (backs the real-history-safe gate)
arms.ts              the arm loader (control = "", harness = arms/harness.txt)
bench.ts             CLI entry: gates | corpus | replay | run (guarded by import.meta.main)
scenarios/index.ts   static registry: imports every scenario file, flattens the corpus
scenarios/*.ts       the corpus (easy -> aspirational): synthetic puzzles + sanitized real-history
                     (reallog.ts, reallog_history.ts), each with setup/goal/procedural + oracle + leakMarkers
arms/harness.txt     the harness-discipline scaffold (the only thing varied)
compare.ts           cross-model narrative comparison (markdown)
charts.ts            tidy chart-consumable aggregated JSON (viz offloaded to a scientific charting tool)
calibrate.ts         difficulty-calibration analyzer (both-arms-saturated -> drop a tier)
milestone.sh         one-command milestone run + ledger append
milestone-ledger.ts  macro progress ledger (results/milestones.{jsonl,md})
verify-scenario.ts   authoring helper: gate one scenario file in isolation
results/             milestones.* (durable macro record) + latest comparison/charts; per-run artifacts gitignored
```
