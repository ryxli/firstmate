---
name: herdr-dummy-pane-smoke-test
description: "Validate herdr agent hooks by launching a fresh dummy omp pane in a new workspace and confirming it appears in herdr with a real agent status, then close it when done unless it is intentionally kept open for review."
---

# Herdr dummy-pane smoke test

Use this when validating that an agent integration is installed and detected correctly, without disturbing any live work.

## Procedure
1. Create a fresh workspace in a safe, throwaway directory or an otherwise inert cwd.
2. Keep the new workspace unfocused if the current work matters.
3. Launch the target agent in the root pane with `herdr pane run <root_pane> <agent>`.
4. Wait briefly, then run `herdr pane list`.
5. Confirm the new pane shows `agent=<agent>` and a non-`unknown` `agent_status`.
6. If needed, confirm `herdr pane get <pane>` for the exact pane metadata.
7. When the smoke test is done, close the pane and its workspace unless you are intentionally keeping it open for review.

## What this catches
- Stale sessions that predate the integration hook.
- Missing or outdated agent-state hooks.
- False confidence from checking only existing, already-detected panes.

## Safety
- Use a fresh dummy workspace to avoid interrupting live agents.
- Do not restart or replace a working agent in place just to test detection unless the user has asked for that specific pane.
- Close the dummy pane after use so validation stays ephemeral unless the pane is explicitly needed for follow-up review.
