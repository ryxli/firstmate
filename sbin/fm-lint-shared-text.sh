#!/usr/bin/env bash
# fm-lint-shared-text.sh - guard shared, semi-public text against firstmate's
# private persona and against the em-dash.
#
# PR descriptions, commit messages, and issue bodies are read by people outside
# this fleet. They must read as plain engineering prose - never in firstmate's
# captain/first-mate persona, and never narrating firstmate's internal machinery
# as if it were product behavior. This linter is the cheap backstop: run a body
# through it BEFORE posting, and it fails (exit 1) listing every offending line.
#
# Usage:
#   fm-lint-shared-text.sh <file>     # lint a file
#   fm-lint-shared-text.sh -          # lint stdin
#   some-cmd | fm-lint-shared-text.sh # (same as -)
#
# What it flags (high-confidence only, so the guard stays trusted and false-
# positive-free): the persona/nautical address vocabulary that never belongs in
# engineering prose, plus the em-dash (U+2014, banned by convention - use "-").
# It deliberately does NOT flag legitimate technical words that happen to name
# this project or its parts (firstmate, lavish, worktree, steward, pane): those
# are real nouns a PR may need. Keeping mechanics OUT of shared text past this
# list is a judgment call the author still owns; this catches the obvious leaks.
set -u

usage() { echo "usage: fm-lint-shared-text.sh <file|->" >&2; exit 2; }

SRC="${1:--}"
[ "$#" -le 1 ] || usage
if [ "$SRC" = "-" ]; then
  text=$(cat)
else
  [ -f "$SRC" ] || { echo "error: no such file: $SRC" >&2; exit 2; }
  text=$(cat "$SRC")
fi

# Persona / nautical address vocabulary. Case-insensitive, word-boundary matched
# via grep -iwE alternation. These are the terms AGENTS.md forbids in
# captain-facing text; in a shared body they are always a leak.
PERSONA_RE='captain|first mate|crewmate|crewmates|secondmate|secondmates|shipmate|matey|aye|shipshape|belay|avast'
# A couple of multi-word ones (phrase-matched, case-insensitive).
PHRASE_RE='on deck|all hands'

fail=0

emit() { # <label> <grep-output>
  printf '%s\n' "$2" | while IFS= read -r ln; do
    printf '  %s: %s\n' "$1" "$ln"
  done
}

# 1) em-dash (U+2014) - always wrong. Build the byte sequence from POSIX octal
# printf (E2 80 94), NOT from $'\u2014': the ANSI-C \u escape is unsupported in
# bash 3.2 (still the /bin/bash on macOS), where it would silently grep for the
# literal text "\u2014" and match nothing.
EMDASH=$(printf '\342\200\224')
if em=$(printf '%s' "$text" | grep -nF "$EMDASH"); then
  echo "forbidden: em-dash (U+2014); use an ASCII hyphen '-'" >&2
  emit "em-dash" "$em" >&2
  fail=1
fi

# 2) persona/nautical vocabulary (word-boundary, case-insensitive).
if hits=$(printf '%s' "$text" | grep -niwE "$PERSONA_RE"); then
  echo "forbidden: firstmate persona/nautical vocabulary in shared text" >&2
  emit "persona" "$hits" >&2
  fail=1
fi

# 3) multi-word persona phrases.
if ph=$(printf '%s' "$text" | grep -niE "$PHRASE_RE"); then
  echo "forbidden: firstmate persona phrase in shared text" >&2
  emit "phrase" "$ph" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "--" >&2
  echo "Rewrite as plain engineering prose (no persona, no em-dash) before posting." >&2
  exit 1
fi

echo "ok - no persona/nautical vocabulary or em-dash in shared text"
