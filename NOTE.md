# herdr/main convergence plan

The two directions:

## Direction 1 - main <- herdr (this ship absorbs)

- fresh two-way divergence audit against today's main
- port herdr-unique load-bearing clusters in slices, tests green per slice
- anything superseded by what we shipped this week gets dropped with evidence, not merged

## Direction 2 - herdr <- main, then cutover (the other ship converges)

- the other ship can't be yanked off its branch mid-operation - it's a live fleet
- once main provably contains everything the other ship's line depends on (parity checklist, not vibes), the cutover is the cheap step: fast-forward-style switch at an idle boundary, tracked files only - its data/, state/, backlog are untracked and survive untouched, its own recovery reconciles on restart
- one full session cycle on main there, then the herdr branch retires

## The rule that prevents this recurring

Anything genuinely per-ship we find during the audit (paths, host quirks, workspace ids) moves into config or a local file - never back into a branch.
Branch divergence between ships is the disease we're curing, so nothing may re-create it.

## Sequencing

SpawnGuardFixes lands first (it's inside two conflict-center files right now), then the audit slice kicks off.
The cluster keep/drop map goes to the captain for one-glance approval before any porting starts, and the parity checklist before any cutover touches the other ship.
