#!/usr/bin/env bash
set -eu
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fm-health-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/fake-sbin" "$TMP/home/data" "$TMP/mate/data"
cat >"$TMP/bin/herdr" <<'EOF'
#!/usr/bin/env bash
printf 'status: running\n'
EOF
cat >"$TMP/fake-sbin/fm-capture-status.sh" <<'EOF'
#!/usr/bin/env bash
printf 'fleet_hook\tpresent\nsupervisor_auto\tlive\n'
EOF
cat >"$TMP/fake-sbin/fm-panes.sh" <<'EOF'
#!/usr/bin/env bash
printf 'firstmate\tidle\tp1\n'
EOF
cat >"$TMP/fake-sbin/fm-home-link.sh" <<'EOF'
#!/usr/bin/env bash
if [ "${FM_HEALTH_TEST_FAIL_HOME:-}" = 1 ]; then printf 'result=blocked\n'; exit 1; fi
printf 'result=ok\n'
EOF
chmod +x "$TMP/bin/herdr" "$TMP/fake-sbin"/*.sh
cat >"$TMP/home/data/secondmates.md" <<EOF
- mate - test mate (home: $TMP/mate; workspace: w1)
EOF
run() {
  PATH="$TMP/bin:$PATH" FM_HOME="$TMP/home" FM_DATA_OVERRIDE="$TMP/home/data" \
    FM_HEALTH_SCRIPT_DIR="$TMP/fake-sbin" FM_HEALTH_TIMEOUT=2 "$ROOT/sbin/fm-health.sh" "$@"
}
run >"$TMP/pass.out"
expected=$'herdr\tok\trunning\ncapture\tok\thook=present supervisor=live\nroster\tok\tpanes=1\nhome:mate\tok\tchecked\noverall\tok\tall checks passed'
[ "$(cat "$TMP/pass.out")" = "$expected" ] || { cat "$TMP/pass.out" >&2; exit 1; }
if FM_HEALTH_TEST_FAIL_HOME=1 run >"$TMP/fail.out"; then
  echo "failure scenario unexpectedly passed" >&2; exit 1
fi
grep -q $'^home:mate\tfail\tblocked$' "$TMP/fail.out"
grep -q $'^overall\tfail\trequired check failed$' "$TMP/fail.out"
printf 'fm-health: pass and failure scenarios passed\n'
