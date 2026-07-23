---
name: herdr-dummy-pane-smoke-test
description: "Smoke-test herdr detection with isolated dummy pane and cleanup."
---

1. Create inert throwaway workspace; leave unfocused if needed.
2. In root pane run `herdr pane run <root_pane> <agent>`.
3. Run `herdr pane list`; require dummy `agent=<agent>` and non-`unknown` `agent_status`.
4. If ambiguous, check `herdr pane get <pane>`.
5. Close pane and remove workspace unless intentionally retained.
