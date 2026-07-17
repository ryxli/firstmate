#!/usr/bin/env bash
# fm-skill-census.sh - read-only census of every skill instance this fleet
# touches: the shared template, each registered mate home's local skills, and
# machine-wide harness caches. Never writes anything, anywhere.
#
# Surfaces enumerated:
#   template              <code-root>/.agents/skills/*/SKILL.md - the shared,
#                          tracked skill set every mate inherits.
#   mate:<id>:.agents      <home>/.agents/skills/*/SKILL.md for each home
#                          registered in data/secondmates.md.
#   mate:<id>:.claude      <home>/.claude/skills/*/SKILL.md for the same homes.
#   cache:omp-managed-skills   ~/.omp/agent/managed-skills/*/SKILL.md
#   cache:claude-skills        ~/.claude/skills/*/SKILL.md
#
# A mate-home entry is skipped (not emitted) when its SKILL.md resolves,
# through any chain of symlinks - whether the whole .agents/.claude directory
# is symlinked or just the individual skill entry - into the template's
# .agents/skills tree. That is the template surface reappearing through the
# home's symlink, not a real mate-local copy. Cache entries are never
# skipped this way: they are physical copies by construction.
#
# Optional mate-local frontmatter convention (3 extra scalar lines, all
# optional, meaningful only on a mate-local SKILL.md - a real, non-template
# copy a mate keeps for itself):
#   origin: <how this local copy came to exist, e.g. "copied from template">
#   date: <YYYY-MM-DD this local copy was last created or reviewed>
#   stale_when: <YYYY-MM-DD after which the copy should be re-reviewed>
#
# Disposition flags (exactly one per emitted row, in priority order):
#   expire                stale_when is a valid past date (checked first -
#                          a copy overdue for review is actionable no matter
#                          how it otherwise compares to the template)
#   merge                 exact duplicate of the template's same-named skill
#                          (identical SKILL.md content hash) - fold in, delete
#                          the copy
#   drift                 same name as a template skill, but a different
#                          content hash - an unregistered divergent copy
#   graduate-or-delete    cache-only: no template skill shares this name
#   healthy               unique mate-local skill: no template counterpart
#   template              the shared baseline row itself (informational only,
#                          not one of the five disposition flags above)
#
# Output: tab-separated rows to stdout, one per skill instance -
#   surface<TAB>name<TAB>sha256<TAB>description<TAB>origin<TAB>date<TAB>stale_when<TAB>disposition
# missing optional fields print as "-". A header row, a blank line, all
# instance rows, a blank line, then a "summary" section with a row count per
# disposition flag observed this run.
#
# --check: exit 1 if any row's disposition is "drift"; exit 0 otherwise.
# Output is identical in both modes - --check only changes the exit code.
#
# Degrades gracefully: a missing template dir, missing registry, missing
# mate home, missing cache dir, unreadable file, or absent frontmatter field
# is reported as empty/skipped, never a crash.
#
# Env overrides (mainly for tests):
#   FM_CODE_ROOT_OVERRIDE / FM_ROOT_OVERRIDE   template code root
#   FM_HOME / FM_DATA_OVERRIDE                 where data/secondmates.md lives
#   FM_SKILL_CACHE_OMP_OVERRIDE                  overrides ~/.omp/agent/managed-skills
#   FM_SKILL_CACHE_CLAUDE_OVERRIDE                overrides ~/.claude/skills
#   FM_SKILL_CENSUS_TODAY                      overrides "today" (YYYY-MM-DD)
set -eu

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sbin/fm-root-lib.sh
. "$SCRIPT_DIR/fm-root-lib.sh"
fm_init_roots "${BASH_SOURCE[0]}"

usage() {
  echo "usage: fm-skill-census.sh [--check]" >&2
}

CHECK_MODE=0
case "${1:-}" in
  --check) CHECK_MODE=1 ;;
  --help|-h) usage; exit 0 ;;
  "") ;;
  *) usage; exit 1 ;;
esac

TODAY="${FM_SKILL_CENSUS_TODAY:-$(date +%Y-%m-%d)}"
TEMPLATE_SKILLS_DIR="$FM_CODE_ROOT_EFFECTIVE/.agents/skills"
SECONDMATES_MD="$FM_DATA_EFFECTIVE/secondmates.md"
OMP_CACHE="${FM_SKILL_CACHE_OMP_OVERRIDE:-$HOME/.omp/agent/managed-skills}"
CLAUDE_CACHE="${FM_SKILL_CACHE_CLAUDE_OVERRIDE:-$HOME/.claude/skills}"

# bash 3.2 (macOS's stock /bin/bash) has no associative arrays, so the
# template name->hash lookup lives in a flat "name<TAB>hash" file instead.
ROWS_FILE=$(mktemp "${TMPDIR:-/tmp}/fm-skill-census-rows.XXXXXX")
TEMPLATE_HASH_FILE=$(mktemp "${TMPDIR:-/tmp}/fm-skill-census-template.XXXXXX")
cleanup() { rm -f "$ROWS_FILE" "$TEMPLATE_HASH_FILE"; }
trap cleanup EXIT

hash_file() {
  [ -r "$1" ] || { printf '%s\n' "-"; return; }
  shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
}

# Print the lines strictly between the first and second "---" delimiters of
# a SKILL.md file, or nothing if there is no frontmatter block.
frontmatter_block() {
  [ -r "$1" ] || return 0
  awk 'NR==1 && $0=="---" {infm=1; next} infm && $0=="---" {exit} infm {print}' "$1" 2>/dev/null || true
}

# frontmatter_field <file> <field-name>: first-line value of a scalar
# frontmatter field, quotes stripped, or empty if absent/unreadable.
frontmatter_field() {
  local file=$1 field=$2
  frontmatter_block "$file" \
    | sed -n "s/^${field}:[[:space:]]*//p" \
    | head -1 \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

truncate_desc() {
  local s=$1 max=100
  s=${s//$'\t'/ }
  if [ "${#s}" -gt "$max" ]; then
    printf '%s...' "${s:0:$max}"
  else
    printf '%s' "$s"
  fi
}

is_past_date() {
  local d=$1
  [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 1
  [[ "$d" < "$TODAY" ]]
}

# template_hash_for <name>: prints the template's SKILL.md hash for a skill
# name, or nothing if the template has no skill by that name.
template_hash_for() {
  awk -F'\t' -v n="$1" '$1==n{print $2; exit}' "$TEMPLATE_HASH_FILE" 2>/dev/null
}

classify() {
  local surface=$1 name=$2 hash=$3 stale_when=$4 template_hash
  if [ -n "$stale_when" ] && is_past_date "$stale_when"; then
    printf 'expire\n'
    return
  fi
  template_hash=$(template_hash_for "$name")
  if [ -n "$template_hash" ]; then
    if [ "$template_hash" = "$hash" ]; then
      printf 'merge\n'
    else
      printf 'drift\n'
    fi
    return
  fi
  case "$surface" in
    mate:*) printf 'healthy\n' ;;
    cache:*) printf 'graduate-or-delete\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

emit_row() {
  local surface=$1 name=$2 file=$3 disposition=$4
  local hash desc origin date stale_when
  hash=$(hash_file "$file")
  desc=$(truncate_desc "$(frontmatter_field "$file" description)")
  origin=$(frontmatter_field "$file" origin); origin=${origin:--}
  date=$(frontmatter_field "$file" date); date=${date:--}
  stale_when=$(frontmatter_field "$file" stale_when); stale_when=${stale_when:--}
  [ -n "$desc" ] || desc="-"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$surface" "$name" "$hash" "$desc" "$origin" "$date" "$stale_when" "$disposition" >> "$ROWS_FILE"
}

# ---------------------------------------------------------------------------
# Surface 1: template
# ---------------------------------------------------------------------------
TEMPLATE_SKILLS_REAL=""
if [ -d "$TEMPLATE_SKILLS_DIR" ]; then
  TEMPLATE_SKILLS_REAL=$(fm_realpath_existing "$TEMPLATE_SKILLS_DIR" 2>/dev/null || true)
  shopt -s nullglob
  for entry in "$TEMPLATE_SKILLS_DIR"/*/; do
    name=$(basename "$entry")
    skill_file="$entry/SKILL.md"
    [ -f "$skill_file" ] || continue
    printf '%s\t%s\n' "$name" "$(hash_file "$skill_file")" >> "$TEMPLATE_HASH_FILE"
    emit_row "template" "$name" "$skill_file" "template"
  done
  shopt -u nullglob
fi

# Fully dereference a symlink chain (the file itself, not just its parent
# directories) so a skill entry symlinked at the file level - not just at a
# containing .agents/.claude or skill-directory level - is still recognized
# as the template surface reappearing.
fm_follow_symlink() {
  local path=$1 hops=40 target
  while [ -L "$path" ] && [ "$hops" -gt 0 ]; do
    target=$(readlink "$path") || break
    case "$target" in
      /*) path=$target ;;
      *) path="$(dirname "$path")/$target" ;;
    esac
    hops=$((hops - 1))
  done
  printf '%s\n' "$path"
}

resolves_into_template() {
  local file=$1 resolved
  [ -n "$TEMPLATE_SKILLS_REAL" ] || return 1
  file=$(fm_follow_symlink "$file")
  resolved=$(fm_realpath_existing "$file" 2>/dev/null) || return 1
  case "$resolved" in
    "$TEMPLATE_SKILLS_REAL"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Surface 2: each registered mate home's local skills
# ---------------------------------------------------------------------------
if [ -r "$SECONDMATES_MD" ]; then
  shopt -s nullglob
  while IFS=$'\t' read -r mate_id mate_home; do
    [ -n "$mate_id" ] && [ -n "$mate_home" ] || continue
    [ -d "$mate_home" ] || continue
    for sub in .agents/skills .claude/skills; do
      dir="$mate_home/$sub"
      [ -d "$dir" ] || continue
      label=".agents"; [ "$sub" = ".claude/skills" ] && label=".claude"
      for entry in "$dir"/*/; do
        name=$(basename "$entry")
        skill_file="$entry/SKILL.md"
        [ -f "$skill_file" ] || continue
        resolves_into_template "$skill_file" && continue
        [ -r "$skill_file" ] || continue
        stale_when=$(frontmatter_field "$skill_file" stale_when)
        disposition=$(classify "mate:$mate_id:$label" "$name" "$(hash_file "$skill_file")" "$stale_when")
        emit_row "mate:$mate_id:$label" "$name" "$skill_file" "$disposition"
      done
    done
  done < <(sed -n 's/^- \([^ ]*\) - [^(]*(home: \([^;)]*\)[;)].*/\1\t\2/p' "$SECONDMATES_MD" 2>/dev/null || true)
  shopt -u nullglob
fi

# ---------------------------------------------------------------------------
# Surface 3: machine caches
# ---------------------------------------------------------------------------
census_cache() {
  local surface=$1 dir=$2
  shopt -s nullglob
  for entry in "$dir"/*/; do
    local name skill_file stale_when disposition
    name=$(basename "$entry")
    skill_file="$entry/SKILL.md"
    [ -f "$skill_file" ] && [ -r "$skill_file" ] || continue
    stale_when=$(frontmatter_field "$skill_file" stale_when)
    disposition=$(classify "$surface" "$name" "$(hash_file "$skill_file")" "$stale_when")
    emit_row "$surface" "$name" "$skill_file" "$disposition"
  done
  shopt -u nullglob
}

if [ -d "$OMP_CACHE" ]; then census_cache "cache:omp-managed-skills" "$OMP_CACHE"; fi
if [ -d "$CLAUDE_CACHE" ]; then census_cache "cache:claude-skills" "$CLAUDE_CACHE"; fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
printf 'surface\tname\tsha256\tdescription\torigin\tdate\tstale_when\tdisposition\n'
printf '\n'
sort -t "$(printf '\t')" -k1,1 -k2,2 "$ROWS_FILE"
printf '\n'
printf 'summary\n'
printf 'disposition\tcount\n'
DRIFT_COUNT=0
if [ -s "$ROWS_FILE" ]; then
  while IFS=$'\t' read -r disposition count; do
    [ -n "$disposition" ] || continue
    printf '%s\t%s\n' "$disposition" "$count"
    [ "$disposition" = "drift" ] && DRIFT_COUNT=$count
  done < <(awk -F'\t' '{print $NF}' "$ROWS_FILE" | sort | uniq -c | awk '{print $2 "\t" $1}')
fi
total=$(wc -l < "$ROWS_FILE" | tr -d ' ')
printf 'total\t%s\n' "$total"

if [ "$CHECK_MODE" -eq 1 ] && [ "$DRIFT_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
