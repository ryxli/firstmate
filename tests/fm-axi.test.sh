#!/usr/bin/env bash
# Run the TOON dispatcher contract under the same behavior-test glob CI uses.
set -eu
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
bun install --frozen-lockfile >/dev/null
exec bun tests/fm-axi.test.mjs
