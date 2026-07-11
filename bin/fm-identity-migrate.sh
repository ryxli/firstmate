#!/usr/bin/env bash
# fm-identity-migrate.sh - migrate and check versioned identities for all
# registered secondmate homes.
#
# Usage:
#   fm-identity-migrate.sh migrate [--dry-run]
#       For each home registered in data/secondmates.md: add schema_version=1
#       to an unversioned config/identity (preserving name/role/other fields),
#       or create a config/identity from marker+registry facts for marker-only
#       homes. Refuses to touch any home where the marker id disagrees with
#       the registry id (CONFLICT). With --dry-run shows what would happen
#       without writing anything.
#
#   fm-identity-migrate.sh check
#       Exit 0 when every registered home carries a schema_version=1 identity
#       file. Exit 1 otherwise. Emits one tab-separated STATUS line per home:
#         OK        <id> <tab> <home>
#         UNRESOLVED <id> <tab> <home> <tab> <reason>
#       Machine-readable: parse on whitespace or split on tab. Riggs gates
#       removal of the whiteboard extension's marker-only fallback on this
#       command exiting 0.
#
# Behavior guarantees:
#   - Idempotent: already-versioned homes emit ALREADY_VERSIONED and are
#     left untouched.
#   - Transactional per file: writes go through a tmp file + atomic mv so a
#     crash mid-write never leaves a half-written identity.
#   - Non-destructive: existing name/role/parent/other fields are preserved;
#     only schema_version=1 is prepended and any duplicate schema_version=
#     lines are removed.
#   - Conflict-refusing: a marker-registry id mismatch is emitted as CONFLICT
#     to stderr and the home is left untouched. migrate exits 1 if any
#     conflict occurred.

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
REG="$DATA/secondmates.md"
SCHEMA_VERSION="1"

usage() {
  cat >&2 <<'EOF'
Usage:
  fm-identity-migrate.sh migrate [--dry-run]
  fm-identity-migrate.sh check
EOF
}

# Print "id<TAB>home" for each registered secondmate, trimming whitespace.
# Registry line format: - <id> - <summary> (home: <path>[; ...]; ...)
parse_registry_entries() {
  [ -f "$REG" ] || return 0
  sed -n 's/^- \([^ ]*\) - [^(]*(home: \([^;)]*\)[;)].*/\1\t\2/p' "$REG" | \
    awk -F'\t' 'NF==2 { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $1 "\t" $2 }'
}

# Print the first-clause role hint for a given id from the registry.
# "fran - Schwarzwald domain expert; owns ..." -> "Schwarzwald domain expert"
registry_role_for_id() {
  local id=$1
  [ -f "$REG" ] || return 1
  sed -n "s/^- ${id} - //p" "$REG" | \
    sed 's/(home:.*//' | sed 's/[[:space:]]*$//' | \
    sed 's/;.*//' | head -1
}

# Capitalize the first character of a string: "fran" -> "Fran".
capitalize_id() {
  local h t
  h=$(printf '%s' "$1" | cut -c1 | tr '[:lower:]' '[:upper:]')
  t=$(printf '%s' "$1" | cut -c2-)
  printf '%s%s\n' "$h" "$t"
}

# trim trailing whitespace from a string
trim() { printf '%s' "$1" | sed 's/[[:space:]]*$//'; }

# check_home <id> <home>
# Emit one STATUS line: "OK\t<id>\t<home>" or "UNRESOLVED\t<id>\t<home>\t<reason>".
# Does not modify any files.
check_home() {
  local id=$1 home=$2 marker_path identity_path marker_id sv
  marker_path="$home/.fm-secondmate-home"
  identity_path="$home/config/identity"

  if [ ! -d "$home" ]; then
    printf 'UNRESOLVED\t%s\t%s\tno-home-dir\n' "$id" "$home"
    return
  fi
  if [ ! -f "$marker_path" ]; then
    printf 'UNRESOLVED\t%s\t%s\tno-marker\n' "$id" "$home"
    return
  fi
  marker_id=$(tr -d '[:space:]' < "$marker_path")
  if [ "$marker_id" != "$id" ]; then
    printf 'UNRESOLVED\t%s\t%s\tmarker-mismatch:%s\n' "$id" "$home" "$marker_id"
    return
  fi
  if [ ! -f "$identity_path" ]; then
    printf 'UNRESOLVED\t%s\t%s\tno-identity\n' "$id" "$home"
    return
  fi
  sv=$(grep '^schema_version[[:space:]]*=' "$identity_path" 2>/dev/null | sed 's/^schema_version[[:space:]]*=[[:space:]]*//' | head -1)
  sv=$(trim "${sv:-}")
  if [ "$sv" = "$SCHEMA_VERSION" ]; then
    printf 'OK\t%s\t%s\n' "$id" "$home"
  else
    printf 'UNRESOLVED\t%s\t%s\tunversioned\n' "$id" "$home"
  fi
}

# migrate_home <id> <home> [--dry-run]
# Emit one STATUS line. Writes to stderr for CONFLICT/ERROR; stdout for all others.
# Returns 1 on CONFLICT or ERROR (so the caller can track overall exit status).
migrate_home() {
  local id=$1 home=$2 dry_run=0
  [ "${3:-}" = "--dry-run" ] && dry_run=1
  local marker_path="$home/.fm-secondmate-home"
  local identity_path="$home/config/identity"
  local marker_id

  if [ ! -d "$home" ]; then
    printf 'ERROR\t%s\t%s\tno-home-dir\n' "$id" "$home" >&2
    return 1
  fi

  # Check marker matches registry id — refuse without modifying on mismatch.
  if [ ! -f "$marker_path" ]; then
    printf 'CONFLICT\t%s\t%s\tno-marker\n' "$id" "$home" >&2
    return 1
  fi
  marker_id=$(tr -d '[:space:]' < "$marker_path")
  if [ "$marker_id" != "$id" ]; then
    printf 'CONFLICT\t%s\t%s\tmarker-id-mismatch:%s\n' "$id" "$home" "$marker_id" >&2
    return 1
  fi

  if [ -f "$identity_path" ]; then
    local sv existing_name tmp
    sv=$(grep '^schema_version[[:space:]]*=' "$identity_path" 2>/dev/null | sed 's/^schema_version[[:space:]]*=[[:space:]]*//' | head -1)
    sv=$(trim "${sv:-}")
    if [ "$sv" = "$SCHEMA_VERSION" ]; then
      printf 'ALREADY_VERSIONED\t%s\t%s\n' "$id" "$home"
      return 0
    fi
    # Require name= — an identity file without it cannot be safely migrated.
    existing_name=$(grep '^name[[:space:]]*=' "$identity_path" 2>/dev/null | sed 's/^name[[:space:]]*=[[:space:]]*//' | head -1)
    existing_name=$(trim "${existing_name:-}")
    if [ -z "$existing_name" ]; then
      printf 'CONFLICT\t%s\t%s\tidentity-no-name\n' "$id" "$home" >&2
      return 1
    fi
    if [ "$dry_run" = 1 ]; then
      printf 'WOULD_MIGRATE\t%s\t%s\n' "$id" "$home"
      return 0
    fi
    # Atomically prepend schema_version=1, removing any stale duplicate.
    tmp="${identity_path}.tmp.$$"
    printf 'schema_version=1\n' > "$tmp"
    sed '/^schema_version[[:space:]]*=/d' "$identity_path" >> "$tmp"
    mv "$tmp" "$identity_path"
    printf 'MIGRATED\t%s\t%s\n' "$id" "$home"
  else
    # Marker-only home: create identity from marker + registry role hint.
    local name role
    name=$(capitalize_id "$id")
    role=$(registry_role_for_id "$id") || role=""
    if [ "$dry_run" = 1 ]; then
      printf 'WOULD_CREATE\t%s\t%s\tname=%s\n' "$id" "$home" "$name"
      return 0
    fi
    mkdir -p "$home/config"
    tmp="${identity_path}.tmp.$$"
    printf 'schema_version=1\nname=%s\nrole=%s\n' "$name" "$role" > "$tmp"
    mv "$tmp" "$identity_path"
    printf 'CREATED\t%s\t%s\n' "$id" "$home"
  fi
}

cmd="${1:-}"
case "$cmd" in
  check)
    [ $# -eq 1 ] || { usage; exit 1; }
    any_unresolved=0
    while IFS=$'\t' read -r id home; do
      [ -n "$id" ] || continue
      result=$(check_home "$id" "$home")
      printf '%s\n' "$result"
      case "$result" in UNRESOLVED*) any_unresolved=1 ;; esac
    done < <(parse_registry_entries)
    exit "$any_unresolved"
    ;;
  migrate)
    [ $# -le 2 ] || { usage; exit 1; }
    dry_run_flag="${2:-}"
    [ -z "$dry_run_flag" ] || [ "$dry_run_flag" = "--dry-run" ] || { usage; exit 1; }
    any_bad=0
    while IFS=$'\t' read -r id home; do
      [ -n "$id" ] || continue
      migrate_home "$id" "$home" "${dry_run_flag:-}" || any_bad=1
    done < <(parse_registry_entries)
    exit "$any_bad"
    ;;
  -h|--help|'')
    usage
    exit 0
    ;;
  *)
    usage
    exit 1
    ;;
esac
