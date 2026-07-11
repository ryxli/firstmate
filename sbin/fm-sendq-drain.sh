#!/usr/bin/env bash
# Drain queued fm-send deliveries that were left in a busy composer.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

# shellcheck source=sbin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"

QUEUE_DIR="$STATE/sendq"
INTERVAL="${FM_SENDQ_INTERVAL_SECS:-60}"
ALERT_SECS="${FM_SENDQ_ALERT_SECS:-300}"
RETRIES="${FM_SENDQ_RETRIES:-1}"
SLEEP_S="${FM_SENDQ_SLEEP:-0.2}"
SETTLE="${FM_SENDQ_SETTLE:-0.2}"

read_queue_field() {
  local file=$1 field=$2
  SENDQ_FILE="$file" SENDQ_FIELD="$field" python3 -c 'import base64, json, os
with open(os.environ["SENDQ_FILE"], "r", encoding="utf-8") as fh:
    data = json.load(fh)
value = data.get(os.environ["SENDQ_FIELD"], "")
if isinstance(value, int):
    print(value)
else:
    print(base64.b64encode(str(value).encode()).decode())'
}

decode_b64() {
  printf '%s' "$1" | base64 -d
}

queue_has_items() {
  [ -d "$QUEUE_DIR" ] || return 1
  set -- "$QUEUE_DIR"/*.json
  [ -e "$1" ]
}

drain_once() {
  [ -d "$QUEUE_DIR" ] || return 0
  local file id_b64 created target_b64 target pane_b64 pane text_b64 text now age verdict summary alert
  now=$(date +%s)
  for file in "$QUEUE_DIR"/*.json; do
    [ -e "$file" ] || continue
    id_b64=$(read_queue_field "$file" id) || { rm -f "$file"; continue; }
    created=$(read_queue_field "$file" created_at) || { rm -f "$file"; continue; }
    target_b64=$(read_queue_field "$file" target) || { rm -f "$file"; continue; }
    pane_b64=$(read_queue_field "$file" pane) || { rm -f "$file"; continue; }
    text_b64=$(read_queue_field "$file" text) || { rm -f "$file"; continue; }
    decode_b64 "$id_b64" >/dev/null
    target=$(decode_b64 "$target_b64")
    pane=$(decode_b64 "$pane_b64")
    text=$(decode_b64 "$text_b64")
    verdict=$(fm_herdr_submit_core "$pane" "$text" "$RETRIES" "$SLEEP_S" "$SETTLE")
    case "$verdict" in
      empty)
        rm -f "$file" "$file.alerted"
        ;;
      pending|send-failed)
        age=$((now - created))
        if [ "$age" -ge "$ALERT_SECS" ] && [ ! -f "$file.alerted" ]; then
          summary=${text//$'\n'/ }
          alert="blocked: sendq pending for $target after ${age}s; pane $pane; text: $summary"
          mkdir -p "$STATE"
          printf '%s\n' "$alert" >> "$STATE/sendq.status"
          printf '%s\n' "$alert" > "$file.alerted"
        fi
        ;;
    esac
  done
}

if [ "${1:-}" = "--once" ]; then
  drain_once
  exit 0
fi

while queue_has_items; do
  sleep "$INTERVAL"
  drain_once
 done
