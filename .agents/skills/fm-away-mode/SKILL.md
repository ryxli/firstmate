---
name: fm-away-mode
description: >-
  Enters or exits away-mode batching. Use when the cap invokes /afk, goes away,
  or returns while away-mode is active.
user-invocable: true
---

# fm-away-mode

Away mode is presence-gated and never the default.
It changes notification batching, not approval authority.
PR merge, needs-decision, destructive, irreversible, and security-sensitive actions still wait for the cap unless existing policy already grants authority.

## Command

```sh
fm afk enter    # set flag; resume idle-digest if present
fm afk exit     # screen digest; clear flag only after digest cleanup succeeds
fm afk status
```

`fm afk` owns ordered flag and idle-digest resume/cleanup; a failed exit retains away mode rather than leaving half-exited digest state.
Do not hand-edit `state/.afk`.

## While away

When firstmate would idle with work in flight, use `fm idle-digest begin` instead of a trickle of closeouts.
Bounds: `FM_IDLE_DIGEST_WINDOW_SECS` (default 1800), `FM_IDLE_DIGEST_MAX_PASSES` (default 12).
The supervision extension batches relevant events over `FM_ESCALATE_BATCH_SECS` (default 90) while the flag is set.

## Exit cues

A message beginning with `/afk` refreshes away mode and does not exit it.
Any other real cap message ends away mode; bias ambiguity toward exit.
On return run `fm afk exit` (shows the digest when present, then clears away mode only after cleanup succeeds).
