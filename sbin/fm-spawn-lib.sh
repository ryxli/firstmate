#!/usr/bin/env bash
# fm-spawn-lib.sh - shared spawn-path shell helpers for firstmate.
#
# Sourced by fm-spawn.sh and fm-brief.sh so that the value-quoting and
# launch-command parsing used while placing a crewmate live in exactly one
# place and never drift between the spawner and the brief scaffolder. The
# `fm resolve-spawn` CLI verb (preflight validator) inlines its own copy.
#
# All functions are set -u and set -e safe and define no source-time state.

# fm_shell_quote <value>
# Print <value> single-quoted and safe to paste into a shell command (each
# embedded single quote becomes '\''). No trailing newline, so the result can
# be interpolated directly into a launch command or brief idiom.
fm_shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

# fm_first_command_word <launch-command>
# Print the harness binary name from a raw launch command: skip any leading
# VAR=value environment assignments, then print the basename of the first real
# word. Returns rc 1 (no output) when the command is only assignments/empty.
fm_first_command_word() {
  local launch=$1 word
  for word in $launch; do
    case "$word" in
      [A-Za-z_]*=*) continue ;;
      *) basename "$word"; return 0 ;;
    esac
  done
  return 1
}
