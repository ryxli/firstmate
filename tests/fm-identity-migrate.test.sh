#!/usr/bin/env bash
# Behavior tests for fm-identity-migrate.sh: check and migrate commands.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

cleanup() {
  [ -n "${TMP_ROOT:-}" ] && rm -rf "$TMP_ROOT"
}

trap cleanup EXIT
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fm-identity-migrate-tests.XXXXXX")

MIGRATE="$ROOT/bin/fm-identity-migrate.sh"

# Build a minimal registry and home structure for tests.
make_home() {
  local home=$1
  mkdir -p "$home/config" "$home/data" "$home/state"
}

write_marker() {
  local home=$1 id=$2
  printf '%s\n' "$id" > "$home/.fm-secondmate-home"
}

write_identity() {
  local home=$1 text=$2
  printf '%b\n' "$text" > "$home/config/identity"
}

make_registry() {
  local reg=$1; shift
  # Each arg: "id:home:summary"
  printf '# Secondmates\n\n' > "$reg"
  while [ $# -gt 0 ]; do
    local entry="$1"; shift
    local id="${entry%%:*}"
    local rest="${entry#*:}"
    local home="${rest%%:*}"
    local summary="${rest#*:}"
    printf -- '- %s - %s (home: %s; scope: test; projects: none; added 2026-07-10)\n' \
      "$id" "$summary" "$home" >> "$reg"
  done
}

# -------------------------------------------------------------------------
# check: all versioned -> exit 0 + all OK
# -------------------------------------------------------------------------
test_check_all_versioned_exits_0() {
  local home1="$TMP_ROOT/check-ver-home1"
  local home2="$TMP_ROOT/check-ver-home2"
  local reg="$TMP_ROOT/check-ver/secondmates.md"
  mkdir -p "$(dirname "$reg")"
  make_home "$home1"; make_home "$home2"
  write_marker "$home1" alpha
  write_marker "$home2" beta
  write_identity "$home1" "schema_version=1\nname=Alpha\nrole=Alpha role"
  write_identity "$home2" "schema_version=1\nname=Beta\nrole=Beta role"
  make_registry "$reg" "alpha:$home1:Alpha summary" "beta:$home2:Beta summary"

  local out
  out=$(FM_DATA_OVERRIDE="$(dirname "$reg")" "$MIGRATE" check) \
    || fail "check exited non-zero for all-versioned registry"
  printf '%s\n' "$out" | grep -F "OK" | grep -F "alpha" >/dev/null \
    || fail "check did not emit OK for alpha"
  printf '%s\n' "$out" | grep -F "OK" | grep -F "beta" >/dev/null \
    || fail "check did not emit OK for beta"
  pass "check exits 0 when all homes are versioned"
}

# -------------------------------------------------------------------------
# check: unversioned identity -> exit 1 + UNRESOLVED
# -------------------------------------------------------------------------
test_check_unversioned_exits_1() {
  local home="$TMP_ROOT/check-unver-home"
  local reg="$TMP_ROOT/check-unver/secondmates.md"
  mkdir -p "$(dirname "$reg")"
  make_home "$home"
  write_marker "$home" fran
  write_identity "$home" "name=Fran\nrole=Some role"
  make_registry "$reg" "fran:$home:Schwarzwald domain expert"

  local out rc=0
  out=$(FM_DATA_OVERRIDE="$(dirname "$reg")" "$MIGRATE" check) || rc=$?
  [ "$rc" = 1 ] || fail "check did not exit 1 for unversioned identity"
  printf '%s\n' "$out" | grep -F "UNRESOLVED" | grep -F "fran" >/dev/null \
    || fail "check did not emit UNRESOLVED for fran"
  printf '%s\n' "$out" | grep "unversioned" >/dev/null \
    || fail "check reason was not 'unversioned'"
  pass "check exits 1 and emits UNRESOLVED for unversioned identity"
}

# -------------------------------------------------------------------------
# check: no identity file -> exit 1 + UNRESOLVED no-identity
# -------------------------------------------------------------------------
test_check_no_identity_exits_1() {
  local home="$TMP_ROOT/check-noid-home"
  local reg="$TMP_ROOT/check-noid/secondmates.md"
  mkdir -p "$(dirname "$reg")"
  make_home "$home"
  write_marker "$home" riggs
  # no identity file
  make_registry "$reg" "riggs:$home:Harness mate"

  local out rc=0
  out=$(FM_DATA_OVERRIDE="$(dirname "$reg")" "$MIGRATE" check) || rc=$?
  [ "$rc" = 1 ] || fail "check did not exit 1 for marker-only home"
  printf '%s\n' "$out" | grep -F "UNRESOLVED" | grep -F "riggs" >/dev/null \
    || fail "check did not emit UNRESOLVED for riggs"
  printf '%s\n' "$out" | grep "no-identity" >/dev/null \
    || fail "check reason was not 'no-identity'"
  pass "check exits 1 and emits UNRESOLVED for marker-only home"
}

# -------------------------------------------------------------------------
# check: no marker file -> exit 1 + UNRESOLVED no-marker
# -------------------------------------------------------------------------
test_check_no_marker_exits_1() {
  local home="$TMP_ROOT/check-nomark-home"
  local reg="$TMP_ROOT/check-nomark/secondmates.md"
  mkdir -p "$(dirname "$reg")"
  make_home "$home"
  # no marker
  write_identity "$home" "schema_version=1\nname=Atlas\nrole=GPU"
  make_registry "$reg" "atlas:$home:GPU specialist"

  local out rc=0
  out=$(FM_DATA_OVERRIDE="$(dirname "$reg")" "$MIGRATE" check) || rc=$?
  [ "$rc" = 1 ] || fail "check did not exit 1 for home with no marker"
  printf '%s\n' "$out" | grep -F "UNRESOLVED" | grep -F "atlas" >/dev/null \
    || fail "check did not emit UNRESOLVED for atlas"
  pass "check exits 1 and emits UNRESOLVED for home without marker"
}

# -------------------------------------------------------------------------
# migrate: unversioned identity -> adds schema_version=1, emits MIGRATED
# -------------------------------------------------------------------------
test_migrate_unversioned_adds_schema_version() {
  local home="$TMP_ROOT/mig-unver-home"
  local reg="$TMP_ROOT/mig-unver/secondmates.md"
  mkdir -p "$(dirname "$reg")"
  make_home "$home"
  write_marker "$home" fran
  printf 'name=Fran\nrole=Schwarzwald domain expert\n' > "$home/config/identity"
  make_registry "$reg" "fran:$home:Schwarzwald domain expert"

  local out
  out=$(FM_DATA_OVERRIDE="$(dirname "$reg")" "$MIGRATE" migrate) \
    || fail "migrate exited non-zero for unversioned home"
  printf '%s\n' "$out" | grep -F "MIGRATED" | grep -F "fran" >/dev/null \
    || fail "migrate did not emit MIGRATED for fran"
  grep -F 'schema_version=1' "$home/config/identity" >/dev/null \
    || fail "config/identity does not contain schema_version=1 after migration"
  grep -F 'name=Fran' "$home/config/identity" >/dev/null \
    || fail "migration removed name= field"
  grep -F 'role=Schwarzwald domain expert' "$home/config/identity" >/dev/null \
    || fail "migration removed role= field"
  # schema_version= must appear exactly once
  local sv_count
  sv_count=$(grep -c '^schema_version=' "$home/config/identity")
  [ "$sv_count" = 1 ] || fail "schema_version appears $sv_count times after migration (expected 1)"
  pass "migrate adds schema_version=1 to unversioned identity, preserving fields"
}

# -------------------------------------------------------------------------
# migrate --dry-run: shows WOULD_MIGRATE without writing
# -------------------------------------------------------------------------
test_migrate_dry_run_does_not_write() {
  local home="$TMP_ROOT/mig-dry-home"
  local reg="$TMP_ROOT/mig-dry/secondmates.md"
  mkdir -p "$(dirname "$reg")"
  make_home "$home"
  write_marker "$home" riggs
  printf 'name=Riggs\nrole=Harness mate\n' > "$home/config/identity"
  make_registry "$reg" "riggs:$home:Harness mate"

  local before after out
  before=$(cat "$home/config/identity")
  out=$(FM_DATA_OVERRIDE="$(dirname "$reg")" "$MIGRATE" migrate --dry-run) \
    || fail "migrate --dry-run exited non-zero"
  after=$(cat "$home/config/identity")
  printf '%s\n' "$out" | grep -F "WOULD_MIGRATE" | grep -F "riggs" >/dev/null \
    || fail "migrate --dry-run did not emit WOULD_MIGRATE for riggs"
  [ "$before" = "$after" ] || fail "migrate --dry-run modified config/identity"
  pass "migrate --dry-run emits WOULD_MIGRATE without modifying files"
}

# -------------------------------------------------------------------------
# migrate: marker-only home -> creates identity, emits CREATED
# -------------------------------------------------------------------------
test_migrate_marker_only_creates_identity() {
  local home="$TMP_ROOT/mig-mark-home"
  local reg="$TMP_ROOT/mig-mark/secondmates.md"
  mkdir -p "$(dirname "$reg")"
  make_home "$home"
  write_marker "$home" atlas
  # no identity file
  make_registry "$reg" "atlas:$home:GPU remote specialist"

  local out
  out=$(FM_DATA_OVERRIDE="$(dirname "$reg")" "$MIGRATE" migrate) \
    || fail "migrate exited non-zero for marker-only home"
  printf '%s\n' "$out" | grep -F "CREATED" | grep -F "atlas" >/dev/null \
    || fail "migrate did not emit CREATED for atlas"
  [ -f "$home/config/identity" ] || fail "config/identity was not created"
  grep -F 'schema_version=1' "$home/config/identity" >/dev/null \
    || fail "created identity does not have schema_version=1"
  grep -F 'name=Atlas' "$home/config/identity" >/dev/null \
    || fail "created identity does not have name=Atlas"
  pass "migrate creates versioned identity for marker-only home"
}

# -------------------------------------------------------------------------
# migrate: already-versioned -> emits ALREADY_VERSIONED, no write
# -------------------------------------------------------------------------
test_migrate_already_versioned_is_idempotent() {
  local home="$TMP_ROOT/mig-idem-home"
  local reg="$TMP_ROOT/mig-idem/secondmates.md"
  mkdir -p "$(dirname "$reg")"
  make_home "$home"
  write_marker "$home" ledger
  printf 'schema_version=1\nname=Ledger\nrole=Cost analyst\n' > "$home/config/identity"
  make_registry "$reg" "ledger:$home:Cost analyst"

  local before after out
  before=$(cat "$home/config/identity")
  out=$(FM_DATA_OVERRIDE="$(dirname "$reg")" "$MIGRATE" migrate) \
    || fail "migrate exited non-zero for already-versioned home"
  after=$(cat "$home/config/identity")
  printf '%s\n' "$out" | grep -F "ALREADY_VERSIONED" | grep -F "ledger" >/dev/null \
    || fail "migrate did not emit ALREADY_VERSIONED for ledger"
  [ "$before" = "$after" ] || fail "migrate modified an already-versioned identity"
  pass "migrate is idempotent for already-versioned homes"
}

# -------------------------------------------------------------------------
# migrate: marker-registry id mismatch -> CONFLICT on stderr, exit 1
# -------------------------------------------------------------------------
test_migrate_refuses_marker_mismatch() {
  local home="$TMP_ROOT/mig-mismatch-home"
  local reg="$TMP_ROOT/mig-mismatch/secondmates.md"
  mkdir -p "$(dirname "$reg")"
  make_home "$home"
  write_marker "$home" wrongid   # marker says "wrongid"
  printf 'name=Fran\nrole=Schwarzwald\n' > "$home/config/identity"
  make_registry "$reg" "fran:$home:Schwarzwald domain expert"   # registry says "fran"

  local err rc=0
  err=$(FM_DATA_OVERRIDE="$(dirname "$reg")" "$MIGRATE" migrate 2>&1 >/dev/null) || rc=$?
  [ "$rc" = 1 ] || fail "migrate did not exit 1 on marker mismatch"
  printf '%s\n' "$err" | grep -F "CONFLICT" >/dev/null \
    || fail "migrate did not emit CONFLICT on stderr for marker mismatch"
  pass "migrate refuses marker-registry id mismatch with CONFLICT"
}

# -------------------------------------------------------------------------
# check: empty registry -> exit 0 (no unresolved)
# -------------------------------------------------------------------------
test_check_empty_registry_exits_0() {
  local reg="$TMP_ROOT/check-empty/secondmates.md"
  mkdir -p "$(dirname "$reg")"
  printf '# Secondmates\n\n' > "$reg"

  FM_DATA_OVERRIDE="$(dirname "$reg")" "$MIGRATE" check \
    || fail "check exited non-zero for empty registry"
  pass "check exits 0 for an empty registry"
}

test_check_all_versioned_exits_0
test_check_unversioned_exits_1
test_check_no_identity_exits_1
test_check_no_marker_exits_1
test_migrate_unversioned_adds_schema_version
test_migrate_dry_run_does_not_write
test_migrate_marker_only_creates_identity
test_migrate_already_versioned_is_idempotent
test_migrate_refuses_marker_mismatch
test_check_empty_registry_exits_0
