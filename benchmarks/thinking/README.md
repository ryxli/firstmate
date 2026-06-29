# Thinking-efficiency bench (BASELINE vs NEW)

A baseline-vs-new A/B harness that proves a **thinking-discipline change cuts
reasoning-token cost and latency WITHOUT reducing output quality**, under a
strict adopt-iff decision rule. It exists so firstmate never ships a thinking
change "on vibes": validates proposals like *ground before reasoning*,
*decide-once template*, or *task-matched reasoning effort* against a fixed
corpus before adoption (see `data/notes/firstmate-thinking-efficiency.md`).

It mirrors `benchmarks/run.ts`: a deterministic, unit-tested pure core with a
flag-gated, record/replay live path so the whole thing is testable offline.

## The determinism split (why this is trustworthy)

LLM runs are non-deterministic, so the bench is split:

- **Pure core** (`corpus.ts`, `oracle.ts`, `stats.ts`, `aggregate.ts`,
  `decide.ts`, `render.ts`): deterministic, no LLM, unit-tested in CI
  (`tests/fm-think-bench.test.sh`) against synthetic metric fixtures that assert
  the adopt/reject verdict **flips** on exactly the right signals.
- **Live path** (`harness.ts`, `run.ts record`): calls the real harness, is
  flag-gated (`--live` / `FM_THINK_BENCH_LIVE=1`), and **never runs in CI**. It
  records every real run to JSON.
- **Replay** (`run.ts replay`): rebuilds the verdict from a recorded runs file
  deterministically - no LLM - so a verdict is reproducible and the bench is
  testable with zero model access.

## Usage

```sh
bin/fm-think-bench.sh check-corpus                 # validate the corpus
bin/fm-think-bench.sh grade <oracle.json> <out>    # score one output (oracle unit)
bin/fm-think-bench.sh record --live                # live A/B (real model, costs tokens)
bin/fm-think-bench.sh replay <runs.json> --out DIR # deterministic verdict from a recording
```

`record` flags (all optional): `--model <name>` (default `gpt-5.4-mini`, a cheap
reasoning model that reports `reasoningTokens` in its usage), `--thinking
<level>` (default `medium`, held constant across both variants), `--trials <n>`
(default `3`), `--baseline <file>` / `--new <file>` (variant prefix files,
default `variants/baseline.txt` / `variants/decide-once.txt`), `--corpus <dir>`,
`--out <dir>`, `--tasks a,b` (subset).

The live runner drives `omp -p --mode json --model M --no-tools --thinking L
[--append-system-prompt PREFIX] PROMPT` and reads `reasoningTokens`, `output`,
and cost straight from the assistant message usage report; latency is the wall
time of the call.

## Corpus format

Each task is one JSON file under `corpus/`:

```json
{
  "id": "arithmetic-shelf",
  "title": "shelf book count",
  "prompt": "... ends by demanding a terse, gradeable answer ...",
  "context": "fixed supporting text, read inline (empty if none)",
  "oracle": { "kind": "numeric", "expected": 42 }
}
```

- `id` is unique within the corpus and is the results key.
- `prompt` + `context` must be self-contained: with the live runner in
  `--no-tools` mode the model reads the context inline, so a task is fully
  reproducible from this record alone.
- The full input sent to the model is `context` then `prompt` (blank line
  between), so the prompt should end with the exact answer format wanted.

### Oracle kinds (all deterministic, machine-gradeable, score 0..1)

| kind | fields | score |
|---|---|---|
| `numeric` | `expected`, `tol?` | 1 if the first number in the output is within `tol` (default 0) of `expected` |
| `equals` | `expected`, `ci?` | 1 if the normalized output equals `expected` (case-insensitive unless `ci:false`) |
| `contains` | `needles[]`, `ci?` | fraction of needles present in the output |
| `regex` | `pattern`, `flags?` | 1 if the output matches |

A trial PASSES quality when its score is `>= 0.5` (`oracle.ts` `PASS_THRESHOLD`).
Quality is **never** subjective: no oracle consults a model or a human.

## Variants

A variant is a system-prompt prefix injected via `--append-system-prompt`, so a
new discipline is a new prefix file with **zero code change**. Lines starting
with `#` are comments stripped by the loader; `variants/baseline.txt` strips to
empty (the control arm adds no discipline).

## Decision rule

```
ADOPT NEW iff:
  median_thinking_tokens(new) < median_thinking_tokens(old)   (strictly fewer)
  AND quality_pass_rate(new) >= quality_pass_rate(old)         (no regression)
```

Latency is reported (token + quality + latency deltas) but is **not** a gate. On
REJECT, the failing signal is named ("thinking-tokens not reduced" and/or
"quality regressed").

## Results

`results/` holds committed demo snapshots only (like `benchmarks/results/`):
`<stamp>.runs.json` (the raw recorded runs), `<stamp>.json` (the verdict), and
`<stamp>.md` (the evidence table). Transient runs are not committed.
