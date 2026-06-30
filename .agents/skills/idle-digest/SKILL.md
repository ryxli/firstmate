---
name: idle-digest
description: Bounded idle-digest supervision. Use when the first mate would otherwise go idle and the captain is away (the /afk flag is set, or the captain has been silent past a threshold) while crewmates are still in flight. Instead of emitting a trickle of tiny per-event idle closeouts, keep doing safe read-only refinement of background context within a bounded window and fold every update into ONE running digest, then relay a single ~one-screen consolidated summary plus pending decisions the moment the captain returns.
user-invocable: false
---

# idle-digest

The first mate's default reflex when it finishes a turn with nothing left to do
is to fall silent (section 8: "silence is correct").
That is right when the captain is present - they will speak when they need you.
It is wrong when the captain is **away** and crewmates keep finishing work:
each completion would wake you, you would emit a one-line closeout into a window
nobody is reading, and the captain returns to a wall of tiny disconnected
closeouts instead of one coherent picture.

idle-digest fixes that.
While the captain is away and there is in-flight work, you do not trickle.
You consolidate every update into ONE running digest and keep refining safe
background context inside a bounded loop, then relay a single ~one-screen
summary - with the pending decisions called out - the instant the captain
returns.

This is a sibling of `/afk`, not a replacement:

- `/afk` is the captain's **explicit** consent to step away.
  It tells the supervision extension to **batch incoming escalations** over a
  short window so fewer wakes reach you.
- idle-digest is **your output discipline** during that absence.
  It governs what you do *between* wakes and how you consolidate what you would
  otherwise say, so the captain gets one screen on return instead of a stream.

They compose: `/afk` quiets the inbound side, idle-digest quiets the outbound
side, and both leave approval authority exactly where it was.

## When the loop is allowed to run (consent + trigger)

Run the loop ONLY when BOTH hold:

1. **The captain is away.** Either `state/.afk` exists (explicit consent, the
   strong signal), OR the captain has been silent past
   `FM_IDLE_DIGEST_SILENCE_SECS` (default 600s) since their last real message
   while you have pending wakes to handle (passive absence, the weak signal).
   When in doubt, treat the captain as present and stay silent - a present
   captain beats token savings, exactly as `/afk` biases toward exit.
2. **There is live work to supervise.** At least one crewmate is in flight (a
   `state/*.meta` with a reachable pane), or a PR poll is still armed. With an
   empty fleet there is nothing to digest; go idle normally.

Consent is **safe by construction**: the loop only changes the *timing and
consolidation* of non-critical output and adds *read-only, firstmate-repo-safe*
refinement. It never changes who approves what and never takes a project
action. So it does not need a separate captain opt-in beyond the absence signal
itself - but it is bounded hard (below) precisely because it spends tokens while
the captain is not watching.

## What "safe refinement" means (scope)

Each pass through the loop may do ONLY allowlisted, reversible, firstmate-side
grooming - the work that makes your eventual digest sharper:

- Reconcile `data/backlog.md` against `state/*.meta` and `state/*.status`
  (mark what landed, advance what moved).
- Re-evaluate Queued items: dispatch only queued work whose blocker is now gone
  AND whose time/date gate has arrived (this is normal lifecycle, section 7 -
  record it in the digest as "started X while you were out").
- Refresh fleet facts you would want in the digest: PR check state, a one-line
  per-task progress read from each pane, an `omp stats --summary` cost snapshot
  when many jobs are running.
- Read project code/READMEs to deepen the context behind a finding so the
  digest explains *why*, not just *what*.
- Draft and tighten the running digest itself.

FORBIDDEN inside the loop (these always wait for the captain, away or not):

- Any write, commit, or state-changing command in a project or worktree
  (prime directive #1 - unchanged).
- Merging any PR, or any destructive / irreversible / security-sensitive action
  (prime directive #2 - unchanged).
- Spawning brand-new work the captain did not ask for, or any org-wide
  "find improvements" sweep. Refinement deepens context on EXISTING work; it
  never invents scope.
- Steering a live crewmate beyond a one-line answer its brief already supports.

## The running digest

One file, `state/.idle-digest.md` (volatile, under the gitignored `state/`),
managed entirely by `bin/fm-idle-digest.sh`. It carries a metadata header
(`started=`, `passes=`, `reason=`) so it survives a first-mate restart: recovery
finds it and resumes the same window instead of resetting (section 5).

Five canonical sections, in priority order; "Needs you" is first and is the one
the captain must never miss:

| Section            | Holds                                                        |
| ------------------ | ------------------------------------------------------------ |
| `Needs you`        | Pending decisions: PRs ready to merge, needs-decision findings, blockers awaiting the captain. Relayed verbatim, NEVER truncated. |
| `Landed`           | What completed/merged while away.                            |
| `In flight`        | What is still running, with a one-line progress read.        |
| `Queued & blocked` | What is waiting and on what; what you dispatched as blockers cleared. |
| `Fleet & cost`     | Fleet health and a cost note when unusually much is running. |

## The loop

```sh
H=bin/fm-idle-digest.sh
"$H" begin "$reason"            # idempotent; resumes an in-progress digest
while "$H" active; do           # exits the loop at the window OR the pass cap
  # ... ONE safe refinement pass (allowlist above) ...
  # fold each result the captain would care about into its section:
  "$H" fold "Landed"   "alpha PR #50 merged: fixes login redirect"
  "$H" fold "Needs you" "beta PR #61 green, awaiting your merge: <full https URL>"
  "$H" pass || break           # records the pass; breaks when budget is spent
  # then block again on the next wake; do NOT busy-spin
done
```

Per-event handling while the loop is live: when a wake arrives (a crewmate
`done:`/`blocked:`, a merged PR, a stale pane), do NOT reply to the captain.
`fold` it into the right section and, if budget remains, do one refinement pass.
An **urgent** item - anything destructive/irreversible/security-sensitive, or a
hard blocker that stops all forward progress - is the exception: fold it into
`Needs you` AND surface it immediately; do not sit on a true emergency.

## Stop conditions (the loop is bounded)

The loop ends - and you relay the consolidated digest - on the FIRST of:

1. **Captain returns.** Any real (unmarked) captain message. This is the primary
   exit and the only one that produces the digest *to a present reader*: render
   the one-screen summary (`fm-idle-digest.sh screen`), give it as your reply,
   `clear` the digest, and resume full per-event responsiveness. (If `/afk` was
   set, clearing it is the afk exit; do both.)
2. **Window elapsed** - `FM_IDLE_DIGEST_WINDOW_SECS` (default 1800s) since
   `begin`. Stop refining; the digest stays on disk, fully built, waiting for the
   captain. You go genuinely idle (no more token spend) until the next wake or
   the captain's return.
3. **Pass cap reached** - `FM_IDLE_DIGEST_MAX_PASSES` (default 12). Same as the
   window: stop refining, keep the built digest, go idle.
4. **No safe work remains** - nothing left on the allowlist to refine. Stop
   refining; keep the digest.
5. **Urgent escalation** - surface it now (above); it does not tear down the
   loop, but it does break the current refinement pass.
6. **Fleet empties** - last crewmate torn down and no armed PR poll. `clear` the
   digest (relaying first if anything is pending) and go idle normally.

After stop conditions 2-4 you are idle, NOT busy: the window/pass cap bound the
*refinement effort*, never the *delivery*. The digest is delivered only when the
captain is actually there to read it (condition 1), which is exactly what makes
it one consolidated message instead of a trickle.

## Noise bounds

- **One message per absence period.** The captain gets exactly one consolidated
  digest on return - never mid-window trickles. Between wakes, silence.
- **One screen.** `fm-idle-digest.sh screen` caps each section at
  `FM_IDLE_DIGEST_SECTION_MAX` (default 6) bullets with a
  `(+N more; full picture in data/backlog.md)` pointer - EXCEPT `Needs you`,
  which is never truncated. Pending decisions always survive the cap; routine
  history compresses.
- **Dedup.** `fold` drops exact-duplicate bullets, so repeated status churn on
  one task does not bloat the digest.
- **Bounded spend.** Window + pass cap hard-limit how much you refine while the
  captain is not watching. Tune down for cheap/quiet absences, up for long ones.

## Tunables

```sh
FM_IDLE_DIGEST_SILENCE_SECS=600    # passive-absence threshold (0 = afk-flag only)
FM_IDLE_DIGEST_WINDOW_SECS=1800    # refinement window before going idle (0 = no refinement)
FM_IDLE_DIGEST_MAX_PASSES=12       # max refinement passes (0 = no refinement)
FM_IDLE_DIGEST_SECTION_MAX=6       # per-section bullet cap on the one-screen render
```

Setting both `FM_IDLE_DIGEST_WINDOW_SECS=0` and relying on the afk-only trigger
turns idle-digest into pure consolidation with no active refinement: you still
fold every update into one digest and relay one screen on return, you just do no
background grooming. That is the most conservative useful mode.

## Orthogonal to approval authority

Like `/afk`, idle-digest changes how aggressively the first mate surfaces and
consolidates events, **not who approves what**. "Away" never means "approves
more." A PR ready to merge, a needs-decision finding, or anything destructive
still waits for the captain's explicit word - idle-digest only consolidates the
notification into one screen and uses the wait to sharpen the context behind it.
