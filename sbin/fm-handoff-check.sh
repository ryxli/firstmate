#!/usr/bin/env bash
# Validate active and pending captain requests against the firstmate readback.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_HOME="${FM_HOME:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CURRENT="$FM_HOME/data/handoff/current-actions.md"
READBACK="$FM_HOME/data/handoff/firstmate-readback.md"
failed=0
matched_lines=
current_header_line=1
readback_section_line=1
readback_section_end=1

source_entries=$(mktemp "${TMPDIR:-/tmp}/fm-handoff-source.XXXXXX") || exit 1
readback_entries=$(mktemp "${TMPDIR:-/tmp}/fm-handoff-readback.XXXXXX") || {
  rm -f "$source_entries"
  exit 1
}
cleanup() {
  rm -f "$source_entries" "$readback_entries"
}
trap cleanup EXIT

if [ ! -f "$CURRENT" ]; then
  printf 'FAIL: current-actions.md:1 is missing; firstmate-readback.md:1 cannot be checked\n'
  exit 1
fi
if [ ! -f "$READBACK" ]; then
  printf 'FAIL: current-actions.md:1 cannot be checked; firstmate-readback.md:1 is missing\n'
  exit 1
fi

# Keep only rows whose status is a pending item or an explicit active item.
line_no=0
while IFS= read -r line || [ -n "$line" ]; do
  line_no=$((line_no + 1))
  case "$line" in
    *'Exact request'*'Status'*'Proof'*) current_header_line=$line_no ;;
    '| '*)
      IFS='|' read -r _ request source outcome status proof boundary _rest <<EOF
$line
EOF
      status=${status#"${status%%[![:space:]]*}"}
      status=${status%"${status##*[![:space:]]}"}
      case "$status" in
        Pending*|pending*|Active*|active*)
          printf '%s\t%s\t%s\n' "$line_no" "$status" "$outcome" >> "$source_entries"
          ;;
      esac
      ;;
  esac
done < "$CURRENT"

# Readback entries are the numbered items in the Pending or active section.
in_section=0
line_no=0
while IFS= read -r line || [ -n "$line" ]; do
  line_no=$((line_no + 1))
  if [ "$line" = '## Pending or active' ]; then
    in_section=1
    readback_section_line=$line_no
    continue
  fi
  if [ "$in_section" -eq 1 ]; then
    case "$line" in
      '## '*)
        in_section=0
        readback_section_end=$((line_no - 1))
        ;;
      *)
        if [[ "$line" =~ ^[[:space:]]*[0-9][0-9]*\.[[:space:]]*(.*)$ ]]; then
          printf '%s\t%s\n' "$line_no" "${BASH_REMATCH[1]}" >> "$readback_entries"
        fi
        ;;
    esac
  fi
done < "$READBACK"
[ "$in_section" -eq 1 ] && readback_section_end=$line_no

normalize() {
  printf '%s\n' "$1" |
    tr -cs '[:alnum:]' '\n' |
    tr '[:upper:]' '[:lower:]'
}

is_ignored_word() {
  case "$1" in
    a|an|and|are|as|at|be|between|by|captain|conversation|do|for|from|in|is|it|its|of|on|or|that|the|this|to|with|work|your)
      return 0 ;;
    *) return 1 ;;
  esac
}

# Return the number of meaningful source words present in a readback item.
token_overlap() {
  local expected=$1 candidate=$2 token candidate_token overlap=0
  while IFS= read -r token; do
    [ -n "$token" ] || continue
    is_ignored_word "$token" && continue
    while IFS= read -r candidate_token; do
      [ "$token" = "$candidate_token" ] || continue
      overlap=$((overlap + 1))
      break
    done < <(normalize "$candidate")
  done < <(normalize "$expected")
  printf '%s\n' "$overlap"
}

token_count() {
  local text=$1 token count=0
  while IFS= read -r token; do
    [ -n "$token" ] || continue
    is_ignored_word "$token" && continue
    count=$((count + 1))
  done < <(normalize "$text")
  printf '%s\n' "$count"
}

source_count=0
while IFS=$'\t' read -r source_line status outcome; do
  [ -n "$source_line" ] || continue
  source_count=$((source_count + 1))
  expected_count=$(token_count "$outcome")
  best_score=0
  best_line=
  candidate_index=0
  while IFS=$'\t' read -r readback_line readback_item; do
    [ -n "$readback_line" ] || continue
    candidate_index=$((candidate_index + 1))
    score=$(token_overlap "$outcome" "$readback_item")
    if [ "$score" -gt "$best_score" ] ||
      { [ "$score" -eq "$best_score" ] && [ "$candidate_index" -eq "$source_count" ]; }; then
      best_score=$score
      best_line=$readback_line
    fi
  done < "$readback_entries"

  # A matching item must carry at least two meaningful words. Active
  # constraints may be paraphrased as a boundary in the readback, so they
  # use a lower overlap ratio than pending work outcomes.
  required_ratio=40
  case "$status" in
    Active*|active*) required_ratio=25 ;;
  esac
  if [ "$best_score" -ge 2 ] && [ $((best_score * 100)) -ge $((expected_count * required_ratio)) ]; then
    printf 'PASS: current-actions.md:%s ↔ firstmate-readback.md:%s\n' "$source_line" "$best_line"
    case ",$matched_lines," in
      *",$best_line,"*) ;;
      *) matched_lines="${matched_lines},$best_line" ;;
    esac
  else
    if [ -n "$best_line" ]; then
      printf 'FAIL: current-actions.md:%s has no matching active-readback entry; closest is firstmate-readback.md:%s\n' "$source_line" "$best_line"
    else
      printf 'FAIL: current-actions.md:%s has no matching active-readback entry in firstmate-readback.md:%s-%s\n' "$source_line" "$readback_section_line" "$readback_section_end"
    fi
    failed=1
  fi
done < "$source_entries"

if [ "$source_count" -eq 0 ]; then
  printf 'FAIL: current-actions.md:%s contains no pending or active entries; firstmate-readback.md:%s has no expected entries\n' "$current_header_line" "$readback_section_line"
  failed=1
fi

readback_count=0
while IFS=$'\t' read -r readback_line readback_item; do
  [ -n "$readback_line" ] || continue
  readback_count=$((readback_count + 1))
  case ",${matched_lines}," in
    *",$readback_line,"*) ;;
    *)
      printf 'FAIL: firstmate-readback.md:%s is not represented by a pending or active current-actions.md entry; current-actions.md:%s is the table header\n' "$readback_line" "$current_header_line"
      failed=1
      ;;
  esac
done < "$readback_entries"

if [ "$readback_count" -eq 0 ] && [ "$source_count" -gt 0 ]; then
  printf 'FAIL: firstmate-readback.md:%s-%s has no pending or active entries for current-actions.md:%s\n' "$readback_section_line" "$readback_section_end" "$current_header_line"
  failed=1
fi

[ "$failed" -eq 0 ]
