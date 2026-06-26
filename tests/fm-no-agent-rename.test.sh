#!/usr/bin/env bash
# Static guard: the herdr agent-rename trap must never return to firstmate
# labeling surfaces. Human/lineage labels belong on DISPLAY surfaces only
# (herdr pane/tab/workspace rename). Renaming the herdr *agent* identity of an
# OMP pane overwrites the authoritative identity and pins agent_status=unknown,
# which breaks the omp<->herdr status binding: the integration reports identity
# "omp" and only stays bound while that identity is left intact.
#
# This scans the only files that can teach or perform firstmate labeling:
#   bin/*.sh   AGENTS.md   .omp/extensions/*.ts   tests/*.sh
# and FAILS only on an EXECUTABLE `herdr agent rename` - the trap in COMMAND
# position (start of the trimmed line, or right after a ; && || | $( { separator).
# Prose, comments, quoted strings, grep patterns, and fail-message text are all
# allowed, since none of those is a real labeling command. This avoids both
# passing a real command that carries a cautionary token and flagging a lowercase
# prohibition in docs.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# The trap pattern. Written as a bracket-expression so this very line does not
# match itself (the literal "[[:space:]]" is not whitespace).
TRAP_RE='herdr[[:space:]]+agent[[:space:]]+rename'

# Command-position matchers (bracket expressions keep shell + ERE metachars
# literal). A violation is the trap at the start of the trimmed line, or right
# after a shell command separator (; && || | $( {). Everything else is prose.
START_TRAP_RE='^herdr[[:space:]]+agent[[:space:]]+rename'
CHAIN_TRAP_RE='([;]|&&|[|][|]|[|]|[$][(]|[{])[[:space:]]*herdr[[:space:]]+agent[[:space:]]+rename'

# Emit the files to scan, one per line. Globs that match nothing are dropped by
# the -f guard, so missing extension or test files never break the scan.
scan_targets() {
  local f
  for f in "$ROOT"/bin/*.sh "$ROOT"/AGENTS.md "$ROOT"/.omp/extensions/*.ts "$ROOT"/tests/*.sh; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
}

test_no_agent_rename() {
  local violations="" file line lineno rel stripped
  while IFS= read -r file; do
    lineno=0
    while IFS= read -r line || [ -n "$line" ]; do
      lineno=$((lineno + 1))
      # Candidate: the line mentions the trap at all.
      [[ "$line" =~ $TRAP_RE ]] || continue
      # Flag ONLY an executable invocation: the trap in COMMAND POSITION - at the
      # start of the left-trimmed line, or right after a shell command separator
      # (; && || | $( {). Prose, comments, quoted strings, grep patterns, and
      # fail-message text place the trap elsewhere and are allowed - so this
      # neither passes a real command carrying a cautionary token (e.g. a trailing
      # "# do NOT remove") nor rejects a lowercase prohibition in docs.
      stripped="${line#"${line%%[![:space:]]*}"}"
      if [[ "$stripped" =~ $START_TRAP_RE ]] || [[ "$line" =~ $CHAIN_TRAP_RE ]]; then
        rel="${file#"$ROOT"/}"
        violations="${violations}  ${rel}:${lineno}: ${line}"$'\n'
      fi
    done < "$file"
  done < <(scan_targets)

  if [ -n "$violations" ]; then
    printf 'Offending agent-rename usage:\n%s\n' "$violations" >&2
    fail "Do not rename the herdr agent for firstmate labels. Use herdr pane rename, herdr tab rename, or herdr workspace rename instead, because omp status binds to agent identity omp."
  fi
  pass "no executable or instructional agent-rename usage in bin/AGENTS/extensions/tests"
}

test_no_agent_rename
