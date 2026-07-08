#!/usr/bin/env bash
# Dry-run, execute, and rollback migration tool for symlink-backed secondmate homes.
set -eu

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/fm-root-lib.sh
. "$SCRIPT_DIR/fm-root-lib.sh"
fm_init_roots "${BASH_SOURCE[0]}"
# shellcheck source=bin/fm-herdr-lib.sh
. "$SCRIPT_DIR/fm-herdr-lib.sh"

SUB_HOME_MARKER=.fm-secondmate-home
REG="$DATA/secondmates.md"
TIMESTAMP=${FM_MIGRATION_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
EXECUTE=0
STOP_LIVE=0
ALLOW_ACTIVE_CHILDREN=0
RESPAWN=0
FORCE_FRESH_SESSION=${FM_MIGRATION_FRESH_SESSION:-${FM_MIGRATION_FORCE_FRESH_SESSION:-0}}
OMP_SESSION_STORE="${FM_OMP_SESSION_STORE:-${HOME:-}/.omp/agent/sessions}"
ALL=0
ID=

usage() {
  echo "usage: fm-mate-home-migrate.sh <id> [--dry-run]" >&2
  echo "       fm-mate-home-migrate.sh <id> --execute --stop-live [--respawn] [--fresh-session]" >&2
  echo "       fm-mate-home-migrate.sh --all [--dry-run]" >&2
  echo "       fm-mate-home-migrate.sh --all --execute --stop-live [--respawn] [--fresh-session]" >&2
  echo "       fm-mate-home-migrate.sh rollback <id> <timestamp>" >&2
}

path_is_ancestor_of() {
  local ancestor=$1 path=$2
  [ -n "$ancestor" ] || return 1
  [ -n "$path" ] || return 1
  [ "$ancestor" != "$path" ] || return 1
  case "$path" in "$ancestor"/*) return 0 ;; esac
  return 1
}

safe_home_path() {
  local home=$1 abs_home abs_root abs_active
  [ -n "$home" ] || return 1
  abs_home=$(fm_normalize_path "$home")
  abs_root=$(fm_realpath_existing "$FM_ROOT")
  abs_active=$(fm_normalize_path "$FM_HOME")
  [ "$abs_home" != "/" ] || return 1
  [ "$abs_home" != "$abs_root" ] || return 1
  [ "$abs_home" != "$abs_active" ] || return 1
  path_is_ancestor_of "$abs_home" "$abs_root" && return 1
  path_is_ancestor_of "$abs_home" "$abs_active" && return 1
  path_is_ancestor_of "$abs_root" "$abs_home" && return 1
  path_is_ancestor_of "$abs_active" "$abs_home" && return 1
  return 0
}

registry_line_for_id() {
  local id=$1
  [ -f "$REG" ] || return 1
  awk -v id="$id" '$1=="-" && $2==id { line=$0 } END { if (line != "") print line; else exit 1 }' "$REG"
}

registry_ids() {
  [ -f "$REG" ] || return 1
  awk '$1=="-" { print $2 }' "$REG"
}

field_from_line() {
  local line=$1 field=$2
  if [ "$field" = added ]; then
    printf '%s\n' "$line" | sed -n 's/.*; added[[:space:]]*\([^)]*\)).*/\1/p' | sed 's/[[:space:]]*$//'
  else
    printf '%s\n' "$line" | sed -n "s/.*$field:[[:space:]]*\\([^;]*\\);.*/\\1/p" | sed 's/[[:space:]]*$//'
  fi
}

summary_from_line() {
  local line=$1
  printf '%s\n' "$line" | sed -n 's/^- [^ ][^ ]* - \(.*\) (home: .*/\1/p'
}

mate_name() {
  local id=$1 line=$2 name
  name=$(field_from_line "$line" name || true)
  [ -n "$name" ] || name=$(printf '%s' "$id" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')
  printf '%s\n' "$name"
}

mate_base() {
  if [ -n "${FM_HERDR_SM_BASE:-}" ]; then
    fm_normalize_path "$FM_HERDR_SM_BASE"
  else
    printf '%s/mates\n' "$(dirname "$(dirname "$(fm_realpath_existing "$FM_ROOT")")")"
  fi
}

meta_value() {
  local file=$1 key=$2
  [ -f "$file" ] || return 1
  sed -n "s/^$key=//p" "$file" | tail -1
}

migration_force_fresh_session() {
  case "$FORCE_FRESH_SESSION" in
    1|true|yes|on) return 0 ;;
    0|false|no|off|'') return 1 ;;
    *) return 1 ;;
  esac
}

session_id_from_store() {
  local cwd=$1 rel_cwd bucket store_path
  [ -n "$cwd" ] || return 0
  rel_cwd=$cwd
  if [ -n "${HOME:-}" ]; then
    case "$rel_cwd" in
      "$HOME"/*) rel_cwd="${rel_cwd#"$HOME"}" ;;
      "$HOME") rel_cwd="/" ;;
    esac
  fi
  bucket="${rel_cwd//\//-}"
  store_path="$OMP_SESSION_STORE/$bucket"
  [ -d "$store_path" ] || return 0
  python3 -c '
import os, re, sys
store = sys.argv[1]
try:
    files = [f for f in os.listdir(store) if f.endswith(".jsonl")]
    if files:
        newest = max(files, key=lambda f: os.path.getmtime(os.path.join(store, f)))
        stem = newest[:-6]
        sid = stem.split("_", 1)[1] if "_" in stem else stem
        if re.fullmatch(r"[0-9A-Za-z_-]+", sid or ""):
            print(sid)
except Exception:
    pass
' "$store_path" 2>/dev/null || true
}

session_id_from_pane() {
  local pane=$1
  [ -n "$pane" ] && [ "$pane" != none ] || return 0
  herdr pane read "$pane" --source recent --lines 120 2>/dev/null \
    | python3 -c 'import re,sys; t=sys.stdin.read(); m=re.search(r"omp --resume ([0-9A-Za-z_-]+)", t); print(m.group(1) if m else "")' \
      2>/dev/null || true
}

pane_cwd() {
  local pane=$1
  [ -n "$pane" ] && [ "$pane" != none ] || return 0
  herdr pane get "$pane" 2>/dev/null | herdr_json_get result pane cwd
}

resolve_omp_session_for_mate() {
  local pane=$1 home=$2 sid cwd
  sid=$(session_id_from_pane "$pane")
  [ -n "$sid" ] && { printf '%s\n' "$sid"; return 0; }
  cwd=$(pane_cwd "$pane" || true)
  if [ -n "$cwd" ]; then
    sid=$(session_id_from_store "$cwd")
    [ -n "$sid" ] && { printf '%s\n' "$sid"; return 0; }
  fi
  session_id_from_store "$home"
}

mate_respawn_harness() {
  local meta=$1 harness
  harness=$(meta_value "$meta" harness || true)
  [ -n "$harness" ] || harness=$(meta_value "$meta" agent_identity || true)
  printf '%s\n' "$harness"
}

home_mode() {
  local home=$1
  if git -C "$home" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf worktree
    return 0
  fi
  if "$FM_ROOT/bin/fm-home-link.sh" "$home" --check >/dev/null 2>&1; then
    printf symlink
    return 0
  fi
  printf invalid
}

operational_dirs_safe() {
  local home=$1 name dir abs_home abs_dir
  abs_home=$(fm_normalize_path "$home")
  for name in data state config projects; do
    dir="$home/$name"
    [ -d "$dir" ] || return 1
    abs_dir=$(cd -P "$dir" && pwd) || return 1
    [ "$abs_dir" = "$abs_home/$name" ] || path_is_ancestor_of "$abs_home" "$abs_dir" || return 1
  done
}

child_work_status() {
  local home=$1 meta found=0
  if [ -d "$home/state" ]; then
    for meta in "$home/state"/*.meta; do
      [ -f "$meta" ] || continue
      found=1
      break
    done
  fi
  if [ "$found" -eq 1 ]; then printf blocked; else printf none; fi
}

shared_code_wip_status() {
  local home=$1 mode=$2 out
  [ "$mode" = worktree ] || { printf none; return 0; }
  out=$(git -C "$home" status --porcelain -- AGENTS.md CLAUDE.md bin tests .agents .omp .tasks.toml 2>/dev/null || true)
  if [ -n "$out" ]; then printf saved-diff-required; else printf none; fi
}

local_artifacts_status() {
  local home=$1 found=0 f
  [ -e "$home/msg.md" ] && found=1
  [ -e "$home/web" ] && found=1
  for f in "$home"/*.png; do
    [ -e "$f" ] || continue
    found=1
    break
  done
  if [ "$found" -eq 1 ]; then printf archive-required; else printf none; fi
}

plan_values() {
  local id=$1 line name home workspace meta pane current_mode child shared artifacts target backup result marker
  if ! line=$(registry_line_for_id "$id"); then
    PLAN_RESULT=blocked:registry-missing
    PLAN_ID=$id
    return 1
  fi
  name=$(mate_name "$id" "$line")
  home=$(field_from_line "$line" home || true)
  workspace=$(field_from_line "$line" workspace || true)
  [ -n "$workspace" ] || workspace=missing
  meta="$STATE/$id.meta"
  pane=$(meta_value "$meta" pane || true)
  [ -n "$pane" ] || pane=none
  target="$(mate_base)/$id"
  backup="$DATA/migration-local-files/$TIMESTAMP/$id"
  result=ready

  if [ -z "$home" ]; then
    current_mode=invalid; child=none; shared=blocked; artifacts=none; result=blocked:registry-home-missing
  elif [ ! -d "$home" ]; then
    current_mode=invalid; child=none; shared=blocked; artifacts=none; result=blocked:home-missing
  else
    current_mode=$(home_mode "$home")
    child=$(child_work_status "$home")
    shared=$(shared_code_wip_status "$home" "$current_mode")
    artifacts=$(local_artifacts_status "$home")
    if [ -L "$home/$SUB_HOME_MARKER" ] || [ ! -f "$home/$SUB_HOME_MARKER" ]; then
      result=blocked:marker-missing
    else
      marker=$(cat "$home/$SUB_HOME_MARKER" 2>/dev/null || true)
      [ "$marker" = "$id" ] || result=blocked:marker-wrong
    fi
    if [ "$result" = ready ] && ! operational_dirs_safe "$home"; then result=blocked:operational-dir-escapes-home; fi
    if [ "$result" = ready ] && [ "$child" = blocked ] && [ "$ALLOW_ACTIVE_CHILDREN" -ne 1 ]; then result=blocked:active-child-work; fi
    if [ "$result" = ready ] && [ "$pane" != none ] && [ "$STOP_LIVE" -ne 1 ]; then result=blocked:live-pane; fi
    if [ "$result" = ready ] && [ "$shared" = blocked ]; then result=blocked:shared-code-wip; fi
    if [ "$result" = ready ] && [ "$current_mode" = invalid ]; then result=blocked:invalid-home-mode; fi
    if [ "$result" = ready ] && ! safe_home_path "$target"; then result=blocked:unsafe-target-home; fi
  fi

  PLAN_ID=$id
  PLAN_LINE=$line
  PLAN_NAME=$name
  PLAN_HOME=${home:-missing}
  PLAN_MODE=$current_mode
  PLAN_WORKSPACE=$workspace
  PLAN_META=$meta
  PLAN_PANE=$pane
  PLAN_CHILD=$child
  PLAN_SHARED=$shared
  PLAN_ARTIFACTS=$artifacts
  PLAN_TARGET=$target
  PLAN_BACKUP=$backup
  PLAN_RESULT=$result
  [ "$result" = ready ]
}

print_plan_current() {
  printf 'mate=%s\n' "$PLAN_ID"
  printf 'name=%s\n' "$PLAN_NAME"
  printf 'current_home=%s\n' "$PLAN_HOME"
  printf 'current_mode=%s\n' "$PLAN_MODE"
  printf 'workspace=%s\n' "$PLAN_WORKSPACE"
  printf 'live_pane=%s\n' "$PLAN_PANE"
  printf 'child_work=%s\n' "$PLAN_CHILD"
  printf 'shared_code_wip=%s\n' "$PLAN_SHARED"
  printf 'local_artifacts=%s\n' "$PLAN_ARTIFACTS"
  printf 'target_home=%s\n' "$PLAN_TARGET"
  printf 'backup_home=%s\n' "$PLAN_BACKUP"
  printf 'result=%s\n' "$PLAN_RESULT"
}

print_mate_plan() {
  plan_values "$1" || true
  print_plan_current
  [ "$PLAN_RESULT" = ready ]
}

herdr_workspace_id_for_label_cwd() {
  local label=$1 cwd=$2
  herdr workspace list 2>/dev/null | python3 -c '
import json, os, sys
label, cwd = sys.argv[1], os.path.realpath(sys.argv[2])
try:
    workspaces = json.load(sys.stdin).get("result", {}).get("workspaces", [])
except Exception:
    sys.exit(0)
for w in workspaces:
    if w.get("label") != label:
        continue
    wsid = w.get("workspace_id", "")
    wcwd = w.get("cwd") or w.get("checkout_path") or w.get("path") or w.get("worktree", {}).get("checkout_path", "")
    if wcwd and os.path.realpath(wcwd) == cwd:
        print(wsid)
    else:
        print("mismatch:" + wsid + ":" + (wcwd or "missing"))
    break
' "$label" "$cwd" 2>/dev/null || true
}

resolve_workspace() {
  local label=$1 home=$2 existing json workspace_id
  existing=$(herdr_workspace_id_for_label_cwd "$label" "$home")
  case "$existing" in
    mismatch:*) echo "error: herdr workspace label '$label' already exists with a different cwd (${existing#mismatch:})" >&2; return 1 ;;
    ?*) printf '%s\n' "$existing"; return 0 ;;
  esac
  json=$(herdr workspace create --label "$label" --cwd "$home" --no-focus 2>&1) || {
    echo "error: herdr workspace create failed for $home" >&2
    echo "$json" >&2
    return 1
  }
  workspace_id=$(printf '%s' "$json" | herdr_json_get result workspace workspace_id)
  [ -n "$workspace_id" ] || workspace_id=$(herdr_workspace_id_for_label_cwd "$label" "$home")
  [ -n "$workspace_id" ] || { echo "error: herdr workspace create did not return a workspace_id" >&2; return 1; }
  printf '%s\n' "$workspace_id"
}

copy_dir_contents() {
  local src=$1 dst=$2
  mkdir -p "$dst"
  if [ -d "$src" ]; then
    cp -R "$src/." "$dst/"
  fi
}

safe_remove_path() {
  local path=$1 abs
  safe_home_path "$path" || return 1
  abs=$(fm_normalize_path "$path")
  rm -rf -- "$abs"
}

write_registry_line() {
  local id=$1 line=$2 home=$3 workspace=$4 name=$5 tmp summary scope projects added
  summary=$(summary_from_line "$line")
  [ -n "$summary" ] || summary="migrated secondmate"
  scope=$(field_from_line "$line" scope || true)
  [ -n "$scope" ] || scope="unspecified"
  projects=$(field_from_line "$line" projects || true)
  [ -n "$projects" ] || projects="(none)"
  added=$(field_from_line "$line" added || true)
  [ -n "$added" ] || added=$(date +%F)
  tmp="$REG.tmp.$$"
  if [ -f "$REG" ]; then
    awk -v id="$id" '!($1=="-" && $2==id)' "$REG" > "$tmp"
  else
    : > "$tmp"
  fi
  printf -- '- %s - %s (home: %s; workspace: %s; name: %s; scope: %s; projects: %s; added %s)\n' \
    "$id" "$summary" "$home" "$workspace" "$name" "$scope" "$projects" "$added" >> "$tmp"
  mv "$tmp" "$REG"
}

update_meta_after_migration() {
  local id=$1 home=$2 workspace_label=$3 tmp
  mkdir -p "$STATE"
  tmp="$STATE/$id.meta.tmp.$$"
  if [ -f "$STATE/$id.meta" ]; then
    awk -F= '$1!="pane" && $1!="tab" && $1!="home" && $1!="worktree" && $1!="project" && $1!="workspace" { print }' "$STATE/$id.meta" > "$tmp"
  else
    : > "$tmp"
    printf 'kind=secondmate\nmode=secondmate\n' >> "$tmp"
  fi
  {
    printf 'worktree=%s\n' "$home"
    printf 'project=%s\n' "$home"
    printf 'workspace=%s\n' "$workspace_label"
    printf 'home=%s\n' "$home"
  } >> "$tmp"
  mv "$tmp" "$STATE/$id.meta"
}

backup_preflight() {
  local backup=$1 id=$2 home=$3 mode=$4 meta=$5 f
  mkdir -p "$backup/operational" "$backup/snapshots"
  {
    printf 'id=%s\n' "$id"
    printf 'timestamp=%s\n' "$TIMESTAMP"
    printf 'home=%s\n' "$home"
    printf 'mode=%s\n' "$mode"
  } > "$backup/manifest"
  cp "$REG" "$backup/registry.before"
  if [ -f "$meta" ]; then cp "$meta" "$backup/meta.before"; else : > "$backup/meta.missing"; fi
  ( cd "$home" && find . -maxdepth 2 -mindepth 1 -print | sort ) > "$backup/snapshots/home-listing.txt"
  if [ "$mode" = worktree ]; then
    git -C "$home" rev-parse HEAD > "$backup/snapshots/git-head.txt" 2>/dev/null || true
    git -C "$home" status --porcelain > "$backup/snapshots/git-status.txt" 2>/dev/null || true
    git -C "$home" diff -- AGENTS.md CLAUDE.md bin tests .agents .omp .tasks.toml > "$backup/shared-code.diff" 2>/dev/null || true
    git -C "$home" status --porcelain -- AGENTS.md CLAUDE.md bin tests .agents .omp .tasks.toml > "$backup/shared-code.status" 2>/dev/null || true
  fi
  for f in data state config projects; do
    copy_dir_contents "$home/$f" "$backup/operational/$f"
  done
  if [ -e "$home/msg.md" ]; then cp "$home/msg.md" "$backup/msg.md"; fi
  mkdir -p "$backup/screenshots"
  for f in "$home"/*.png; do [ -e "$f" ] && cp "$f" "$backup/screenshots/"; done
  if [ -e "$home/web" ]; then cp -R "$home/web" "$backup/web"; fi
  cp -R "$home" "$backup/old-home"
}

stop_live_pane() {
  local pane=$1 out
  [ -n "$pane" ] && [ "$pane" != none ] || return 0
  out=$(herdr pane close "$pane" 2>&1) && return 0
  printf '%s\n' "$out" | grep -q 'pane_not_found' && return 0
  return 1
}
release_old_home() {
  local home=$1 mode=$2 workspace=$3 out
  if [ "$mode" = symlink ]; then
    safe_remove_path "$home"
    return
  fi
  if [ "$workspace" != missing ]; then
    out=$(herdr worktree remove --workspace "$workspace" --force 2>&1) || {
      printf '%s\n' "$out" | grep -q 'workspace_not_found' || return 1
    }
    [ ! -e "$home" ] || safe_remove_path "$home"
  else
    safe_remove_path "$home"
  fi
}

restore_operational_dirs() {
  local backup=$1 home=$2 d
  mkdir -p "$home"
  for d in data state config projects; do
    mkdir -p "$home/$d"
    copy_dir_contents "$backup/operational/$d" "$home/$d"
  done
}

rollback_from_backup() {
  local id=$1 backup=$2 home failed
  [ -d "$backup" ] || return 1
  home=$(sed -n 's/^home=//p' "$backup/manifest" | tail -1)
  [ -n "$home" ] || return 1
  failed="$(dirname "$home")/.failed/$id-$TIMESTAMP"
  if [ -e "$home" ]; then
    mkdir -p "$(dirname "$failed")"
    mv "$home" "$failed"
  fi
  if [ -d "$backup/old-home" ]; then
    mkdir -p "$(dirname "$home")"
    mv "$backup/old-home" "$home"
  fi
  if [ -f "$backup/registry.before" ]; then
    mkdir -p "$(dirname "$REG")"
    cp "$backup/registry.before" "$REG"
  fi
  if [ -f "$backup/meta.before" ]; then
    mkdir -p "$STATE"
    cp "$backup/meta.before" "$STATE/$id.meta"
  elif [ -f "$backup/meta.missing" ]; then
    rm -f "$STATE/$id.meta"
  fi
}

execute_mate() {
  local id=$1 backup home target workspace_id meta pane mode workspace name respawn_harness resume_session spawn_out need_resume
  if ! plan_values "$id"; then
    print_plan_current
    return 1
  fi
  print_plan_current
  home=$PLAN_HOME
  target=$PLAN_TARGET
  backup=$PLAN_BACKUP
  meta=$PLAN_META
  pane=$PLAN_PANE
  mode=$PLAN_MODE
  workspace=$PLAN_WORKSPACE
  name=$PLAN_NAME

  if [ "$(fm_normalize_path "$home")" != "$(fm_normalize_path "$target")" ]; then
    printf 'execute=blocked:target-home-mismatch\n'
    return 1
  fi
  if [ -e "$backup" ]; then
    printf 'execute=blocked:backup-exists\n'
    return 1
  fi
  respawn_harness=$(mate_respawn_harness "$meta")
  resume_session=
  need_resume=0
  if [ "$RESPAWN" -eq 1 ] && ! migration_force_fresh_session; then
    case "$respawn_harness" in
      omp) need_resume=1 ;;
      '') [ "$pane" = none ] || need_resume=1 ;;
    esac
  fi
  if [ "$need_resume" -eq 1 ]; then
    resume_session=$(resolve_omp_session_for_mate "$pane" "$home")
    if [ -z "$resume_session" ]; then
      printf 'respawn=blocked:omp-session-missing\n'
      printf 'execute=blocked:omp-session-missing\n'
      return 1
    fi
    printf 'respawn_session=%s\n' "$resume_session"
  fi
  if ! backup_preflight "$backup" "$id" "$home" "$mode" "$meta"; then
    printf 'execute=blocked:backup-cannot-be-written\n'
    return 1
  fi
  printf 'backup=written\n'

  if ! stop_live_pane "$pane"; then
    printf 'execute=blocked:pane-refused-exit\n'
    return 1
  fi

  if ! release_old_home "$home" "$mode" "$workspace"; then
    printf 'execute=blocked:old-home-release-failed\n'
    return 1
  fi

  if ! restore_operational_dirs "$backup" "$target"; then
    rollback_from_backup "$id" "$backup" || true
    printf 'execute=rolled-back:operational-restore-failed\n'
    return 1
  fi
  printf '%s\n' "$id" > "$target/$SUB_HOME_MARKER" || {
    rollback_from_backup "$id" "$backup" || true
    printf 'execute=rolled-back:marker-write-failed\n'
    return 1
  }
  if ! "$FM_ROOT/bin/fm-home-link.sh" "$target" --repair >/dev/null; then
    rollback_from_backup "$id" "$backup" || true
    printf 'execute=rolled-back:link-repair-failed\n'
    return 1
  fi
  workspace_id=$(resolve_workspace "$name" "$target") || {
    rollback_from_backup "$id" "$backup" || true
    printf 'execute=rolled-back:workspace-failed\n'
    return 1
  }
  write_registry_line "$id" "$PLAN_LINE" "$target" "$workspace_id" "$name" || {
    rollback_from_backup "$id" "$backup" || true
    printf 'execute=rolled-back:registry-write-failed\n'
    return 1
  }
  update_meta_after_migration "$id" "$target" "$name" || {
    rollback_from_backup "$id" "$backup" || true
    printf 'execute=rolled-back:meta-write-failed\n'
    return 1
  }
  if ! "$FM_ROOT/bin/fm-home-link.sh" "$target" --check >/dev/null; then
    rollback_from_backup "$id" "$backup" || true
    printf 'execute=rolled-back:validation-failed\n'
    return 1
  fi
  if [ "$RESPAWN" -eq 1 ]; then
    if [ -n "$resume_session" ]; then
      spawn_out=$("$FM_ROOT/bin/fm-spawn.sh" "$id" "omp --auto-approve --resume $resume_session" --secondmate 2>&1) || {
        printf '%s\n' "$spawn_out" >&2
        rollback_from_backup "$id" "$backup" || true
        printf 'execute=rolled-back:respawn-failed\n'
        return 1
      }
    else
      spawn_out=$("$FM_ROOT/bin/fm-spawn.sh" "$id" --secondmate 2>&1) || {
        printf '%s\n' "$spawn_out" >&2
        rollback_from_backup "$id" "$backup" || true
        printf 'execute=rolled-back:respawn-failed\n'
        return 1
      }
    fi
    printf 'respawn=ok\n'
  fi
  printf 'workspace=%s\n' "$workspace_id"
  printf 'execute=ok\n'
}

rollback() {
  local id=$1 ts=$2 backup home pane failed
  backup="$DATA/migration-local-files/$ts/$id"
  printf 'mate=%s\n' "$id"
  printf 'timestamp=%s\n' "$ts"
  printf 'backup_home=%s\n' "$backup"
  if [ ! -d "$backup" ]; then
    printf 'result=blocked:backup-missing\n'
    return 1
  fi
  pane=$(meta_value "$STATE/$id.meta" pane || true)
  if [ -n "$pane" ]; then herdr pane close "$pane" >/dev/null 2>&1 || true; fi
  home=$(sed -n 's/^home=//p' "$backup/manifest" | tail -1)
  [ -n "$home" ] || { printf 'result=blocked:backup-home-missing\n'; return 1; }
  failed="$(dirname "$home")/.failed/$id-$ts"
  if [ -e "$home" ]; then
    mkdir -p "$(dirname "$failed")"
    mv "$home" "$failed"
  fi
  if [ -d "$backup/old-home" ]; then
    mkdir -p "$(dirname "$home")"
    mv "$backup/old-home" "$home"
  else
    mkdir -p "$home"
    restore_operational_dirs "$backup" "$home" || { printf 'result=blocked:operational-restore-failed\n'; return 1; }
  fi
  cp "$backup/registry.before" "$REG"
  if [ -f "$backup/meta.before" ]; then
    mkdir -p "$STATE"
    cp "$backup/meta.before" "$STATE/$id.meta"
  else
    rm -f "$STATE/$id.meta"
  fi
  if [ ! -f "$home/$SUB_HOME_MARKER" ]; then
    printf 'result=blocked:marker-missing-after-rollback\n'
    return 1
  fi
  printf 'failed_home=%s\n' "$failed"
  printf 'result=rolled-back\n'
}

case "${1:-}" in
  rollback)
    [ $# -eq 3 ] || { usage; exit 1; }
    rollback "$2" "$3"
    exit $?
    ;;
  -h|--help|'') usage; exit 0 ;;
  --all) ALL=1; shift ;;
  *) ID=$1; shift ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) EXECUTE=0 ;;
    --execute) EXECUTE=1 ;;
    --stop-live) STOP_LIVE=1 ;;
    --allow-active-children) ALLOW_ACTIVE_CHILDREN=1 ;;
    --respawn) RESPAWN=1 ;;
    --fresh-session|--force-fresh-session) FORCE_FRESH_SESSION=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
  shift
done
case "$FORCE_FRESH_SESSION" in
  1|true|yes|on|0|false|no|off|'') ;;
  *) echo "error: FM_MIGRATION_FRESH_SESSION/--fresh-session must be 0 or 1" >&2; exit 1 ;;
esac

rc=0
if [ "$ALL" -eq 1 ]; then
  [ -f "$REG" ] || { echo 'result=blocked:registry-missing'; exit 1; }
  for mate_id in $(registry_ids); do
    if [ "$EXECUTE" -eq 1 ]; then execute_mate "$mate_id" || rc=1; else print_mate_plan "$mate_id" || rc=1; fi
  done
else
  [ -n "$ID" ] || { usage; exit 1; }
  if [ "$EXECUTE" -eq 1 ]; then execute_mate "$ID" || rc=1; else print_mate_plan "$ID" || rc=1; fi
fi
exit "$rc"
