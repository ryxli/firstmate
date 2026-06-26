---
name: afk
description: Enter away-mode supervision. Use when the user invokes /afk (e.g. "/afk", "/afk back in an hour", "going afk"). Sets a durable away-mode flag so the in-process supervision extension batches captain-relevant events into one digest instead of waking per event, cutting token cost during walk-away stretches. Exit is automatic; any real message returns to full per-event responsiveness.
user-invocable: true
---

# afk

Away-mode supervision. Supervision already runs as an in-process omp extension
(`.omp/extensions/fm-supervisor.ts`) that wakes the first mate on each
captain-relevant fleet event. `/afk` flips that extension into a batched mode:
while you are away it coalesces relevant events over a window and injects ONE
combined digest instead of one wake per event. The tradeoff is consented and
explicit - you are stepping away, so fewer, batched interruptions are better.

## What it does

1. **Set the durable away-mode flag:**
   ```sh
   date '+%s' > state/.afk
   ```
   The supervision extension checks for this flag; while it exists, relevant
   events are buffered up to `FM_ESCALATE_BATCH_SECS` (default 90s) and flushed
   as one digest. The file survives a restart: recovery keeps afk active if the
   flag is present (the extension reloads with the session and honors it).

2. **Acknowledge** to the captain that away-mode is active: relevant events will
   arrive as one batched digest, and any real message brings you back.

There is no separate daemon to start, no watcher to manage, and no sentinel
marker: the extension lives in this session and `pi.sendMessage` owns delivery
timing, so a batched digest never collides with a half-typed line.

## How to exit afk

No `/back` is needed. The next genuine captain message is the return signal:

- A normal captain message -> the captain is back. Clear the flag
  (`rm -f state/.afk`), give one distilled "while you were out" catch-up
  (what landed, what needs them), and resume full per-event responsiveness.
- Re-invoking `/afk` while already away -> stay afk (refresh the flag); not an exit.

Bias ambiguous cases toward exit: a present captain beats token savings, and a
false exit is self-correcting (the captain re-runs `/afk`).

## Orthogonal to approval authority

afk changes how aggressively firstmate surfaces events, **not who approves
what**. "Away" never means "approves more." A PR ready for merge, a
needs-decision finding, or anything destructive still waits for the captain's
explicit word - afk only batches the notification.
