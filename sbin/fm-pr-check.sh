#!/usr/bin/env bash
# Record a PR-ready task: appends pr=<url> to state/<id>.meta and registers its
# merged-PR check with automatic in-process supervision. The generated check
# prints one line iff the PR is merged (the check contract: output = wake
# firstmate, silence = keep sleeping).
# Usage: fm-pr-check.sh <task-id> <pr-url>
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
ID=$1
URL=$2

META="$STATE/$ID.meta"
if [ -f "$META" ] && ! grep -qxF "pr=$URL" "$META"; then
  echo "pr=$URL" >> "$META"
fi

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

CHECK_URL=$(shell_quote "$URL")
cat > "$STATE/$ID.check.sh" <<EOF
URL=$CHECK_URL
PR_REF=\${URL#https://github.com/}
PR_REPO=\${PR_REF%%/pull/*}
PR_NUMBER=\${PR_REF##*/pull/}
state=\$(gh-axi pr view "\$PR_NUMBER" --repo "\$PR_REPO" 2>/dev/null | awk -F': *' '/^[[:space:]]*state:/{print toupper(\$2); exit}')
[ "\$state" = "MERGED" ] && echo "merged"
EOF
echo "armed: state/$ID.check.sh polls $URL"
