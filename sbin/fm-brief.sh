#!/usr/bin/env bash
# Scaffold a crewmate brief or persistent secondmate charter at
# data/<task-id>/brief.md under the active firstmate home.
# For ordinary tasks, the standard Setup/Rules/Definition-of-done contract is
# filled in. Firstmate then replaces the {TASK} placeholder with the task
# description, acceptance criteria, and context, and may adjust other sections
# when the task genuinely deviates (e.g. working an existing external PR instead
# of shipping a new one).
# Usage: fm-brief.sh <task-id> <repo-name> [--scout]
#        fm-brief.sh <task-id> --secondmate <project>...
#   --scout writes the scout contract instead: the deliverable is a report at
#   data/<task-id>/report.md (no branch, no push, no PR) and the worktree is scratch.
#   --secondmate writes a persistent secondmate charter. The project list
#   is cloned into the secondmate home, while the natural-language scope
#   tells the main firstmate when to route work there; routine churn stays in its own home;
#   only captain-relevant escalations reach the main firstmate through the fleet peer bus.
#   Set FM_SECONDMATE_CHARTER='<charter>' to fill the charter text.
#   Set FM_SECONDMATE_SCOPE='<scope>' to write a routing scope distinct from the charter text.
# For ship tasks, the definition of done is shaped by the project's delivery mode
# (data/projects.md via fm-project-mode.sh; see AGENTS.md section 6):
#   direct-PR    implement, focused review + tests, push + open PR via gh-axi -> captain merge (default)
#   direct-main  implement, focused review + tests, guarded non-force push to origin/main, no PR
#   local-only   implement on branch, stop and report "ready in branch" (no push/PR);
#                firstmate reviews, captain approves, firstmate merges to local main
# Scout tasks ignore mode - their deliverable is a report, not a merge.
# Ship tasks include a project-memory section so durable project-intrinsic
# learnings can be committed to AGENTS.md through the project's delivery path.
# Refuses to overwrite an existing brief.
#
# Usage: fm-brief.sh --regen <id>
#        fm-brief.sh --check <id>
#   --regen and --check make data/secondmates.md the only hand-edited home for a
#   secondmate's identity/scope: both data/<id>/brief.md and <home>/data/charter.md
#   are generated projections of the registry line for <id> plus a tracked
#   template. --regen writes both projections; --check regenerates in memory and
#   exits nonzero, naming any projection whose current content differs from what
#   generation would produce (a projection missing its mate-owned section markers
#   also fails --check). Each projection carries exactly one delimited mate-owned
#   free-form section, preserved verbatim across regenerations; --check ignores
#   that section's content but still requires the markers to be present.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/fm-identity-lib.sh"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
CONFIG="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

# --- secondmate charter regeneration -----------------------------------------
# data/secondmates.md is the only hand-edited home for secondmate identity and
# scope. data/<id>/brief.md and <home>/data/charter.md are both generated
# projections of the registry line for <id> plus the template below; never
# hand-edit them outside the one mate-owned section each carries.

MATE_SECTION_BEGIN='<!-- BEGIN MATE-OWNED NOTES: preserved verbatim across regeneration; edit only inside this block -->'
MATE_SECTION_END='<!-- END MATE-OWNED NOTES -->'
MATE_SECTION_DEFAULT='(no mate-owned notes yet)'

# find_secondmate_line <id> <registry-file>
# Prints the raw registry line for <id>, or fails if the registry or id is absent.
find_secondmate_line() {
  local id=$1 reg=$2 line rid
  [ -f "$reg" ] || return 1
  while IFS= read -r line; do
    case "$line" in
      "- "*)
        rid=${line#- }
        rid=${rid%% *}
        if [ "$rid" = "$id" ]; then
          printf '%s\n' "$line"
          return 0
        fi
        ;;
    esac
  done < "$reg"
  return 1
}

# secondmate_summary <line> <id>
# Prints the charter-summary text between "<id> - " and " (home:" on a registry line.
secondmate_summary() {
  local line=$1 id=$2 rest
  rest=${line#- }
  rest=${rest#"$id"}
  rest=${rest# - }
  rest=${rest%% \(home:*}
  printf '%s\n' "$rest"
}

# secondmate_parse_fields <line>
# Sets SM_HOME, SM_WORKSPACE, SM_NAME, SM_SCOPE, SM_PROJECTS, SM_ADDED from the
# parenthesized field block of a registry line. Fields are anchored on their
# fixed literal "; <field>: " separators (not a naive "; " split), so a
# semicolon inside a field's own free text (e.g. the scope prose) never
# misparses as a field boundary.
secondmate_parse_fields() {
  local line=$1 inner rest
  inner=${line#*\(}
  inner=${inner%\)}
  rest=$inner
  rest=${rest#home: }
  if [[ $rest == *"; workspace: "* ]]; then
    SM_HOME=${rest%%"; workspace: "*}
    rest=${rest#*"; workspace: "}
    SM_WORKSPACE=${rest%%"; name: "*}
    rest=${rest#*"; name: "}
  else
    SM_HOME=${rest%%"; name: "*}
    SM_WORKSPACE=""
    rest=${rest#*"; name: "}
  fi
  SM_NAME=${rest%%"; scope: "*}
  rest=${rest#*"; scope: "}
  SM_SCOPE=${rest%%"; projects: "*}
  rest=${rest#*"; projects: "}
  SM_PROJECTS=${rest%%"; added "*}
  rest=${rest#*"; added "}
  SM_ADDED=$rest
}

# resolve_escalation_name <config-dir>
# The main firstmate's display name for prose escalation text, resolved from
# config/identity name= at generation time. Falls back to "the main firstmate"
# (not fm-identity-lib.sh's generic "firstmate" default) so a generated charter
# never hard-codes a specific mate's name.
resolve_escalation_name() {
  fm_identity_value "$1" name 2>/dev/null || printf 'the main firstmate\n'
}

# format_project_lines <csv>
# Renders a registry "projects:" csv field as a bulleted list, or the
# pure-domain placeholder when empty/"(none)".
format_project_lines() {
  local csv=$1
  if [ -z "$csv" ] || [ "$csv" = "(none)" ]; then
    printf '%s\n' "(none) - pure-domain secondmate; your work surface is this firstmate home."
    return 0
  fi
  printf '%s\n' "$csv" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | sed 's/^/- /'
}

# extract_mate_owned <file>
# Prints the verbatim content between the mate-owned markers in <file>, or the
# empty scaffold placeholder when the file is missing or lacks both markers.
extract_mate_owned() {
  local file=$1
  if [ -f "$file" ] && grep -qF "$MATE_SECTION_BEGIN" "$file" && grep -qF "$MATE_SECTION_END" "$file"; then
    awk -v begin="$MATE_SECTION_BEGIN" -v end="$MATE_SECTION_END" '
      $0 == begin { capture=1; next }
      $0 == end { capture=0 }
      capture { print }
    ' "$file"
  else
    printf '%s\n' "$MATE_SECTION_DEFAULT"
  fi
}

# render_secondmate_projection <id> <line> <config-dir> <mate-owned-content>
# Renders the full generated charter/brief text for a registered secondmate.
render_secondmate_projection() {
  local id=$1 line=$2 config_dir=$3 prior_mate_owned=$4
  local charter_text escalation_name escalation_slug project_lines
  secondmate_parse_fields "$line"
  charter_text=$(secondmate_summary "$line" "$id")
  escalation_name=$(resolve_escalation_name "$config_dir")
  escalation_slug=$(fm_supervisor_slug "$config_dir")
  project_lines=$(format_project_lines "$SM_PROJECTS")

  cat <<EOF
You are a secondmate: a persistent domain supervisor managed by the main firstmate. Work on your own; do not wait for a human.

<!-- fm-charter: schema-version=1; generated from data/secondmates.md via fm-brief.sh; do not hand-edit outside the mate-owned section below -->

# Charter
You are $SM_NAME, a persistent secondmate managed by the main firstmate.
$charter_text

# Routing scope
$SM_SCOPE

# Project clones
$project_lines

# Operating model
You are in an isolated firstmate home.
Your local \`data/\`, \`state/\`, \`config/\`, and \`projects/\` directories are yours to operate.
The projects above are local clones for work you supervise; they are not an exclusive ownership claim.
OMP injects the applicable \`AGENTS.md\` at session start.
Do not tool-read it during ordinary boot or recovery.
At startup, read only this charter, compact \`data/captain.md\`, \`data/backlog.md:1-20\`, the local \`state/\` listing plus active \`.meta\` and \`.status\` files, pending peer messages, and the current whiteboard diff.
Use selectors and persisted artifacts instead of whole-file evidence reads or broad directory searches.
Delegate investigation after three primary-thread tool calls unless the next call conclusively closes the decision.
Delegate project work to your own crewmates with the normal firstmate lifecycle: brief, spawn, direct crewmate status-file reporting, \`fm-send.sh\` pane steering, teardown, and recovery.
Do not invent a second delegation system.
When driving a visible pane or remote machine, state the diagnostic intent first, then send short human-legible expert commands one by one.
Do not paste chained shell blobs, printf sentinels, or noisy echo scaffolding into the pane.
You do not generate your own work.
Act only on tasks the main firstmate routes to you.
Never start a survey, audit, or "find improvements" sweep on your own initiative; that is not your job and it is unwanted.
Supervision is automatic and in-process; there is no watcher, wake-queue, beacon, or separate supervisor process.

# Escalation to main firstmate
Handle routine work yourself.
Escalate only captain-actionable transition states - \`done\`, \`blocked\`, \`needs-decision\`, \`failed\`, or a material phase change - through the fleet peer bus.
Use the agent tool peer_send when available, or type /peer send $escalation_slug "{state}: {one short line}" from the composer, addressed to $escalation_name; set priority only for captain-blocking decisions, failures, or work ready for review.
States: needs-decision, blocked, done, failed.
Routine internal supervision, heartbeats, retries, and crewmate churn stay inside your own home and must not touch the supervisor channel.

# Definition of done
You are persistent by default. Do not exit just because your queue is empty.
On startup and restart, run normal firstmate bootstrap and recovery for your own home, but only to RECONCILE work that is already yours: in-flight crewmates, tracked backlog items, and durable watches recorded in this home.
When you have no assigned or in-flight work after that reconciliation, go idle and wait silently for the main firstmate to route you a task.
An empty queue is a healthy resting state, not a cue to invent work: never spawn a survey, audit, or any self-directed "find work" task on your own initiative.
If this charter cannot be carried out, send blocked: {why} or failed: {why} to the main firstmate through the fleet peer bus and stop.

# Mate-owned notes
$MATE_SECTION_BEGIN
$prior_mate_owned
$MATE_SECTION_END
EOF
}

# check_projection <path> <expected-content>
# Fails (prints a diagnostic to stderr) when <path> is missing, lacks either
# mate-owned marker, or differs from <expected-content>.
check_projection() {
  local path=$1 expected=$2 actual
  if [ ! -f "$path" ]; then
    echo "check: missing projection: $path" >&2
    return 1
  fi
  if ! grep -qF "$MATE_SECTION_BEGIN" "$path" || ! grep -qF "$MATE_SECTION_END" "$path"; then
    echo "check: projection missing mate-owned section markers: $path" >&2
    return 1
  fi
  actual=$(cat "$path")
  if [ "$actual" != "$expected" ]; then
    echo "check: projection differs from registry-generated content: $path" >&2
    return 1
  fi
  return 0
}

# cmd_regen_or_check <regen|check> <id>
# Looks <id> up in $DATA/secondmates.md, renders both projections (each
# preserving its own current mate-owned section verbatim), then either writes
# them (regen) or diffs them against what is on disk (check).
cmd_regen_or_check() {
  local mode=$1 id=$2 line brief_path charter_path
  line=$(find_secondmate_line "$id" "$DATA/secondmates.md") || {
    echo "error: no registered secondmate '$id' in $DATA/secondmates.md" >&2
    return 1
  }
  secondmate_parse_fields "$line"
  brief_path="$DATA/$id/brief.md"
  charter_path="$SM_HOME/data/charter.md"

  local brief_prior charter_prior brief_content charter_content
  brief_prior=$(extract_mate_owned "$brief_path")
  charter_prior=$(extract_mate_owned "$charter_path")
  brief_content=$(render_secondmate_projection "$id" "$line" "$CONFIG" "$brief_prior")
  charter_content=$(render_secondmate_projection "$id" "$line" "$CONFIG" "$charter_prior")

  if [ "$mode" = regen ]; then
    mkdir -p "$(dirname "$brief_path")"
    printf '%s\n' "$brief_content" > "$brief_path"
    mkdir -p "$(dirname "$charter_path")"
    printf '%s\n' "$charter_content" > "$charter_path"
    echo "regenerated: $brief_path"
    echo "regenerated: $charter_path"
    return 0
  fi

  local failed=0
  check_projection "$brief_path" "$brief_content" || failed=1
  check_projection "$charter_path" "$charter_content" || failed=1
  [ "$failed" -eq 0 ] || return 1
  echo "check: ok ($id)"
  return 0
}

case "${1:-}" in
  --regen)
    [ $# -eq 2 ] || { echo "usage: fm-brief.sh --regen <id>" >&2; exit 1; }
    cmd_regen_or_check regen "$2"
    exit $?
    ;;
  --check)
    [ $# -eq 2 ] || { echo "usage: fm-brief.sh --check <id>" >&2; exit 1; }
    cmd_regen_or_check check "$2"
    exit $?
    ;;
esac

KIND=ship
POS=()
for a in "$@"; do
  case "$a" in
    --scout) KIND=scout ;;
    --secondmate) KIND=secondmate ;;
    *) POS+=("$a") ;;
  esac
done
ID=${POS[0]}

BRIEF="$DATA/$ID/brief.md"
[ -e "$BRIEF" ] && { echo "error: $BRIEF already exists" >&2; exit 1; }
mkdir -p "$DATA/$ID"

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

STATUS_FILE=$(shell_quote "$STATE/$ID.status")
REPORT_HELPER=$(shell_quote "$FM_ROOT/sbin/fm-report.sh")
SUPERVISOR_ID=$(fm_supervisor_slug "$CONFIG")
assignment_contract() {
  cat <<'EOF'
# Assignment contract
The `# Task` section is the complete assignment and the only required pre-spawn substitution is `{TASK}`.
Before work begins, extract and record these values from the task text:
- Falsifiable goal (exactly one): state one measurable outcome the task must achieve.
- Named deliverable path (exactly one): state the file, report, branch, or PR that will carry the result.
- Evidence packet: cite stable source references such as `path:line`, `commit:<full-sha>:path:line`, or a durable URL.
- Acceptance criteria:
  - preserve every criterion stated in the `# Task` section and verify each one.
- Non-goals: honor explicit exclusions in the task and do not add unrelated scope.
- Stopping point: stop only after the acceptance criteria are verified.
- Method owner: You own the specialist method.
  Choose, execute, and justify the method needed to meet the goal; escalate only a real decision or blocker.
- Blocker: report `none` unless a real blocker prevents completion.
- Next action: report the next concrete action while work is in progress, or `none` when complete.
- Completion return shape:
  `done: <delivery status>; goal <falsifiable goal>; deliverable <named deliverable path>; evidence <source-ref,...>; acceptance <criterion=pass|fail,...>; blocker <none|...>; next action <none|...>`
Use the extracted values in status updates and the final completion report. Do not report completion without evidence and per-criterion pass/fail results.
At completion, replace the angle-bracket labels in the return shape with actual values.
EOF
}

ASSIGNMENT_CONTRACT=$(assignment_contract)


if [ "$KIND" = secondmate ]; then
SECONDMATE_PROJECTS=""
idx=1
while [ "$idx" -lt "${#POS[@]}" ]; do
  SECONDMATE_PROJECTS="${SECONDMATE_PROJECTS}${SECONDMATE_PROJECTS:+ }${POS[$idx]}"
  idx=$((idx + 1))
done
[ -n "$SECONDMATE_PROJECTS" ] || { echo "error: --secondmate requires at least one project" >&2; exit 1; }
SECONDMATE_CHARTER=${FM_SECONDMATE_CHARTER:-"{TASK}"}
SECONDMATE_SCOPE=${FM_SECONDMATE_SCOPE:-${FM_SECONDMATE_CHARTER:-"{TASK}"}}
PROJECT_LIST=$(printf '%s\n' "$SECONDMATE_PROJECTS" | tr ' ' '\n' | sed 's/^/- /')
cat > "$BRIEF" <<EOF
You are a secondmate: a persistent domain supervisor managed by the main firstmate. Work on your own; do not wait for a human.

# Charter
$SECONDMATE_CHARTER

# Routing scope
$SECONDMATE_SCOPE

# Project clones
$PROJECT_LIST

# Operating model
You are in an isolated firstmate home. The local \`AGENTS.md\` is your job description, and your local \`data/\`, \`state/\`, \`config/\`, and \`projects/\` dirs are yours to operate.
The projects above are local clones for work you supervise; they are not an exclusive ownership claim.
Delegate project work to your own crewmates with the normal firstmate lifecycle: brief, spawn, direct crewmate status-file reporting, \`fm-send.sh\` pane steering, teardown, and recovery.
Do not invent a second delegation system.
When driving a visible pane or remote machine, state the diagnostic intent first, then send short human-legible expert commands one by one.
Do not paste chained shell blobs, printf sentinels, or noisy echo scaffolding into the pane.
You do not generate your own work.
Act only on tasks the main firstmate routes to you.
Never start a survey, audit, or "find improvements" sweep on your own initiative; that is not your job and it is unwanted.
Supervision is automatic and in-process; there is no watcher, wake-queue, beacon, or separate supervisor process.
# Escalation to main firstmate
Handle routine work yourself.
Escalate only captain-actionable transition states - \`done\`, \`blocked\`, \`needs-decision\`, \`failed\`, or a material phase change - through the fleet peer bus.
Use the agent tool peer_send when available, or type /peer send $SUPERVISOR_ID "{state}: {one short line}" from the composer; set priority only for captain-blocking decisions, failures, or work ready for review.
States: needs-decision, blocked, done, failed.
Use this only for material phase changes, a captain decision, a real blocker, a failure, or work ready for review.
Derive decisions from evidence before escalating: for a config, parameter, or design choice, first consult relevant papers/sources, project docs, and prior fleet research (other mates' worktrees, reports, decision journals). If the evidence points to a clearly better option, take it and justify it - escalate a decision ONLY for a genuine toss-up between equally good options or a destructive/irreversible/live-capital-risk action. Never punt a solvable decision upward.
Routine internal supervision, heartbeats, retries, and crewmate churn stay inside your own home and must not touch the supervisor channel.

# Definition of done
You are persistent by default. Do not exit just because your queue is empty.
On startup and restart, run normal firstmate bootstrap and recovery for your own home, but only to RECONCILE work that is already yours: in-flight crewmates, tracked backlog items, and durable watches recorded in this home.
When you have no assigned or in-flight work after that reconciliation, go idle and wait silently for the main firstmate to route you a task.
An empty queue is a healthy resting state, not a cue to invent work: never spawn a survey, audit, or any self-directed "find work" task on your own initiative.
If this charter cannot be carried out, send blocked: {why} or failed: {why} to the main firstmate through the fleet peer bus and stop.
EOF
if [ "$SECONDMATE_CHARTER" = "{TASK}" ]; then
  echo "scaffolded: $BRIEF (secondmate charter; replace {TASK})"
else
  echo "scaffolded: $BRIEF (secondmate charter)"
fi
exit 0
fi

REPO=${POS[1]}

if [ "$KIND" = scout ]; then
cat > "$BRIEF" <<EOF
You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
{TASK}

$ASSIGNMENT_CONTRACT

# Setup
You are in a disposable git worktree of $REPO, at a detached HEAD on a clean default branch.
This is a SCOUT task: the deliverable is a written report, not a PR.
The worktree is your laboratory - install, run, edit, and make scratch commits freely; all of it is discarded at teardown.
The report is the only thing that survives, so anything worth keeping must be in it.

# Rules
1. Never push to any remote and never open a PR.
2. Stay inside this worktree; the only files you may write outside it are the report and the status file below.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. When driving a visible pane or remote machine, state the diagnostic intent first, then send short human-legible expert commands one by one.
   Do not paste chained shell blobs, printf sentinels, or noisy echo scaffolding into the pane.
5. Report status by running:
   $REPORT_HELPER $STATUS_FILE "{state}: {one short line}"
   States: working, needs-decision, blocked, done, failed.
   Each report wakes firstmate, so report sparingly: only phase changes a supervisor
   would act on and the needs-decision/blocked/done/failed states. No step-by-step
   FYI progress lines; firstmate reads your pane for that.
6. If you hit the same obstacle twice, report blocked: {why} and stop; firstmate will help.
7. Derive decisions from evidence before escalating: for a config, parameter, or design choice, first consult relevant papers/sources, project docs (\`AGENTS.md\`), and prior fleet research (other worktrees, reports, decision journals). If the evidence points to a clearly better option, take it and justify it in your report - do not punt a solvable decision upward.
8. Escalate a decision to a human ONLY for (a) a genuine toss-up between two equally good options after weighing the evidence, or (b) a destructive, irreversible, or live-capital-risk action. Then report needs-decision: {summary of options + the evidence you weighed} and stop. Firstmate will reply with the decision.
# Definition of done
Write your findings to $DATA/$ID/report.md.
The report must stand alone: what you did, what you found, the evidence (commands run, output, file:line references), and what you recommend.
When the report is complete, append \`done: report $DATA/$ID/report.md; goal <falsifiable goal>; deliverable <named deliverable path>; evidence <source-ref,...>; acceptance <criterion=pass|fail,...>; blocker <none|...>; next action <none|...>\` to the status file, then stop. The status file is the supervisor signal; do not require peer-bus access from a disposable scout.
If your findings reveal work that should ship (e.g. you reproduced a bug and the fix is clear), say so in the report; firstmate may promote this task in place, and you would then receive mode-specific ship instructions as a follow-up message.
EOF
echo "scaffolded: $BRIEF (scout; replace {TASK})"
exit 0
fi

# Ship task: shape Setup / Rule 1 / Definition of done by the project's delivery mode.
# yolo does not affect the brief (it governs firstmate's approval behaviour), so discard it.
read -r MODE _ <<EOF
$("$FM_ROOT/sbin/fm-project-mode.sh" "$REPO")
EOF

case "$MODE" in
  local-only)
    SETUP2=""
    RULE1="1. Never push to any remote and never open a PR. Work only on your \`fm/$ID\` branch; firstmate handles the merge into local \`main\`."
    DOD=$(cat <<EOF
# Definition of done
This project ships **local-only**: no remote, no PR, no pipeline.
The task is complete only when committed on your branch \`fm/$ID\`. Do NOT push, do NOT open a PR, do NOT merge.
Before you finish, run the focused checks the project already uses (the tests and lints that cover your change) and confirm they pass; fix anything you broke.
Keep your branch a clean fast-forward onto the current default branch - if \`main\` has advanced, rebase onto it so the eventual merge stays a fast-forward.
When it is implemented and committed, append \`done: ready in branch fm/$ID; goal <falsifiable goal>; deliverable <named deliverable path>; evidence <source-ref,...>; acceptance <criterion=pass|fail,...>; blocker <none|...>; next action <none|...>\` to the status file, then stop. The status file is the supervisor signal; do not require peer-bus access from a disposable worker.
Firstmate then reviews your branch diff, the captain approves, and firstmate merges it into local \`main\`.
EOF
)
    ;;
  direct-main)
    SETUP2=""
    RULE1='1. Never open a PR, never force-push, and never push any commit except the reviewed `fm/'"$ID"'` head to `origin/main` after every direct-main delivery check below passes.'
    DOD=$(cat <<EOF
# Definition of done
This project ships **direct-main**: the captain has authorized this project to land by guarded direct push to \`origin/main\`. Do NOT open a PR under any circumstances. Do NOT force-push.
The task is complete only when your \`fm/$ID\` branch is clean, reviewed by you, committed, delivered as the exact remote \`origin/main\` SHA, and fetch-back verified. The \`+yolo\` flag never relaxes these safeguards.
Before delivery, run the focused checks the project already uses (the tests and lints that cover your change) and confirm they pass, then review your own diff for correctness and scope.
Deliver with exactly one writer and a fresh remote proof. Acquire the shared delivery lock, fetch \`origin/main\` immediately before the ancestry check, prove that fetched \`origin/main\` is an ancestor of your intended head, push that exact head normally to \`origin/main\`, fetch back, and verify the remote SHA:
\`\`\`sh
test -z "\$(git status --porcelain)"
branch=\$(git branch --show-current)
test "\$branch" = "fm/$ID"
head=\$(git rev-parse HEAD)
lock_dir="\$(git rev-parse --git-common-dir)/fm-direct-main-delivery.lock"
if ! mkdir "\$lock_dir"; then
  echo "direct-main delivery already in progress" >&2
  exit 1
fi
trap 'rmdir "\$lock_dir"' EXIT
git fetch origin main
base=\$(git rev-parse origin/main)
git merge-base --is-ancestor "\$base" "\$head"
git push origin "\$head:refs/heads/main"
git fetch origin main
remote=\$(git rev-parse origin/main)
test "\$remote" = "\$head"
\`\`\`
If any command fails, stop and report blocked with the failed safeguard; do not retry by forcing. When delivery is verified, append \`done: direct-main origin/main \$head; goal <falsifiable goal>; deliverable <named deliverable path>; evidence <source-ref,...>; acceptance <criterion=pass|fail,...>; blocker <none|...>; next action <none|...>\` to the status file, then stop. The status file is the supervisor signal; do not require peer-bus access from a disposable worker.
EOF
)
    ;;
  *)  # direct-PR (default)
    SETUP2=""
    RULE1='1. Never push to the default branch (push only your `fm/'"$ID"'` branch). Never merge a PR.'
    DOD=$(cat <<EOF
# Definition of done
This project ships **direct-PR**: you raise the PR yourself, backed by focused review and tests. There is no separate validation pipeline to run.
The task is complete only when committed on your branch.
Before you push, run the focused checks the project already uses (the tests and lints that cover your change) and confirm they pass, then review your own diff for correctness and scope.
When it is implemented, checked, and committed, push your branch and open a PR with \`gh-axi\`, then append \`done: PR {url}; goal <falsifiable goal>; deliverable <named deliverable path>; evidence <source-ref,...>; acceptance <criterion=pass|fail,...>; blocker <none|...>; next action <none|...>\` to the status file, then stop. The status file is the supervisor signal; do not require peer-bus access from a disposable worker.
Write the PR body in the standard format: a 1-2 line summary, then \`## Summary\` with a concrete visualize-the-change example - a command and its output, or a short before/after - then \`## Refs\` with the PR/issue/report links. The publish guard requires this.
The captain reviews and merges the PR; firstmate relays it.
EOF
)
    ;;
esac

cat > "$BRIEF" <<EOF
You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
{TASK}

$ASSIGNMENT_CONTRACT

# Setup
You are in a disposable git worktree of $REPO, already on your branch \`fm/$ID\` (created off a clean default branch).
1. First action: confirm with \`git branch --show-current\`; do not create or switch branches.$SETUP2

# Rules
$RULE1
2. Stay inside this worktree; modify nothing outside it.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. When driving a visible pane or remote machine, state the diagnostic intent first, then send short human-legible expert commands one by one.
   Do not paste chained shell blobs, printf sentinels, or noisy echo scaffolding into the pane.
5. Report status by running:
   $REPORT_HELPER $STATUS_FILE "{state}: {one short line}"
   States: working, needs-decision, blocked, done, failed.
   Each report wakes firstmate, so report sparingly: only phase changes a supervisor
   would act on (setup done, bug reproduced, fix implemented, validation passed) and the
   needs-decision/blocked/done/failed states. No step-by-step FYI progress lines;
   firstmate reads your pane for that.
6. If you hit the same obstacle twice, report blocked: {why} and stop; firstmate will help.
7. Derive decisions from evidence before escalating: for a config, parameter, or design choice, first consult relevant papers/sources, project docs (\`AGENTS.md\`), and prior fleet research (other worktrees, reports, decision journals). If the evidence points to a clearly better option, take it and justify it in your report - do not punt a solvable decision upward.
8. Escalate a decision to a human ONLY for (a) a genuine toss-up between two equally good options after weighing the evidence, or (b) a destructive, irreversible, or live-capital-risk action (product choices, ask-user findings included). Then report needs-decision: {summary of options + the evidence you weighed} and stop. Firstmate will reply with the decision.

# Project memory
If \`AGENTS.md\` or \`CLAUDE.md\` already exists, or if this task produced durable project-intrinsic knowledge, run \`$FM_ROOT/sbin/fm-ensure-agents-md.sh .\` in the worktree.
If this task produced durable project-intrinsic knowledge, record it in \`AGENTS.md\` as part of your change.
Keep it proportionate: skip \`AGENTS.md\` edits for trivial tasks that produced no durable project knowledge.

$DOD
EOF
echo "scaffolded: $BRIEF (ship, mode=$MODE; replace {TASK})"
