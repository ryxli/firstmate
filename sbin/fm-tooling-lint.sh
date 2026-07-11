#!/usr/bin/env bash
# fm-tooling-lint.sh - guard firstmate's own shipped tooling surfaces against
# non-bun JS/TS invocation.
#
# This workstation runs bun (see the "House tooling conventions" block that
# sbin/fm-brief.sh bakes into every crewmate brief and secondmate charter). A
# tool firstmate ships must be invoked via `bunx <tool>` or a bun-linked bare
# command - never the generic ecosystem runner, and never by running built
# output or a raw script file directly in docs, help text, or any user-facing
# invocation. This linter is the cheap mechanical backstop so that convention
# cannot silently rot back in: it greps the surfaces a human or agent actually
# reads and fails (exit 1) listing every offending line.
#
# Scanned surfaces under the root (default: this repo): README.md,
# CONTRIBUTING.md, .agents/skills/*/SKILL.md, and sbin/*.sh help/echo text.
#
# Usage:
#   fm-tooling-lint.sh            # scan this repo
#   fm-tooling-lint.sh <root>     # scan an alternate root (used by the test)
#
# Two files are deliberately NOT scanned: this guard and sbin/fm-brief.sh. Both
# exist to STATE the convention, so they legitimately name the forbidden forms
# as prohibition text; scanning them would flag the very rule they define. For
# any other one-off counterexample a line may carry the marker
# `fm-tooling-lint: allow` and it is skipped.
set -u

usage() { echo "usage: fm-tooling-lint.sh [root]" >&2; exit 2; }

[ "$#" -le 1 ] || usage
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"
[ -d "$ROOT" ] || { echo "error: no such root: $ROOT" >&2; exit 2; }

# The convention-definers: named by the forbidden forms on purpose, so exempt.
SELF="fm-tooling-lint.sh"
GENERATOR="fm-brief.sh"
ALLOW='fm-tooling-lint: allow'

# Collect the tooling surfaces that exist under ROOT.
files=()
[ -f "$ROOT/README.md" ] && files+=("$ROOT/README.md")
[ -f "$ROOT/CONTRIBUTING.md" ] && files+=("$ROOT/CONTRIBUTING.md")
if [ -d "$ROOT/.agents/skills" ]; then
  while IFS= read -r f; do files+=("$f"); done < <(find "$ROOT/.agents/skills" -name SKILL.md -type f 2>/dev/null)
fi
if [ -d "$ROOT/sbin" ]; then
  while IFS= read -r f; do
    case "$(basename "$f")" in
      "$SELF"|"$GENERATOR") continue ;;
    esac
    files+=("$f")
  done < <(find "$ROOT/sbin" -name '*.sh' -type f 2>/dev/null)
fi

[ "${#files[@]}" -gt 0 ] || { echo "ok - no tooling surfaces to scan under $ROOT"; exit 0; }

fail=0

emit() { # <label> <grep-output>
  printf '%s\n' "$2" | while IFS= read -r ln; do
    printf '  %s: %s\n' "$1" "$ln"
  done
}

# One scan pass per forbidden form. Each is grep -nE with a file: prefix so an
# offending line reports where it lives. Lines carrying the allow-marker are
# dropped first. -w on the runner keeps `npx` a whole word (not a substring).
scan() { # <label> <extra-grep-flags> <pattern>
  local label=$1 flags=$2 pat=$3 hits
  # shellcheck disable=SC2086  # $flags is an intentional word-split (-w or empty)
  hits=$(grep -nHE $flags "$pat" "${files[@]}" 2>/dev/null | grep -vF "$ALLOW")
  if [ -n "$hits" ]; then
    echo "forbidden: $label in firstmate tooling surface (house convention: use bun/bunx)" >&2
    emit "$label" "$hits" >&2
    fail=1
  fi
}

# 1) the generic ecosystem runner, as a whole word.
scan "npx invocation" "-w" 'npx'
# 2) running built output directly: `node <path-with-dist>` (e.g. node dist/cli.js).
scan "node dist invocation" "-w" 'node[[:space:]]+[^[:space:]]*dist'
# 3) a raw .js script file as a user-facing command (./sbin/x.js, sbin/x.js).
scan ".js script invocation" "" '(^|[[:space:]]|`)\.?/?sbin/[^[:space:]]*\.js'

if [ "$fail" -ne 0 ]; then
  echo "--" >&2
  echo "Use bun/bunx (or a bun-linked bare invocation) in shipped tooling docs and help text." >&2
  exit 1
fi

echo "ok - no non-bun JS invocation in firstmate tooling surfaces"
