#!/usr/bin/env bash
# Validate spawn prerequisites before fm-spawn creates a git worktree or herdr pane.
# Usage: fm-resolve-spawn.sh <project> [harness-override]
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"

project=${1:-}
harness_arg=${2:-}

if [ -z "$project" ]; then
  echo "error: fm-resolve-spawn requires a project argument" >&2
  exit 2
fi

first_command_word() {
  local launch=$1 word
  for word in $launch; do
    case "$word" in
      [A-Za-z_]*=*) continue ;;
      *) basename "$word"; return 0 ;;
    esac
  done
  return 1
}

if [ -z "$harness_arg" ]; then
  harness=$("$FM_ROOT/bin/fm-harness.sh" crew)
elif printf '%s' "$harness_arg" | grep '[[:space:]]' >/dev/null; then
  harness=$(first_command_word "$harness_arg" || true)
else
  harness=$harness_arg
fi

if [ -z "$harness" ]; then
  echo "error: could not resolve spawn harness; check config/crew-harness" >&2
  exit 1
fi

if ! command -v "$harness" >/dev/null 2>&1; then
  echo "error: spawn harness binary '$harness' was not found on PATH; check config/crew-harness or pass an available harness override" >&2
  exit 1
fi

project_name=${project%/}
project_name=${project_name##*/}
registry="$DATA/projects.md"
if [ -f "$registry" ]; then
  if ! grep -F -e "- ${project_name} " "$registry" >/dev/null 2>&1; then
    echo "warn: project '$project_name' does not appear in $registry; continuing because direct paths are allowed" >&2
  fi
else
  echo "warn: project registry $registry is missing; continuing because direct paths are allowed" >&2
fi

wtbase=${FM_WORKTREE_BASE:-$FM_HOME/worktrees}
if [ -e "$wtbase" ]; then
  [ -d "$wtbase" ] || { echo "error: worktree base '$wtbase' exists but is not a directory" >&2; exit 1; }
  [ -w "$wtbase" ] || { echo "error: worktree base '$wtbase' is not writable" >&2; exit 1; }
else
  parent=$(dirname "$wtbase")
  [ -d "$parent" ] || { echo "error: worktree base parent '$parent' does not exist" >&2; exit 1; }
  [ -w "$parent" ] || { echo "error: worktree base parent '$parent' is not writable" >&2; exit 1; }
fi
