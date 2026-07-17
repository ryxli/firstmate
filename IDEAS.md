# Ideas (tiny slices)

## Principle: fight context accretion (reduce, don't only add)
A running demon across harnesses: prompts, charters, AGENTS.md, skills, and steering only ever grow. Every lesson/guard/rule is ADDED; nobody runs the reverse pass. Adding is safe and local; removing needs judgment, so the gradient always points at accretion. Bloat never errors - it silently taxes every turn and buries the signal that matters. Treat unchecked growth as a defect and make REDUCTION a deliberate, recurring discipline.
Reduction ships as independent, self-contained micro-cuts rather than one sweeping redesign of the ship.
Think big about the principle; land it in crumbs.
Tiny slices under this principle:
- context-weight reporter - one command that prints the token weight of the always-on context (AGENTS.md + charters + always-loaded skills). Read-only, no behavior change. Makes reduction measurable ("X -> Y") instead of vibes. This is the enabling first cut; everything else builds on being able to see the number.
- per-section weight breakdown - extend the reporter to attribute weight per file/section, so the heaviest accretion is obvious to target. Still read-only.
- one-cut-at-a-time convention - a short note in AGENTS.md that a reduction PR must be a single self-contained cut with the before/after weight delta in its body, never bundled. Pure docs; keeps peer merges clean.
