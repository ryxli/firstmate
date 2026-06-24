---
name: lavish-fast
description: "Build Lavish review artifacts fast by copying a prebuilt HTML template and filling only the content - skip regenerating CDN/theme/overflow/JS boilerplate. Use whenever you are about to make ANY lavish-axi artifact (plan, comparison, table, report, decision/input surface, diagram)."
---

# lavish-fast

Building a Lavish artifact should be **content work, not boilerplate work**. A prebuilt template hard-codes everything trivial; you fill only the parts that carry meaning.

## The fast path (use this every time)

1. **Copy the template** into the subject project's `.lavish/` dir:
   `cp ~/code/firstmate/.agents/skills/lavish-fast/template.html <subject-project>/.lavish/<name>.html`
   The template lives at `.agents/skills/lavish-fast/template.html` inside the firstmate repo (typically `~/code/firstmate`), also reachable as `~/code/firstmate/.claude/skills/lavish-fast/template.html`.
2. **Fill only the `<main>` content.** The template ships a working gallery - hero, verdict callout, stat row, card, table, decision form, action button - plus a copy-paste cheatsheet in a trailing HTML comment. Swap demo text for yours; delete components you don't use.
3. **Open + poll:**
   `lavish-axi <file>` then `lavish-axi poll <file>` (run the poll in the background; leave it running - re-run if it dies; queued feedback is never lost). Reply to the user with `lavish-axi poll <file> --agent-reply "<msg>"`.
   (`lavish-axi` is installed at `~/.bun/bin/lavish-axi`; it is on PATH in standard firstmate environments.)

## What the template already bakes in - do NOT re-derive

- The exact CDN snippet (daisyui 5.5.19 + tailwindcss/browser 4.2.4 + themes), `luxury` theme, charset, viewport.
- Overflow guards: `min-width:0` on flex/grid children, `break-words`, tables inside `overflow-x-auto`, `body{overflow-x:hidden}`. (Prevents the #1 lavish bug - horizontal scroll.)
- The exact `window.lavish.queuePrompt(...)` JS for decision forms, and `data-lavish-action`/`data-lavish-prompt` for action buttons.
- The `.mono` helper for code/keys.

**So you SKIP these slow steps:** running `lavish-axi design`, fetching playbooks, hand-writing the `<head>`/theme/JS, and re-figuring overflow. The patterns are inline in the template's cheatsheet comment - read that instead of fetching playbooks.

## Rules that still apply

- **Design source priority:** (1) a look the user named; (2) the SUBJECT project's own design system if it has one - match it (inspect the project, not your cwd); (3) otherwise the template's luxury Tailwind+DaisyUI fallback. Only swap the theme/CSS for case (1) or (2); state which source you used.
- **Lead with the conclusion**, keep blocks short and scannable, semantic DaisyUI colors only.
- **Decision forms:** queue exactly once on submit (native radios just update local state; never queue per-change). Use `data-lavish-action` only on custom (non-native) feedback elements.
- **Avoid** DaisyUI `steps` for rich content (it breaks) - use the numbered `<ol>` pattern in the cheatsheet. Build flow diagrams as hand-coded nested boxes, never mermaid/JS.

## Delegating the build

When handing a Lavish build to a subagent, point it at this template path and tell it to fill content only - that keeps the boilerplate off the model entirely. Keep the *content + structure decisions* with the requester; the subagent just renders.
