---
name: fm-diagnose-startup-fault
description: >-
  Diagnoses structured fm start / preflight failures. Use only when startup
  reports a flagged failure - never on healthy start.
---

# fm-diagnose-startup-fault

`fm start` already ran bootstrap, identity checks, home repair when needed, Lavish recovery, and one fleet snapshot before the model launched.
Do not repeat successful preflight.

## When this skill applies

Only when startup prints a structured failure (JSON `fm start preflight failed: …` or an equivalent flagged step/reason).
Healthy start → do nothing from this skill.

## Procedure

1. Consume the failure: note `step`, `command`, `status`, and `reason`.
2. Run the one named diagnostic that matches that component (for example `fm bootstrap`, `fm identity-migrate check`, `fm home check --all`, `fm lavish-open --recover`, `fm fleet --check`).
3. Repair only the flagged component (cap consent required for installs).
4. Rerun `fm start`.
5. Stop. Never sweep unrelated homes, panes, or registries after a clean start.

## Result classes

- Blocking tool/auth missing → list install commands, wait for cap consent, then `fm bootstrap install …`.
- Identity UNRESOLVED → resolve via `fm identity-migrate` only for flagged homes.
- Home link drift → `fm home repair` only for observed drift.
- Lavish steward missing → `fm lavish-open --recover`.
- Fleet snapshot unparseable or check red → fix the named exception, then refresh with `fm fleet`.
