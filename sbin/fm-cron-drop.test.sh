#!/usr/bin/env bash
# Regression tests for per-home cron drop management.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-cron-drop-tests.XXXXXX")
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

FM_HOME="$TMP_ROOT/home" FM_STATE_OVERRIDE="$TMP_ROOT/home/state" HOME="$TMP_ROOT/user" "$SCRIPT_DIR/fm-cron-drop.py" list >"$TMP_ROOT/list-empty.out"
case "$(cat "$TMP_ROOT/list-empty.out")" in
  *"cron-drop: no drops"*) pass "empty list" ;;
  *) cat "$TMP_ROOT/list-empty.out" >&2; fail "empty list" ;;
esac

FM_HOME="$TMP_ROOT/home" FM_STATE_OVERRIDE="$TMP_ROOT/home/state" HOME="$TMP_ROOT/user" "$SCRIPT_DIR/fm-cron-drop.py" mode daily >"$TMP_ROOT/mode-daily.out"
[ -f "$TMP_ROOT/home/state/cron.d/cost-daily-refresh.json" ] || fail "daily drop missing"
[ -f "$TMP_ROOT/home/state/cron.d/cost-derived-refresh.json" ] || fail "derived drop missing"
case "$(cat "$TMP_ROOT/mode-daily.out")" in
  *"mode: daily"*"cost-daily-refresh: enabled"*"cost-derived-refresh: enabled"*) pass "daily mode writes drops" ;;
  *) cat "$TMP_ROOT/mode-daily.out" >&2; fail "daily mode output" ;;
esac

FM_HOME="$TMP_ROOT/home" FM_STATE_OVERRIDE="$TMP_ROOT/home/state" HOME="$TMP_ROOT/user" "$SCRIPT_DIR/fm-cron-drop.py" list >"$TMP_ROOT/list-remembered.out"
case "$(cat "$TMP_ROOT/list-remembered.out")" in
  *"cost-daily-refresh: enabled"*"cost-derived-refresh: enabled"*"watch 3 path(s)"*) pass "same home remembers drops" ;;
  *) cat "$TMP_ROOT/list-remembered.out" >&2; fail "same home remembers drops" ;;
esac

FM_HOME="$TMP_ROOT/other-home" FM_STATE_OVERRIDE="$TMP_ROOT/other-home/state" HOME="$TMP_ROOT/user" "$SCRIPT_DIR/fm-cron-drop.py" list >"$TMP_ROOT/list-forgotten.out"
case "$(cat "$TMP_ROOT/list-forgotten.out")" in
  *"cron-drop: no drops"*) pass "different home forgets drops" ;;
  *) cat "$TMP_ROOT/list-forgotten.out" >&2; fail "different home forgets drops" ;;
esac


FM_HOME="$TMP_ROOT/home" FM_STATE_OVERRIDE="$TMP_ROOT/home/state" HOME="$TMP_ROOT/user" "$SCRIPT_DIR/fm-cron-drop.py" reconcile --dry-run >"$TMP_ROOT/reconcile.out"
case "$(cat "$TMP_ROOT/reconcile.out")" in
  *"dry-run: write"*"launchctl bootstrap"*"skip: cost-derived-refresh kind=watch"*) pass "dry-run reconcile" ;;
  *) cat "$TMP_ROOT/reconcile.out" >&2; fail "dry-run reconcile" ;;
esac

FM_HOME="$TMP_ROOT/home" FM_STATE_OVERRIDE="$TMP_ROOT/home/state" HOME="$TMP_ROOT/user" "$SCRIPT_DIR/fm-cron-drop.py" mode off >"$TMP_ROOT/mode-off.out"
case "$(cat "$TMP_ROOT/mode-off.out")" in
  *"mode: off"*"cost-daily-refresh: disabled"*"cost-derived-refresh: disabled"*) pass "off mode disables drops" ;;
  *) cat "$TMP_ROOT/mode-off.out" >&2; fail "off mode output" ;;
esac

FM_HOME="$TMP_ROOT/home" FM_STATE_OVERRIDE="$TMP_ROOT/home/state" HOME="$TMP_ROOT/user" "$SCRIPT_DIR/fm-cron-drop.py" reconcile --dry-run >"$TMP_ROOT/reconcile-disabled.out"
case "$(cat "$TMP_ROOT/reconcile-disabled.out")" in
  *"dry-run: remove"*"disabled: cost-daily-refresh"*) pass "disabled reconcile removes plist" ;;
  *) cat "$TMP_ROOT/reconcile-disabled.out" >&2; fail "disabled reconcile removes plist" ;;
esac

mkdir -p "$TMP_ROOT/bad/state/cron.d"
cat >"$TMP_ROOT/bad/state/cron.d/bad.json" <<'JSON'
{
  "id": "bad",
  "enabled": true,
  "kind": "daily",
  "schedule": {"type": "daily", "hour": 9, "minute": 15},
  "command": ["relative-command"]
}
JSON
if FM_HOME="$TMP_ROOT/bad" FM_STATE_OVERRIDE="$TMP_ROOT/bad/state" HOME="$TMP_ROOT/user" "$SCRIPT_DIR/fm-cron-drop.py" list >"$TMP_ROOT/bad.out" 2>"$TMP_ROOT/bad.err"; then
  fail "relative command rejected"
fi
case "$(cat "$TMP_ROOT/bad.err")" in
  *"command[0] must be an absolute path"*) pass "relative command rejected" ;;
  *) cat "$TMP_ROOT/bad.err" >&2; fail "relative command error" ;;
esac
