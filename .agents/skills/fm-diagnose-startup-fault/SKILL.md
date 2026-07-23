---
name: fm-diagnose-startup-fault
description: Diagnose startup faults.
---

# fm-diagnose-startup-fault

Use only for structured startup failure, such as `fm start preflight failed` JSON or flagged step/reason.
Healthy start already ran preflight; do not repeat it.
Record `step`, `command`, `status`, and `reason`.
Run the owning `fm` diagnostic, repair only the verified cause, and rerun `fm start`.
Cap consent is required before installs or authority expansion.
On clean start, stop and do not sweep unrelated homes, panes, or registries.
If the same fault remains, escalate the verified cause and failing `fm` surface.
