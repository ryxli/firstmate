# fm-milestone

One command, one reproducible row, quantifying the harness at a point in time.

`sbin/fm milestone <label> [sha]` composes instruments that already exist and are already
proven - it invents no new measurement, only folds their outputs into a single durable ledger:

- `benchmarks/action-bench/bench.ts gates` - the 6 deterministic integrity gates over the pinned
  scenario corpus (fair-A/B substrate check; aborts nothing here, just records PASS/FAIL + count).
- `benchmarks/action-bench/bench.ts corpus` - deterministic corpus metrics (total / synthetic /
  real-history split, difficulty distribution, sanitize verdict).
- `benchmarks/run.ts replay` - the OLD-vs-NEW supervision replay bench (interface tokens, false
  wakes, missed-relevant, ADOPT/REJECT verdict).
- `sbin/fm-context-weight` - total estimated context tokens plus a stable hash of the per-file
  weight table, so a milestone also tracks the always-on context budget over time.
- `tests/*.test.sh` - the behavior-suite pass/fail/assertion counts (the same set CI runs in its
  `for test_script in tests/*.test.sh` loop). The tool's own test file is excluded from this stage
  by name (`fm-milestone*.test.sh`) - otherwise it would invoke itself from inside its own
  measurement.
- `benchmarks/action-bench/milestone-ledger.ts`'s `macroFor` - reused verbatim (not re-derived) to
  populate `models[]` when one or more live action-bench `runs.json` artifacts are passed as extra
  positional args, exactly mirroring a0e86b0's per-model control/harness macro row.
- repo invariants - the CLAUDE.md/`.claude/skills` symlink contract plus "no fleet-private path
  (`data`/`state`/`config`/`projects`) is tracked", absorbed from the now-retired
  `benchmarks/eval-runner/fm-eval-run.py` gate of the same name (see "Consolidation" below).

Nothing here re-implements a gate. `benchmarks/milestone/run.ts` is glue: it shells to each real
instrument, times each stage, and appends one row.

## Usage

```
sbin/fm milestone <label> [sha] [runs.json ...] [--note text] [--out dir] [--captured iso8601] [--jobs n]
sbin/fm milestone --compare <shaA> <shaB> [label]
```

- `sha` defaults to `git rev-parse HEAD`. Pass it explicitly when determinism matters (e.g. a CI
  job re-measuring a specific commit) rather than relying on whatever happens to be checked out.
- `--captured` overrides the generated timestamp; pass a fixed value to reproduce a row exactly
  (see below).
- `--jobs` bounds the `tests/*.test.sh` worker pool (default 4).
- `FM_MILESTONE_NOTE` (or `--note`) attaches free-text context to the row, matching the existing
  action-bench ledger's env var.
- `FM_MILESTONE_TESTS_ONLY` restricts the tests stage to file names matching a regex - useful for a
  fast smoke run; a real milestone measures the full suite.

Every invocation appends one line to `benchmarks/action-bench/results/milestones.jsonl` and one section to
`benchmarks/action-bench/results/milestones.md`. Re-running with identical inputs (same sha, same `--captured`,
same repo state) reproduces an identical row **except** the `captured` field (when left to default)
and every per-stage `secs` / top-level `elapsed_s` field - those measure real subprocess wall time
and can never be bit-identical across two separate invocations on a real machine. Every other field
- gate verdicts, counts, token totals, hashes - is byte-identical.

## Row schema

A **superset** of a0e86b0's `MilestoneRecord`: `captured` / `milestone` / `sha` /
`corpus_scenarios` / `trials` / `note` / `models` keep their exact field names and meaning, so a
row written under the old (action-bench-only) schema is still a valid instance of this one with the
new sections simply absent - historical seeding stays compatible in both directions.

```jsonc
{
  "schema": "fm-milestone/v1",
  "captured": "2026-07-17T08:14:30.425000+00:00",
  "milestone": "post-rebase-v2",
  "sha": "ea92c1cec686df22b28b87765219a1b227eaa13a",
  "corpus_scenarios": 31,
  "trials": null,              // populated only when --runs runs.json[] are supplied
  "note": "",
  "models": [],                 // ModelMacro[] from action-bench/milestone-ledger.ts, verbatim
  "gates": {
    "action_bench": { "ok": true, "scenarios": 31, "secs": 0.7 },
    "corpus": {
      "ok": true, "total": 31, "synthetic": 26, "real_history": 5,
      "by_source_class": { "backlog-done": 2, "state-status": 1, "session-history": 2 },
      "by_difficulty": { "easy": 6, "medium": 12, "hard": 4, "aspirational": 9 },
      "sanitize_status": "clean", "secs": 0.1
    },
    "supervision": {
      "ok": true, "verdict": "ADOPT NEW", "tokenizer": "chars/4",
      "totals": { "old_tokens": 1111, "new_tokens": 443, "old_false": 8, "new_false": 1, "old_missed": 1, "new_missed": 0 },
      "reduction_pct": 60.1, "secs": 0.1
    },
    "tests": { "ok": true, "files": 44, "passed": 44, "failed": 0, "failures": [], "assertions": 512, "secs": 78.2 },
    "repo_invariants": { "ok": true, "claude_md": "AGENTS.md", "claude_skills": "../.agents/skills", "tracked_private": "none", "secs": 0.1 }
  },
  "context_weight": { "ok": true, "total_tokens": 27902, "tokenizer": "chars/4", "table_hash": "2d4b7e0d6194c005", "secs": 0.1 },
  "elapsed_s": 91.9
}
```

## `--compare <shaA> <shaB>`: the auto-A/B hook

`--compare` runs the exact same measurement pipeline against two isolated snapshots (`git archive
<sha> | tar -x` into an ephemeral temp dir - no `.git`, no worktree registration, self-cleaning) and
appends both rows to the ledger under `<label>-baseline` / `<label>-candidate`, then prints a delta
table. This is the intended shape for auto-A/B on any harness change: land the change, run
`sbin/fm milestone --compare <base-sha> <candidate-sha>`, and read the delta on the same gates
every milestone already tracks - no bespoke comparison logic per change. Pass `--out dir` to redirect
both rows away from the durable ledger (used by the test suite); omit it for a real comparison.

`git archive` was measured against a persistent per-slot clone-and-reuse cache (the mechanism the
now-retired `benchmarks/eval-runner` used) and kept deliberately: archive finishes in ~0.03s here
against ~2.3s for a bare `git clone` alone, and needs no clone step at all since `REPO_ROOT` is
already a full local checkout. The persistent cache earns its complexity only when amortizing
repeated clones of *remote* refs across many separate invocations - not this tool's shape, two SHAs
already in local history, measured once per `--compare` call. See the comment above
`archiveSnapshot()` in `run.ts` for the full evaluation.

## Layout

```
run.ts    the composition CLI: stage runners (action-bench gates/corpus, supervision replay,
          context-weight, tests), the row schema + jsonl/md append, and --compare
README.md this file
```

`benchmarks/action-bench/results/` (the canonical, plum-history-seeded ledger) holds the
durable `milestones.{jsonl,md}` this tool writes - distinct from action-bench's own per-model ledger
because this one composes multiple benchmarks, not action-bench alone.

## Consolidation

`benchmarks/eval-runner/fm-eval-run.py`, a separately-promoted multi-SHA gate runner, landed the
same day as this tool and duplicated its A/B mission. It has been retired: `--compare` is now the
one canonical SHA-vs-SHA surface, its `repo_invariants` gate was absorbed above, and its
`sbin/fm-eval-run.sh` wrapper and test are deleted. `benchmarks/eval-runner/crew-metrics.py` (a
distinct, unrelated passive-metrics tool) and its shared `fm_paths.py` helper remain in that
directory under `sbin/fm crew-metrics`.
