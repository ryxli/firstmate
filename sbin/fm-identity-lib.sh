#!/usr/bin/env bash
# fm-identity-lib.sh - shared identity + label helpers for firstmate.
#
# Sourced by fm-spawn.sh and fm-brief.sh so that the rules for deriving
# a supervisor name, a human-readable task slug, and a worker's visible herdr
# display label live in exactly one place and never drift between the spawner
# (which places the agent and applies its herdr tab/pane display labels) and the
# brief scaffolder (which propagates the same identity downward in prose).
#
# The canonical per-instance identity file is config/identity (key=value,
# e.g. `name=<name>`, `role=Main firstmate crew supervisor`, `parent=cap`),
# the same LOCAL/gitignored config/ pattern as config/crew-harness. It is
# optional: when absent every helper falls back to neutral defaults so the
# tooling works on a fresh checkout with no identity configured.
#
# All functions are set -u and set -e safe.

# fm_identity_value <config-dir> <key>
# Print the value of <key>= from <config-dir>/identity, or fail (rc 1) when
# the file or key is absent. Leading/trailing whitespace around the value is
# trimmed; only the first matching line is used. <key> must be a literal
# identifier; it is interpolated into a sed BRE pattern, so metacharacters
# (. * [ \) in key would mismatch silently.
fm_identity_value() {
  local cfg=$1 key=$2 file value
  file="$cfg/identity"
  [ -f "$file" ] || return 1
  value=$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$file" | head -1)
  value=${value%"${value##*[![:space:]]}"}
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

# fm_supervisor_name <config-dir>
# Human-readable supervisor name (the configured name); "firstmate" when unset.
fm_supervisor_name() {
  fm_identity_value "$1" name 2>/dev/null || printf 'firstmate\n'
}

# fm_supervisor_role <config-dir>
# Supervisor role line; a neutral default when unset.
fm_supervisor_role() {
  fm_identity_value "$1" role 2>/dev/null || printf 'firstmate crew supervisor\n'
}

# fm_supervisor_parent <config-dir>
# Parent in the supervision chain (e.g. "cap"); "cap" when unset,
# since every firstmate ultimately answers to the cap.
fm_supervisor_parent() {
  fm_identity_value "$1" parent 2>/dev/null || printf 'cap\n'
}

# fm_supervisor_slug <config-dir>
# Short lowercase handle used as the "who spawned this" prefix of a worker
# label (the lowercased name, e.g. a name of "Foo Bar" gives "foo-bar"). Falls back to "fm" when no identity is configured,
# preserving the historical fm-<id> agent-name shape.
fm_supervisor_slug() {
  local cfg=$1 name
  name=$(fm_identity_value "$cfg" name 2>/dev/null) || { printf 'fm\n'; return 0; }
  printf '%s\n' "$name" | tr '[:upper:]' '[:lower:]' | tr ' ' '-'
}

# fm_task_slug <task-id>
# The human-readable part of a task id: the random suffix firstmate appends
# (a single letter + single digit, e.g. "-k3") is dropped so the visible
# label reads "fix-teardown-cleanup" rather than "fix-teardown-cleanup-k3".
# Ids without that suffix shape (e.g. "fm-spawn-crew-tab") pass through whole.
fm_task_slug() {
  printf '%s\n' "$1" | sed -E 's/-[a-z][0-9]$//'
}

# fm_worker_label <config-dir> <task-id> [explicit-label]
# The visible herdr tab and pane display label for a crewmate: the task slug
# alone (e.g. "fix-teardown-cleanup"). Supervisor attribution is not part of
# this label - it lives in state/<id>.meta supervisor= and in the herdr
# workspace (the secondmate's name or the project), so the tab need not repeat
# it. An explicit label, when given, wins so a caller can override the
# derivation. The random task id is never part of this label - it lives only
# in metadata/backlog/status. The config-dir argument is retained for signature
# stability even though the slug-only label no longer consults identity.
fm_worker_label() {
  local id=$2 explicit=${3:-}
  if [ -n "$explicit" ]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  fm_task_slug "$id"
}
