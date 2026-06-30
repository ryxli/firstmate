#!/usr/bin/env bash
# fm-lavish-reply.sh - post an agent reply into a Lavish session, non-blocking.
#
# After an agent applies the captain's feedback (relayed by the steward), it
# acknowledges in the browser with this helper. It writes the reply to the
# write-only HTTP `/api/<key>/agent-reply` endpoint and returns immediately - it
# NEVER polls, so it can never consume feedback or race the steward's blocking
# poll for the same session. The steward keeps owning the long-poll; the agent's
# thread stays free.
#
# Usage:
#   fm-lavish-reply.sh <html-file> <message>
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/fm-lavish-lib.sh
. "$SCRIPT_DIR/fm-lavish-lib.sh"

FILE=${1:-}
MSG=${2:-}
if [ -z "$FILE" ] || [ "$#" -lt 2 ]; then
  echo "usage: fm-lavish-reply.sh <html-file> <message>" >&2
  exit 2
fi

CANON=$(fm_lavish_canonical "$FILE")
KEY=$(fm_lavish_key "$CANON") || { echo "error: cannot derive session key (need shasum/sha256sum)" >&2; exit 1; }
BASE=$(fm_lavish_base_url)

# JSON-encode the message body safely (handles quotes, newlines, unicode).
BODY=$(MSG="$MSG" python3 -c 'import json,os;print(json.dumps({"text":os.environ["MSG"]}))' 2>/dev/null)
[ -n "$BODY" ] || { echo "error: failed to encode reply" >&2; exit 1; }

RESP=$(curl -fsS --max-time 10 -X POST "$BASE/api/$KEY/agent-reply" \
  -H 'content-type: application/json' -d "$BODY" 2>/dev/null)
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "error: could not reach Lavish server at $BASE (is the session still open?)" >&2
  exit 1
fi
case "$RESP" in
  *'"status":"sent"'*) echo "reply sent to session $KEY" ;;
  *'"error"'*) echo "error: $RESP" >&2; exit 1 ;;
  *) echo "unexpected response: $RESP" >&2; exit 1 ;;
esac
