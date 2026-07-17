# Runbook: autonomous-loop incident triage

Trigger: notification spam, 429s, repeated blocked wakes, and cost growth cluster together.

1. Inspect the scheduler for zero-delay or unconditional re-arms before patching prompts or per-channel configuration.
2. Stop the live loop first.
3. Enforce scheduler backoff that grows on idle or rate-limited turns and resets only after real work.
4. Validate the delay function and a no-zero-delay regression in a fresh session before clearing the fault.
5. If notification configuration is involved, inspect every live herdr server; each holds its own in-memory configuration.
