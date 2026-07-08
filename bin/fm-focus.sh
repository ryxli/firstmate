#!/usr/bin/env bash
# fm-focus - compute-on-read priority view: "what needs the captain now".
# Thin wrapper so the command reads cleanly; all logic plus the importable
# rank() (used by the wake digest) live in fm-focus.mjs.
exec bun "$(dirname "$0")/fm-focus.mjs" "$@"
