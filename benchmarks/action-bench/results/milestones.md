# action-bench milestone ledger

Macro progress across milestones (run at milestone cadence, not continuously). Each row is one model at one milestone: control -> harness overall correctness, the harness lift, and total corrupt-success. Correctness is calibrated-tier-weighted; a rising lift or a widening gap on the hard tiers is the signal to watch.

## pre-rebase-baseline  (`50ade91`, 2026-07-02, 19 scenarios, trials 5)

| model | control | harness | lift | corrupt |
|---|---|---|---|---|
| `gpt-5.4-mini` | 0.937 | 0.947 | +0.010 | 0 |
| `claude-sonnet-4-5` | 0.968 | 1.0 | +0.032 | 0 |
| `claude-haiku-4-5` | 0.947 | 0.947 | +0.000 | 0 |

_Pre-rebase baseline (19-scenario tri-model full run). Corpus since grown to 28 incl. hard + long-horizon scenarios, validated via per-scenario probes; the long-horizon substrate is the headroom lever (gpt harness lift 0.0->0.5 on the 10-session hard variant). Next milestone (post-rebase) runs the full 28 via ./milestone.sh._

## post-reconciliation  (`2a59d55`, 2026-07-05, 28 scenarios, trials 3)

| model | control | harness | lift | corrupt |
|---|---|---|---|---|
| `claude-sonnet-4-5` | 0.988 | 1.0 | +0.012 | 0 |
| `claude-haiku-4-5` | 0.929 | 0.952 | +0.023 | 0 |

_Post-reconciliation full 28-scenario run on canonical herdr 2a59d55 (reconciliation #24-#27). gpt-5.4-mini arm credential-blocked (azure provider unkeyed in env) - Sonnet+Haiku only. Corpus grew 19->28 since milestone #1 and action-bench --sha is a label (SHA-independent), so vs #1 this reflects corpus+model, NOT a controlled reconciliation delta; the controlled reconciliation delta is the deterministic substrate (behavior +34 assert/+3 files, +6 shellcheck, supervision -50.9% stable, zero regressions)._

