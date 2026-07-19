---
name: afk
description: Enter or exit away-mode supervision. Use when the user invokes /afk, says they are going away, or returns while state/.afk exists.
user-invocable: true
---

# Away-mode supervision

Away mode is presence-gated and never the default.
It changes notification batching, not approval authority.
A PR merge, needs-decision finding, destructive action, irreversible action, or security-sensitive action still waits for the cap unless existing policy already grants that authority.

## Enter

1. Set the durable flag:

```sh
date '+%s' > state/.afk
```

2. Confirm that away mode is active.
The in-process supervision extension observes the flag and retains relevant events as durable fleet attention over `FM_ESCALATE_BATCH_SECS`, default 90 seconds, without interrupting the cap per event.
There is no separate daemon, sentinel marker, watcher, wake queue, or busy guard to start.
When away mode is absent, a relevant burst produces one non-visible `fleet-attention-changed` edge; firstmate reads `fm fleet` once for its details.

3. If `state/.idle-digest.md` already exists after a restart, resume it with:

```sh
sbin/fm idle-digest begin
```

## While the cap is away

When firstmate would otherwise go idle and work remains in flight, use the bounded idle-digest loop instead of emitting a trickle of small closeouts.
The helper consolidates updates in `state/.idle-digest.md` and permits only safe, read-only firstmate-side refinement.
The hard bounds are `FM_IDLE_DIGEST_WINDOW_SECS`, default 1800 seconds, and `FM_IDLE_DIGEST_MAX_PASSES`, default 12.

```sh
sbin/fm idle-digest begin
```

Keep approval boundaries unchanged.

## Exit

A message beginning with `/afk` refreshes away mode and does not exit it.
Any other real cap message ends away mode.
Bias ambiguity toward exit because a present cap beats token savings.

On return:

1. If `state/.idle-digest.md` exists, show the consolidated catch-up:

```sh
if [ -f state/.idle-digest.md ]; then
  sbin/fm idle-digest screen
fi
```

2. Relay the useful delta when a digest was shown.
3. If `state/.idle-digest.md` exists, clear the digest:

```sh
if [ -f state/.idle-digest.md ]; then
  sbin/fm idle-digest clear
fi
```

4. Always clear the away flag, even when no idle digest was created:

```sh
rm -f state/.afk
```

Silent attention-edge supervision resumes automatically when the flag is absent.
