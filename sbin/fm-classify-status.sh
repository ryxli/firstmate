#!/usr/bin/env bash
# Classify a single firstmate status line for supervisor escalation.
set -u

if [ "$#" -ne 1 ]; then
  echo "usage: fm-classify-status.sh <status-line>" >&2
  exit 2
fi

line=$(printf '%s' "$1" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^[:space:]]+[[:space:]]+//')
if printf '%s' "$line" | grep -qiE '^working([[:space:]]|:)'; then
  echo internal
  exit 1
fi
if printf '%s' "$line" | grep -qiE '^(done|blocked|failed|needs-decision):|(^|[^[:alpha:]])(PR ready|checks green|ready in branch|merged)([^[:alpha:]]|$)'; then
  echo captain
  exit 0
fi

echo internal
exit 1
