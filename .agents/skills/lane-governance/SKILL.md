---
name: lane-governance
description: Use when supervising spawned lanes (crewmate, secondmate, tan) - whiteboard contract, peer bus, turn decision sections, and review safeguards.
---

# Lane governance

Whiteboard contract, peer bus, turn decision sections, and review safeguards for every spawned lane (crewmate, secondmate, tan) and firstmate's own turn structure.
Demand-load from `skill://firstmate-task-lifecycle` or when supervising parallel lanes.

### Whiteboard operator-view contract

Every whiteboard begins with a cap-first band, before any agent detail; the board is not compliant without it.

```
## OPERATOR VIEW
🟢|🟡|🔴|🔵 <one plain-language line per active lane>   (hard cap: 8 lines)
⚠ Needs cap: <decision or "nothing">
→ For supervisor: <handoff/ask or "nothing">
```

Rules for the operator view: plain language a non-reader can skim in ten seconds; one status glyph per line (🟢 healthy, 🟡 degraded/waiting, 🔴 broken/blocked, 🔵 in progress); no commit SHAs, file paths, or links unless a pending decision needs one; the "Needs cap" and "For supervisor" lines are mandatory even when the answer is "nothing".
Everything below the operator view (Working / Evidence / Preserved / Reply sections, SHAs, evidence chains, exclusion rules) remains unconstrained agent detail - move precision down there, never delete it.
The operator view is a verified deliverable: supervisors check it for presence, currency, and the line cap on their ticks and steer when it degrades, the same way artifact claims are verified.
It is still self-report - supervisors read it as "what the agent believes" and keep trust-but-verify checks on anything load-bearing.

Failure: board safety claims outlived their evidence.
Root cause: the board recorded a conclusion without the contemporaneous command that produced it.
Prevention: every board claim that says reconcile clean, no divergence, armed safe, restored, or equivalent must name a timestamped evidence line below the operator view with the exact read-only command that produced it, for example `curl -fsS "$STATUS_URL" | jq '{reconcile_seq,divergences,halt_causes}'`.


### Peer bus discipline

This extends the secondmate charter's fleet-peer-bus escalation rule above.
`done`, `blocked`, `needs-decision`, `failed`, and a material phase change are cap-relevant outcomes; the whiteboard records their state for the fleet.
The fleet peer bus is not a second state channel.
It carries only the action needed when a board update cannot itself cause the recipient to act.

Send only:

1. A handoff naming the artifact and the action required from the recipient.
2. A blocking question that the recipient alone can answer.
3. A safety interrupt requiring immediate intervention.

`peer_send`/`peer_pull` are canonical for mate-to-mate and secondmate escalation; `sbin/fm send` stays canonical for pane-local steering, interrupts, startup nudges, and explicit composer delivery; never substitute IRC for fleet peer-bus messages.
Do not send acknowledgements, delivery receipts, routine status echoes, or FYI progress.
The recipient's next board update is the receipt.
Before every send, ask: **does this change what the peer does in their next step?**
If no, put the fact on the whiteboard or drop it.
Never resend a fact already sent or already recorded on the board.

### Turn decision sections

A crew agent's turn is a finite sequence of decision sections.
Every section has an explicit legal-move set.
No section has a silent or null move: when no listed move obviously applies, the named fallback move for that section is still the legal move to take.

1. **Wake** - what triggered this turn: a steer, a scheduled tick, a subagent return, or nothing?
   Name the trigger before acting on it.
   An unnamed trigger is not a legal starting state.
2. **Read state** - read the board, the Working list, and every in-flight lane.
   Note what changed since the last turn before deciding anything.
   Acting on stale memory instead of a fresh read is not a legal move.
   After a compaction or interruption, take ONE aggregated state snapshot, reconcile it once, and refill all free slots before reading any additional context.
   Iterative re-reading to rebuild context while slots sit empty is not a legal move.
3. **Consume** - process every queued message before anything else.
   Legal moves are: act on a message now, or explicitly defer it with a reason recorded on the board.
   Waiting instead of draining the queue first is not a legal move.
   That default caused a real deadlock: an agent parked in a wait-loop never drains the very message it is waiting for.
4. **Select** - given the Working list, the blocked set, and the operator-view AMBERs, choose what to act on now.
   There is always a legal move: execute the next unblocked item, convert a blocked item's unblock condition into a task, refill from AMBERs, or emit an explicit "queue empty, requesting work" board state.
   Silent parking with unblocked work still on the list is never a legal move.
   After every tool result, subagent message, or job completion, consume all settled results and immediately execute the next safe calculated unblocked action; a settled job invalidates any wait that depended on it.
   `I can`, `we could`, `next action`, and `while waiting` are not legal stopping points while authorized work remains.
   A pending peer review verdict on a submitted deliverable blocks only that deliverable's item; it never blocks the rest of the queue.
   While any verdict is pending, treat it as a Schedule wake condition and select the next file-disjoint unblocked item as usual.
   Before declaring the queue empty, re-test each blocked item's unblock condition against current reality (e.g. the awaited commit may already exist on main); a stale "blocked" label is not evidence.
5. **Execute vs delegate** - decide inline execution versus spawning a lane by cost and blast radius, not by default habit.
   A high-blast-radius step (money path, state corruption risk) delegates to a named lane or reviewer.
   A small, low-cost, low-risk step executes inline.
   Before any multi-command diagnostic sequence, name the exact predicate and choose the highest-level command that directly returns it.
   Decompose only when that command is unavailable or insufficient; stop once the predicate and required artifact contract are satisfied.
   Before presenting options, identify which uncertainty is empirically testable; run the smallest reversible isolated experiment that can collapse it, then present only the surviving tradeoffs.
   Delegation carries no callback guarantee: a crewmate lane can die or park silently, so every delegated lane gets a named deadline at spawn time.
   Each bounded self-recheck in the Schedule step below must verify delegated-lane LIVENESS (evidence of progress: output growth, artifact delta, lane status), not just unblock conditions.
   A lane silent past its deadline is not "still working": restart it, reclaim the work inline, or report the stall on the board - waiting longer is not a legal move.
   Deferring a spawn to "next turn" is illegal when nothing is named to cause that turn: spawn accepted-handoff lanes in the SAME turn as the acceptance, or name the exact wake that will perform the spawn.
   Maximize wall-clock throughput: when independent critical-path items exist and worker slots are free, spawn them in parallel in the same turn - design acceptance, test coverage, breaker repair, push/deploy, and live verification parallelize wherever dependencies permit.
   Review dispatches against the LOCAL commit the moment it exists; waiting for push, deployment, or an author-assembled evidence bundle before dispatching review is not a legal move (evidence folds into the open review asynchronously).
   Expand capacity through `/tan` before queueing: whenever an independent, dispatch-ready slice exists and your attention - not executable work - is the bottleneck, request a `/tan` for it instead of serializing it behind current work.
   Mechanics: `/tan` is a pane command that only the supervisor (or cap) can type and submit into your pane - you cannot self-spawn one; publish a "tan requested: <bounded slice>" board line and the supervisor executes the spawn.
   Every tan directive carries a bounded board slice, exact file ownership, dependencies, prohibited files/surfaces, validation requirements, and a terminal-report format; tans announce file claims before editing, report terminal deltas to their parent only, and never rescan or claim the full backlog.
6. **Report** - every turn ends with a board delta and a named artifact path, always.
   A claim with no named artifact is this section's failure mode.
   Lane reports are terminal events, not polling narration: one report per lane completion carrying commit SHA, tests run, verdict, and blocker.
   Repeated progress polling and unscoped "different perspective" re-reads of settled work are not legal reporting moves.
   Before handing any deliverable to a review gate, self-check it row by row against the gate's published criteria (the reviewer's frozen matrix or correction contract) and attach that self-check to the handoff.
   A deliverable submitted without the self-check wastes a full review round on gaps the author could have caught.
   The board write is a turn-exit guard, not a judgment call: EVERY turn exit writes the whiteboard before ending - including wait-entry, parking, empty polls, race-lost peer pulls, trivial acknowledgements, system-notice handling, and tool-error/retry exits.
   "No new state" is itself state: when nothing changed, update a single "Last turn" line (timestamp, wake cause, one-word outcome, what you are waiting on) rather than skipping the write.
   `whiteboard_checkpoint` never substitutes for the write; write the board first, checkpoint after.
   The checkable invariant is that the board mtime advances on every turn; a pane turn that ends without a board write is a section-6 incident by definition.
   Board writes are monotonic: append or supersede with timestamped current state, preserve prior accepted decisions and evidence references, and never delete a missed or failed state without a superseding line.
   See "Whiteboard operator-view contract" and "Peer bus discipline" above for the artifact and handoff shape this must take.
7. **Schedule** - name what wakes you next: a tick, a specific message, or an unblock condition.
   Ending a turn with nothing named to wake it is not a legal move.
   Parking on external blocks is bounded, never open-ended: a parked turn names a self-recheck interval of at most 10 minutes, and each recheck re-tests every blocked item's unblock condition against current reality.
   If idleness persists past one recheck while any queue anywhere is non-empty (own queue, the cap's stated priorities, docs/PLAN.md backlog), the next turn MUST either pull new work from it or write an explicit escalating work request addressed to the cap on the board.
   When a named lane or self-recheck deadline is missed, the next board write says `missed <deadline>: <cause>; next <action/time>` before any further waiting.
   Waiting more than ~10 minutes with nothing in flight and no work request on the board is a section-7 incident.


#### Review and evidence safeguards

- **Cure-condition guard:** Every verdict delivery MUST check named cure conditions against authoritative current state.
  When every named cure condition holds, suppress the old event, return the item to an independent fresh review, and deliver only that review's event.
- **Terminal events:** A terminal event is a same-turn obligation: read its named artifact, take its lifecycle action, and write the resulting board state before any unrelated inspection.
  Check: a terminal report with a present artifact must produce a named disposition or explicit escalation in that same turn.
- **Evidence blockers:** Before recording an evidence blocker, enumerate and try every read-only authoritative path named by state, status, reports, session artifacts, source, and peer handoffs.
  Check: the blocker record names each attempted path and its observed result; otherwise it is not a legal blocker.
- **Large evidence:** Mirror large command output, reports, matrices, and browser captures to named artifacts at production time; consume them through bounded range reads and cite paths plus ranges in communications.
  Check: if a review needs bulk pasted output or a context recovery, stop, persist the artifact, and resume from that artifact rather than carrying the bulk forward.
- **Repeated criteria:** Every first rejection publishes criterion IDs, required proof, and named cures in a machine-checkable matrix.
  Check: every correction handoff attaches a row-by-row self-check against that exact matrix; a missing self-check is rejected before review.

#### Review practices to preserve

- Reject only concrete, evidenced defects rather than inventing a gate.
- Keep rejection reports narrow and procedural: name the failed criterion, the evidence, and the exact cure without expanding scope.
- Keep nonconforming verdict deliveries non-admitting. Producer, event, artifact, SHA, and consumer provenance are part of a verdict contract, not optional metadata.
