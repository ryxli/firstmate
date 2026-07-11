---
name: lavish-render-delegation
description: "Open a Lavish review artifact without tying up your own thread polling for feedback. Use whenever you (firstmate or a crewmate) are about to show the captain a Lavish artifact - plan, comparison, report, decision surface - and would otherwise run `lavish-axi poll`. A dedicated steward worker process holds the long-poll per session and relays the captain's feedback back to your pane, so your thread stays free."
---

# lavish-render-delegation

Opening a Lavish artifact must never tie up the opener's own thread on
`lavish-axi poll`. `poll` is a *blocking* long-poll: it sits silent until the
captain sends feedback or closes the session, which can be many minutes. If the
first mate runs it inline, its whole supervision loop is frozen for that whole
time; if a crewmate runs it inline, that worker is frozen instead.

The fix is a **steward**: one dedicated worker process owns the long-poll for one
Lavish session, records every feedback round to disk, and wakes the originating
agent's pane when there is something to act on. The opener gets control back
immediately. This is the standard way to open any Lavish artifact here.

## The flow (use this every time you open a Lavish artifact)

1. **Build the artifact** as usual (see the `lavish-fast` skill - copy the
   template, fill content only).

2. **Open it through the steward**, NOT through `lavish-axi` directly:
   ```sh
   sbin/fm-lavish-open.sh <file.html>
   ```
   This opens (or resumes) the session in the browser AND launches a detached
   steward that owns the long-poll. The relay target defaults to your current
   herdr pane, so feedback comes back to you. Control returns at once.
   - `--relay-pane <pane>` relays to another pane (e.g. open on a crewmate's
     behalf so its feedback reaches the crewmate, not you).
   - `--relay-pane -` records feedback to disk only, waking nobody.
   - `--no-open` resumes the server/session without relaunching the browser.

3. **Go do other work.** Do NOT run `lavish-axi poll` yourself - the steward
   owns it. Your thread is free; the steward wakes you when feedback lands.

4. **When the steward wakes your pane**, it sends one line pointing at the
   recorded feedback file (`state/lavish/<key>.feedback.md`) and the reply
   command. Read the feedback, apply the requested changes to the artifact, then
   acknowledge in the browser - non-blocking, write-only:
   ```sh
   sbin/fm-lavish-reply.sh <file.html> "<message for the captain>"
   ```
   `fm-lavish-reply.sh` POSTs to the write-only `agent-reply` endpoint and
   returns instantly; it NEVER polls, so it can never consume feedback or race
   the steward. The steward keeps the session open and relays the next round.

5. **The captain closes the session** when done. The steward's poll returns
   `ended`, the steward exits and cleans up its own state. Nothing to stop.

## Recovery

At session start / recovery, relaunch a steward for any still-open session this
home owns that lost its worker (e.g. a firstmate restart):
```sh
sbin/fm-lavish-open.sh --recover
```
It relaunches a steward only for sessions still open server-side, reaps any
orphaned poll a hard-crashed steward left behind (so exactly one poll ever owns a
session), and drops state for sessions that already ended.

## Why this matters

- **The first mate never polls Lavish on its own thread.** Its supervision loop
  stays responsive while the captain reviews at human pace.
- **Feedback is durable.** Every round is appended to
  `state/lavish/<key>.feedback.md` before the wake, so a missed wake or a crash
  never loses the captain's direction.
- **Replies can't race the poll.** The steward is the sole consumer of a
  session's feedback (via the CLI `poll`); replies are write-only HTTP. They run
  concurrently without clobbering each other.

## Pieces

- `sbin/fm-lavish-open.sh` - entry point: open/resume + launch steward; `--recover`.
- `sbin/fm-lavish-steward.sh` - the worker loop (launched detached; not run by hand).
- `sbin/fm-lavish-reply.sh` - write-only, non-blocking agent reply.
- `sbin/fm-lavish-lib.sh` - shared session-key / URL / state primitives.
- State lives under `state/lavish/` (gitignored): `<key>.steward` (worker meta),
  `<key>.feedback.md` (relayed feedback), `<key>.steward.log` (diagnostics).
