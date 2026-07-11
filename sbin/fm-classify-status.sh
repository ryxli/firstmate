#!/usr/bin/env bash
# Classify a single firstmate status line for supervisor escalation.
set -u

if [ "$#" -ne 1 ]; then
  echo "usage: fm-classify-status.sh <status-line>" >&2
  exit 2
fi

line=$1
if printf '%s' "$line" | grep -qiE 'done:|blocked:|failed:|needs-decision:|PR ready|checks green|ready in branch|merged'; then
  echo captain
  exit 0
fi

echo internal
exit 1
