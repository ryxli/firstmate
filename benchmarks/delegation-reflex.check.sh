#!/usr/bin/env bash
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

grep -qF 'task:' "$ROOT/.omp/supervisor-overlay.yml" || fail 'supervisor overlay is missing task delegation profile'
grep -qF 'eager: always' "$ROOT/.omp/supervisor-overlay.yml" || fail 'supervisor overlay does not force task.eager=always'
grep -qF -- '--approval-mode=write' "$ROOT/bin/fm-spawn.sh" || fail 'secondmate supervisor launches do not raise approval friction for hands-on tools'
grep -qF 'emergency limit-mode - omp command not found' "$ROOT/bin/fm-spawn.sh" || fail 'emergency omp/codex parking path missing exact unblock condition'
grep -qF 'openai-codex/gpt-5.4-mini' "$ROOT/bin/fm-spawn.sh" || fail 'emergency OpenAI Codex lane is not pinned to a provider-qualified GPT model'
pass 'delegation-reflex substrate is structurally pinned to task-first supervisor launches'
