#!/usr/bin/env bash
# Atlas remote-control alias: run a herdr CLI command against a herdr session
# on the gb200 cluster (servers live on ccw1-login-4, sockets on /shared).
# Route: gb200-control-2 (key auth works) -> ccw1-login-4 -> session socket.
# Usage: sbin/gb200-herdr.sh pane list                      (atlas session)
#        FM_GB200_SESSION=gb200 sbin/gb200-herdr.sh pane list  (captain's session)
set -u
SESSION="${FM_GB200_SESSION:-atlas}"
SOCK=/shared/home/ryan/.config/herdr/sessions/$SESSION/herdr.sock
BIN=/shared/home/ryan/.local/bin/herdr

q=""
for a in "$@"; do
  q+=" $(printf '%q' "$a")"
done

exec ssh -o BatchMode=yes -o ConnectTimeout=10 gb200-control-2 \
  "ssh -o BatchMode=yes -o ConnectTimeout=8 ccw1-login-4 $(printf '%q' "HERDR_SOCKET_PATH=$SOCK $BIN$q")"
