---
name: fm-away-mode
description: Away-mode batching.
user-invocable: true
---

# fm-away-mode

Away mode batches presence; it grants no authority and dispatches no new work.
`fm afk` owns flag and digest state; never edit `state/.afk`.
Use `fm afk enter` for `/afk` or cap departure, `fm afk status` to inspect, and `fm afk exit` on return.
Exit shows digest and clears the flag only after cleanup; failure keeps away mode active.
While away, supervise in-flight work and batch idle closeouts with `fm idle-digest begin`.
Do not start queued work because the cap is away; only lifecycle-authorized dispatch proceeds.
PR merge, needs-decision, destructive, irreversible, and security-sensitive actions still wait unless already authorized.
`/afk` refreshes; other real cap messages exit, and ambiguity biases exit.
