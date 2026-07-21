---
name: workflow-codification-matrix
description: "Decide whether workflow knowledge belongs in a tool/wrapper, lazy skill, role-scoped brief, enforced gate, background job, or tiny always-on rule."
---

# Workflow codification matrix

Use when deciding how to make tool, cluster, or harness workflows second-nature without bloating every agent startup.

## Core rule

Match the mechanism to **breadth of need × cost of not knowing × enforcement requirement × attention cost**.

- Broad and repetitive with no judgment -> tool/wrapper.
- Relevant only for some tasks -> lazy skill.
- Specific to a role or spawned job -> generated brief/charter.
- Needs enforcement, not advice -> the owning pipeline/tool must implement it.
- Long-running or wait-heavy -> background job or delegated worker, never foreground babysitting in the main session.
- Tiny safety invariant with high failure cost -> always-on scoped nudge.
- Large reference manual -> never global startup injection.

## Main-session responsiveness rule

Keel/main firstmate is the routing layer.

It should stay responsive for intake and decisions.

Do not hold the main session on:

- Lavish polling;
- no-mistakes gates;
- long reviews;
- artifact editing loops;
- multi-minute builds or validation loops.

Use one of these instead:

- background the long poll or validation loop;
- delegate the artifact/review/editing work to a worker;
- if main temporarily takes over validation, explicitly park the worker, record ownership state, and immediately return to intake mode;
- report back only for a real decision, a completed result, or a blocker.

## Enforcement rule

Do not put gate-decision policy in generated briefs as the primary fix.

Briefs are CLAUDE.md-class advice: useful context, but no enforcement layer.

For no-mistakes, auto-fix-or-escalate policy belongs in the no-mistakes pipeline itself:

- routine infra/code-quality fixes -> apply automatically;
- same-invariant fixes in sibling paths -> apply automatically with scoped intent;
- product behavior, security, destructive action, or scope expansion -> escalate.

Firstmate may record ownership state and park workers when it temporarily drives validation, but the durable fix is the gate starting and enforcing policy correctly.

## Mechanism table

| Kind | Put it in | Examples | Why |
|---|---|---|---|
| Pure boilerplate | Tool/wrapper | `herdr pane read --source recent-unwrapped`; atomic `herdr pane run`; `./sync.sh -n gb200-control-3` | Removes work for callers and costs nothing for non-callers. |
| Reference knowledge | Pull-on-demand skill | Cluster map; multi-arch traps; nested remote herdr; GPU container details | Essential when relevant, noisy when global. |
| Role-specific procedure | Spawn brief or charter | GPU-runner manual; edit-only crewmate constraints; report-back target | Prevents the wrong agent from learning dangerous or irrelevant procedures. |
| Enforced policy | Owning tool/pipeline | no-mistakes gate decision policy; PR body current-intent validation; linked-worktree run startup | Advice can be ignored; enforcement belongs where the action happens. |
| Wait-heavy process | Background job or delegated worker | Lavish poll; no-mistakes gate; long review; artifact iteration | Keeps Keel/main responsive as the router. |
| Safety invariant | Tiny always-on rule scoped by cwd/role | Do not edit shared canonical checkout from multiple agents; one serialized sync/GPU lane | Failure is expensive enough to justify presence. |
| Runtime identity | Harness/herdr metadata + generated brief context | supervisor name, parent chain, visible label, domain workspace | Gives every agent orientation without relying on opaque task ids. |

## Schwarzwald/herdr examples

- `gpu run "<cmd>"` and `gpu read` should be wrappers, not remembered command recipes.
- The sync node should be a repo-level default, not manually typed each time.
- `herdr pane run` is the default for raw shell input because it is atomic text+Enter.
- `send-text` plus separate `send-keys Enter` is fragile and should be avoided for raw shells.
- `herdr pane read --source recent-unwrapped` should be the default for readable pane output.
- The cluster map belongs in a role-scoped skill, not in every startup.
- The GPU-control manual belongs only in the GPU-lane crewmate brief, not in edit-only crewmate briefs.
- The no-mistakes linked-worktree startup bug belongs in no-mistakes, not in firstmate prompt workarounds.

## Checklist before adding startup context

1. Will almost every agent need this today?
2. Is the cost of not knowing it high enough to justify global context?
3. Does the behavior need enforcement rather than advice?
4. Will this wait on an external process or user feedback?
5. Can a wrapper remove the need to know it entirely?
6. Can a lazy skill make it available only when relevant?
7. Can the spawn brief attach it only to the role that needs it?

If the answer to 3 is yes, patch the tool or pipeline that owns the action.

If the answer to 4 is yes, background it or delegate it so main stays responsive.

If the answer to 5, 6, or 7 is yes, do that instead of startup injection.
