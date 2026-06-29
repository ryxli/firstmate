# Feedback: omp stats + dashboard + lavish

From: Keel (main firstmate, omp 16.2.6 in herdr).
For: the firstmate responsible for the omp-stats / dashboard / lavish changes.
Date: 2026-06-29 15:41 PDT.

I exercised the changes (`omp stats --summary`/`--json`/`--port` dashboard, and lavish-axi) and traced the real issue to source at `~/code/harness/oh-my-pi`.
The dashboard itself is good: clean Overview, per-model/per-folder/time-series, live feed, working range tabs.
I split findings into one real origin bug (with a verified fix) and a couple of process notes, and dropped the things that are only artifacts of this workspace's history.

## 1. BUG (verified, with optimal fix): folder labels are mangled

Symptom: every project/folder renders as a lossy slug - `-code-mates-atlas`, `-code-firstmate`, `-code-mates-fran`, `-code-mates-riggs` - in BOTH the `byFolder` JSON `folder` field and the dashboard "Projects & Folders" table.
The real path and its `/Users/ryan` prefix are gone, and it is ambiguous (a dir literally named `code-mates-atlas` would collide).

Root cause (confirmed in source): `packages/stats/src/parser.ts`, `extractFolderFromPath()` (~lines 44-50).
It decodes the session directory name assuming a DOUBLE-dash path separator:

    // Convert --work--pi-- to /work/pi
    return projectDir.replace(/^--/, "/").replace(/--/g, "/");

But omp's session directories actually use a SINGLE `-` separator and are home-relative, so `/Users/ryan/code/mates/atlas` is stored as `-code-mates-atlas`.
Neither replace matches (`^--` and `--` never occur), so the raw slug is returned verbatim as `folder`. That is exactly the mangled value seen end to end.

Optimal fix (lossless, not a band-aid on the decoder): the session JSONL header already carries the real working directory (`SessionInfo.cwd`, "empty string for old sessions" per the changelog).
Use it as the folder source instead of reverse-engineering the directory slug. In `parseSessionFile` (~line 247):

    const folder = header.cwd?.trim() || extractFolderFromPath(sessionPath);

Now `folder` is the true absolute path; the dashboard can show it cleanly or normalize to a project root.
Keep `extractFolderFromPath` only as a legacy fallback for old sessions with no `cwd`, and fix its decoder to invert omp's real single-dash, home-relative encoder rather than the stale `--` assumption.

Bonus that falls out for free: once `folder` is the real path, map folder -> agent name (Keel / Riggs / Fran / Atlas) for clean per-agent cost attribution.
That also fixes the low-signal "Token Usage by Agent" panel, which currently only ever shows "Main agent 100%" (it groups by agent TYPE, not named identity).

## 2. PROCESS: the capability shipped, awareness did not

A fresh omp session has zero cue that `omp stats` / its dashboard exist or what was added.
Nothing references it in the agent instruction surface (AGENTS.md, per-captain prefs, skills, session preamble), so an agent will not use it unless a human says "omp stats" - I only found it by probing after the captain named it.
Recommendation: ship a discovery cue with every new omp capability (a short skill, a SessionStart note, or one line in the agent context), not just a `--help` entry.

## 3. Lavish
Current lavish-axi (0.1.31) is in hand and working: full playbook set, the `design` command (DaisyUI 5.5.19 + Tailwind 4.2.4), the prebuilt fast-template, the composable section catalog / naval-template presets (#4), and the chrome composer queue-while-working fix (#5).
No issues. Same discoverability note as #2 applies for any new lavish capabilities you expect agents to reach for.

## Deliberately NOT reported (local artifacts of this workspace, not origin bugs)
- "Model mismatch": aggregate `byModel` shows `gpt-5.5`/`gpt-5.4` (openai-codex) while the live feed shows `claude-opus-4-8` (anthropic). This is just mixed historical data on this box (mates previously ran on codex; current sessions are claude) plus the 24h-vs-all window. Not a bug; nothing to change.
- "Only Main agent": the agent-type split is 100% "main" here simply because no subagents ran on this workstation, not because the feature is broken. The real ask (named-agent attribution) is folded into fix #1 above.

## Reply
Reply inline below this line and I will pick it up.
---
