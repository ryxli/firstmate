#!/usr/bin/env bash
set -eu
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fm-health-test.XXXXXX")"
mkdir -p "$TMP/bin" "$TMP/fake-sbin" "$TMP/home/data" "$TMP/home/state" "$TMP/home/config" "$TMP/home/projects" "$TMP/mate/data" "$TMP/mate/state" "$TMP/mate/config" "$TMP/mate/projects" "$TMP/mate/bin" "$TMP/mate/.omp/extensions" "$TMP/legacy/data"
ln -s "$ROOT/sbin" "$TMP/mate/sbin"
printf 'mate\n' >"$TMP/mate/.fm-secondmate-home"
for entry in "$ROOT/.omp/extensions"/*; do
  [ -e "$entry" ] || continue
  ln -s "$entry" "$TMP/mate/.omp/extensions/$(basename "$entry")"
done
rm "$TMP/mate/.omp/extensions/dispatch-guard.ts"
touch "$TMP/mate/.omp/extensions/dispatch-guard.ts"
ln -s "$ROOT/.omp" "$TMP/legacy/.omp"
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
- current - current mate (home: $TMP/mate; workspace: w1)
- legacy - legacy mate (home: $TMP/legacy; workspace: w2)
EOF
# The registry homes intentionally exercise the current-layout and legacy-layout branches.
run() {
  PATH="$TMP/bin:$PATH" FM_HOME="$TMP/home" FM_DATA_OVERRIDE="$TMP/home/data" \
    FM_HEALTH_SCRIPT_DIR="$TMP/fake-sbin" FM_HEALTH_TIMEOUT=2 "$ROOT/sbin/fm-health.sh" "$@"
}
run >"$TMP/pass.out"
grep -q $'^home:current\tok\tchecked$' "$TMP/pass.out"
grep -q $'^home:legacy\tok\tchecked$' "$TMP/pass.out"
grep -q $'^overall\tok\tall checks passed$' "$TMP/pass.out"
if FM_HEALTH_TEST_FAIL_HOME=1 run >"$TMP/fail.out"; then
  echo "failure scenario unexpectedly passed" >&2; exit 1
fi
grep -q $'^home:legacy\tfail\tblocked$' "$TMP/fail.out"
grep -q $'^overall\tfail\trequired check failed$' "$TMP/fail.out"
printf 'fm-health: current-layout, legacy-layout, pass, and failure scenarios passed\n'
