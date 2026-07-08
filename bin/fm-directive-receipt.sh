#!/usr/bin/env bash
# fm-directive-receipt.sh - append and inspect local directive receipts.
set -eu

usage() {
  cat <<'USAGE'
usage: fm-directive-receipt.sh <append|list|latest|check> [options]

Record and verify local directive receipts with a disposition and evidence pointer.
Receipts are stored in $FM_HOME/state/directive-receipts.tsv by default.

Commands:
  append --summary <text> --disposition <executed|recorded|routed|disputed> --evidence <text>
      Append one receipt. Optional: --timestamp <iso-8601>, --home <path>, --file <path>.

  list [--limit <n>]
      Print receipts newest first. Optional: --home <path>, --file <path>.

  latest
      Print the newest receipt. Optional: --home <path>, --file <path>.

  check [--summary <needle>]
      Verify the newest matching receipt has a valid disposition and show its evidence.
      With no --summary, checks the newest receipt. Optional: --home <path>, --file <path>.

  -h, --help
      Show this help.
USAGE
}

fail_usage() {
  printf 'error: %s\n' "$1" >&2
  usage >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"

is_disposition() {
  case "$1" in
    executed|recorded|routed|disputed) return 0 ;;
    *) return 1 ;;
  esac
}

reject_unsafe_field() {
  case "$2" in
    *$'\n'*|*$'\r'*|*$'\t'*) printf 'error: %s cannot contain tabs or newlines\n' "$1" >&2; exit 2 ;;
    *) : ;;
  esac
}

resolve_file() {
  local home_override=$1 file_override=$2 home
  if [ -n "$file_override" ]; then
    printf '%s\n' "$file_override"
    return 0
  fi
  if [ -n "$home_override" ]; then
    home=$home_override
  else
    home=${FM_HOME:-$FM_ROOT}
  fi
  printf '%s\n' "$home/state/directive-receipts.tsv"
}

now_utc() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

format_receipt_line() {
  local line=$1 ts summary disposition evidence rest tab
  tab=$(printf '\t')
  IFS=$tab read -r ts summary disposition evidence rest <<EOF
$line
EOF
  if [ -n "${rest:-}" ]; then
    printf 'malformed receipt: too many fields\n'
    return 1
  fi
  printf '%s [%s] %s\n' "$ts" "$disposition" "$summary"
  printf '  evidence: %s\n' "$evidence"
}

append_receipt() {
  local summary='' disposition='' evidence='' timestamp='' home_override='' file_override='' file
  while [ $# -gt 0 ]; do
    case "$1" in
      --summary) shift; summary=${1:-}; [ -n "$summary" ] || fail_usage '--summary requires text' ;;
      --summary=*) summary=${1#--summary=} ;;
      --disposition) shift; disposition=${1:-}; [ -n "$disposition" ] || fail_usage '--disposition requires a value' ;;
      --disposition=*) disposition=${1#--disposition=} ;;
      --evidence) shift; evidence=${1:-}; [ -n "$evidence" ] || fail_usage '--evidence requires text' ;;
      --evidence=*) evidence=${1#--evidence=} ;;
      --timestamp) shift; timestamp=${1:-}; [ -n "$timestamp" ] || fail_usage '--timestamp requires text' ;;
      --timestamp=*) timestamp=${1#--timestamp=} ;;
      --home) shift; home_override=${1:-}; [ -n "$home_override" ] || fail_usage '--home requires a path' ;;
      --home=*) home_override=${1#--home=} ;;
      --file) shift; file_override=${1:-}; [ -n "$file_override" ] || fail_usage '--file requires a path' ;;
      --file=*) file_override=${1#--file=} ;;
      -h|--help) usage; exit 0 ;;
      -*) fail_usage "unknown flag: $1" ;;
      *) fail_usage "unexpected argument: $1" ;;
    esac
    shift
  done

  [ -n "$summary" ] || fail_usage 'append requires --summary'
  [ -n "$disposition" ] || fail_usage 'append requires --disposition'
  [ -n "$evidence" ] || fail_usage 'append requires --evidence'
  is_disposition "$disposition" || fail_usage 'disposition must be executed, recorded, routed, or disputed'
  [ -n "$timestamp" ] || timestamp=$(now_utc)
  reject_unsafe_field timestamp "$timestamp"
  reject_unsafe_field summary "$summary"
  reject_unsafe_field disposition "$disposition"
  reject_unsafe_field evidence "$evidence"

  file=$(resolve_file "$home_override" "$file_override")
  mkdir -p "$(dirname "$file")"
  printf '%s\t%s\t%s\t%s\n' "$timestamp" "$summary" "$disposition" "$evidence" >> "$file"
  printf 'recorded directive receipt: %s [%s]\n' "$timestamp" "$disposition"
  printf 'storage: %s\n' "$file"
}

list_receipts() {
  local limit=0 home_override='' file_override='' file
  while [ $# -gt 0 ]; do
    case "$1" in
      --limit) shift; limit=${1:-}; [ -n "$limit" ] || fail_usage '--limit requires a number' ;;
      --limit=*) limit=${1#--limit=} ;;
      --home) shift; home_override=${1:-}; [ -n "$home_override" ] || fail_usage '--home requires a path' ;;
      --home=*) home_override=${1#--home=} ;;
      --file) shift; file_override=${1:-}; [ -n "$file_override" ] || fail_usage '--file requires a path' ;;
      --file=*) file_override=${1#--file=} ;;
      -h|--help) usage; exit 0 ;;
      -*) fail_usage "unknown flag: $1" ;;
      *) fail_usage "unexpected argument: $1" ;;
    esac
    shift
  done
  case "$limit" in
    ''|*[!0-9]*) fail_usage '--limit must be a non-negative integer' ;;
    *) : ;;
  esac

  file=$(resolve_file "$home_override" "$file_override")
  if [ ! -s "$file" ]; then
    printf 'No directive receipts found.\n'
    return 0
  fi
  awk -F '\t' -v limit="$limit" '
    NF == 4 { lines[++n] = $0 }
    END {
      printed = 0
      for (i = n; i >= 1; i--) {
        split(lines[i], f, "\t")
        printf "%s [%s] %s\n  evidence: %s\n", f[1], f[3], f[2], f[4]
        printed++
        if (limit > 0 && printed >= limit) break
      }
    }
  ' "$file"
}

latest_line() {
  local file=$1 needle=${2:-}
  [ -s "$file" ] || return 1
  awk -F '\t' -v needle="$needle" '
    NF == 4 && (needle == "" || index($2, needle) > 0) { line = $0 }
    END { if (line != "") { print line; exit 0 } exit 1 }
  ' "$file"
}

latest_receipt() {
  local home_override='' file_override='' file line
  while [ $# -gt 0 ]; do
    case "$1" in
      --home) shift; home_override=${1:-}; [ -n "$home_override" ] || fail_usage '--home requires a path' ;;
      --home=*) home_override=${1#--home=} ;;
      --file) shift; file_override=${1:-}; [ -n "$file_override" ] || fail_usage '--file requires a path' ;;
      --file=*) file_override=${1#--file=} ;;
      -h|--help) usage; exit 0 ;;
      -*) fail_usage "unknown flag: $1" ;;
      *) fail_usage "unexpected argument: $1" ;;
    esac
    shift
  done
  file=$(resolve_file "$home_override" "$file_override")
  line=$(latest_line "$file") || { printf 'No directive receipts found.\n' >&2; exit 1; }
  format_receipt_line "$line"
}

check_receipt() {
  local needle='' home_override='' file_override='' file line ts summary disposition evidence rest tab
  while [ $# -gt 0 ]; do
    case "$1" in
      --summary) shift; needle=${1:-}; [ -n "$needle" ] || fail_usage '--summary requires text' ;;
      --summary=*) needle=${1#--summary=} ;;
      --home) shift; home_override=${1:-}; [ -n "$home_override" ] || fail_usage '--home requires a path' ;;
      --home=*) home_override=${1#--home=} ;;
      --file) shift; file_override=${1:-}; [ -n "$file_override" ] || fail_usage '--file requires a path' ;;
      --file=*) file_override=${1#--file=} ;;
      -h|--help) usage; exit 0 ;;
      -*) fail_usage "unknown flag: $1" ;;
      *) fail_usage "unexpected argument: $1" ;;
    esac
    shift
  done
  file=$(resolve_file "$home_override" "$file_override")
  if ! line=$(latest_line "$file" "$needle"); then
    printf 'receipt: no\n'
    if [ -n "$needle" ]; then
      printf 'summary-match: %s\n' "$needle"
    fi
    printf 'disposition: missing\n'
    exit 1
  fi

  tab=$(printf '\t')
  IFS=$tab read -r ts summary disposition evidence rest <<EOF
$line
EOF
  if [ -n "${rest:-}" ] || ! is_disposition "$disposition"; then
    printf 'receipt: yes\n'
    printf 'summary: %s\n' "$summary"
    printf 'disposition: missing\n'
    exit 1
  fi
  printf 'receipt: yes\n'
  printf 'timestamp: %s\n' "$ts"
  printf 'summary: %s\n' "$summary"
  printf 'disposition: %s\n' "$disposition"
  printf 'evidence: %s\n' "$evidence"
}

if [ $# -eq 0 ]; then
  usage >&2
  exit 2
fi

case "$1" in
  -h|--help) usage; exit 0 ;;
  append) shift; append_receipt "$@" ;;
  list) shift; list_receipts "$@" ;;
  latest) shift; latest_receipt "$@" ;;
  check) shift; check_receipt "$@" ;;
  *) fail_usage "unknown command: $1" ;;
esac
