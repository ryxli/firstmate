# action-bench milestone ledger

Macro progress across milestones (run at milestone cadence, not continuously). Each row is one model at one milestone: control -> harness overall correctness, the harness lift, and total corrupt-success. Correctness is calibrated-tier-weighted; a rising lift or a widening gap on the hard tiers is the signal to watch.

## pre-rebase-baseline  (`50ade91`, 2026-07-02, 19 scenarios, trials 5)

| model | control | harness | lift | corrupt |
|---|---|---|---|---|
| `gpt-5.4-mini` | 0.937 | 0.947 | +0.010 | 0 |
| `claude-sonnet-4-5` | 0.968 | 1.0 | +0.032 | 0 |
| `claude-haiku-4-5` | 0.947 | 0.947 | +0.000 | 0 |

_Pre-rebase baseline (19-scenario tri-model full run). Corpus since grown to 28 incl. hard + long-horizon scenarios, validated via per-scenario probes; the long-horizon substrate is the headroom lever (gpt harness lift 0.0->0.5 on the 10-session hard variant). Next milestone (post-rebase) runs the full 28 via ./milestone.sh._

