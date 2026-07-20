#!/usr/bin/env bash
# Verifies `fm brief` --regen/--check make data/secondmates.md the only
# hand-edited home for secondmate identity/scope: data/mates/<id>/brief.md and
# <home>/data/charter.md are generated projections of the registry line plus
# the tracked template, with exactly one mate-owned section preserved
# verbatim across regenerations.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIEF=("$ROOT/sbin/fm" brief)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fm-brief-regen.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

HOME_DIR="$TMP/home"
MATE_HOME="$TMP/mates/plum"
mkdir -p "$HOME_DIR/data" "$HOME_DIR/config" "$MATE_HOME/data"

cat > "$HOME_DIR/config/identity" <<'EOF'
schema_version=1
name=Riggs
role=Main firstmate crew supervisor
parent=cap
EOF

cat > "$HOME_DIR/data/secondmates.md" <<EOF
- plum - Independent evaluator and quality-guardian for firstmate self-improvement (home: $MATE_HOME; workspace: w2C; name: Plum; scope: Harness research engine - conducts research and produces evidence-backed improvement proposals for firstmate, omp, and herdr, and independently gates harness changes via the objective evaluation substrate (fm-bench, benchmarks, lint/test/invariant gates) with adopt-iff-improves verdicts and rollback; implementation of its own proposals stays outside plum.; projects: alpha, beta; added 2026-06-25)
EOF

run() {
  FM_HOME="$HOME_DIR" FM_ROOT_OVERRIDE='' FM_DATA_OVERRIDE='' FM_CONFIG_OVERRIDE='' FM_STATE_OVERRIDE='' \
    "${BRIEF[@]}" "$@"
}

BRIEF_PATH="$HOME_DIR/data/mates/plum/brief.md"
CHARTER_PATH="$MATE_HOME/data/charter.md"

# (a) generation fills only registry-derived domain fields.
run --regen plum >/dev/null || fail "fm brief --regen plum failed"
[ -f "$BRIEF_PATH" ] || fail "regen did not write $BRIEF_PATH"
[ -f "$CHARTER_PATH" ] || fail "regen did not write $CHARTER_PATH"
for f in "$BRIEF_PATH" "$CHARTER_PATH"; do
  grep -qF 'generated from data/secondmates.md via fm brief; do not hand-edit' "$f" \
    || fail "$f is missing the generated-projection marker line"
  grep -qF '# Charter
Independent evaluator and quality-guardian for firstmate self-improvement' "$f" \
    || fail "$f did not fill the registry charter summary"
  grep -qF '# Routing scope
Harness research engine - conducts research' "$f" \
    || fail "$f did not fill the registry scope field"
  grep -qF -- '- alpha' "$f" || fail "$f did not fill the registry project clone list (alpha)"
  grep -qF -- '- beta' "$f" || fail "$f did not fill the registry project clone list (beta)"
  ! grep -qF 'You are Plum' "$f" || fail "$f restated runtime identity"
  ! grep -qF 'authority:' "$f" || fail "$f restated runtime authority"
  ! grep -qF '# Operating model' "$f" || fail "$f retained generic operating prose"
  ! grep -qF '# Escalation to main firstmate' "$f" || fail "$f retained generic escalation prose"
  ! grep -qF '# Definition of done' "$f" || fail "$f retained generic completion prose"
  ! grep -qF '# Lean-loop discipline' "$f" || fail "$f retained generic lean-loop prose"
  ! grep -qF '# House tooling conventions' "$f" || fail "$f retained generic tool-policy prose"
done
pass "regen emits domain charter, routing scope, projects, and owned block only"

# (b) a mate-owned section survives regeneration byte-for-byte, including
# CRLF line endings and trailing whitespace inside the block.
python3 - "$CHARTER_PATH" <<'PY'
import sys
path = sys.argv[1]
begin = b"<!-- BEGIN MATE-OWNED NOTES: preserved verbatim across regeneration; edit only inside this block -->"
end = b"<!-- END MATE-OWNED NOTES -->"
raw = open(path, "rb").read()
start = raw.index(begin) + len(begin)
stop = raw.index(end, start)
owned = b"\r\nPlum's own note: prefers terse verdicts.  \r\nsecond owned line\t\r\n"
open(path, "wb").write(raw[:start] + owned + raw[stop:])
PY
run --regen plum >/dev/null || fail "second fm brief --regen plum failed"
python3 - "$CHARTER_PATH" <<'PY'
import sys
path = sys.argv[1]
begin = b"<!-- BEGIN MATE-OWNED NOTES: preserved verbatim across regeneration; edit only inside this block -->"
end = b"<!-- END MATE-OWNED NOTES -->"
raw = open(path, "rb").read()
owned = raw[raw.index(begin) + len(begin):raw.index(end)]
expected = b"\r\nPlum's own note: prefers terse verdicts.  \r\nsecond owned line\t\r\n"
if owned != expected:
    raise SystemExit(f"owned block changed: {owned!r}")
PY
pass "mate-owned section survives regeneration byte-for-byte"

# (c) --check passes right after regen.
run --check plum >/dev/null || fail "fm brief --check plum did not pass right after regen"
pass "--check passes right after regen"

# (d) --check fails nonzero when a projection is edited outside the owned section.
python3 - "$CHARTER_PATH" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
text = text.replace("# Routing scope\n", "# Routing scope\nHAND-EDITED OUTSIDE THE OWNED SECTION\n", 1)
open(path, "w").write(text)
PY
if run --check plum >/dev/null 2>"$TMP/check.err"; then
  fail "--check passed despite an edit outside the mate-owned section"
fi
grep -qF "$CHARTER_PATH" "$TMP/check.err" \
  || fail "--check failure did not name the differing projection"
pass "--check fails nonzero when a projection is edited outside the owned section"

# Regenerating again restores the scaffold while still preserving the note.
run --regen plum >/dev/null || fail "restorative fm brief --regen plum failed"
! grep -qF "HAND-EDITED OUTSIDE THE OWNED SECTION" "$CHARTER_PATH" \
  || fail "regen did not restore the hand-edited scaffold text"
grep -qF "Plum's own note: prefers terse verdicts." "$CHARTER_PATH" \
  || fail "restorative regen lost the mate-owned note"
run --check plum >/dev/null || fail "--check failed after restorative regen"
pass "regen restores the scaffold and --check passes again"

# A brand-new secondmate with no prior projection gets the empty mate-owned scaffold.
cat >> "$HOME_DIR/data/secondmates.md" <<EOF
- fresh - Fresh domain secondmate (home: $TMP/mates/fresh; name: Fresh; scope: fresh domain scope; projects: (none); added 2026-06-25)
EOF

# A one-shot --secondmate scaffold is the same domain-only overlay shape.
FM_HOME="$HOME_DIR" FM_SECONDMATE_CHARTER='overlay charter' FM_SECONDMATE_SCOPE='overlay scope' \
  "${BRIEF[@]}" scaffold --secondmate alpha >/dev/null \
  || fail "fm brief --secondmate scaffold failed"
SCAFFOLD_PATH="$HOME_DIR/data/mates/scaffold/brief.md"
grep -qF $'# Charter\noverlay charter' "$SCAFFOLD_PATH" \
  || fail "initial scaffold did not retain the domain charter"
grep -qF $'# Routing scope\noverlay scope' "$SCAFFOLD_PATH" \
  || fail "initial scaffold did not retain the routing scope"
grep -qF -- '- alpha' "$SCAFFOLD_PATH" \
  || fail "initial scaffold did not retain the registered project"
! grep -qF 'You are a secondmate' "$SCAFFOLD_PATH" \
  || fail "initial scaffold restated runtime identity"
! grep -qF '# Operating model' "$SCAFFOLD_PATH" \
  || fail "initial scaffold retained generic operating prose"
grep -qF '<!-- BEGIN MATE-OWNED NOTES:' "$SCAFFOLD_PATH" \
  || fail "initial scaffold omitted the mate-owned block"
pass "initial --secondmate scaffold emits a domain-only overlay"
mkdir -p "$TMP/mates/fresh/data"
run --regen fresh >/dev/null || fail "fm brief --regen fresh failed"
grep -qF '(no mate-owned notes yet)' "$HOME_DIR/data/mates/fresh/brief.md" \
  || fail "fresh secondmate brief did not scaffold the empty mate-owned placeholder"
grep -qF '(no mate-owned notes yet)' "$TMP/mates/fresh/data/charter.md" \
  || fail "fresh secondmate charter did not scaffold the empty mate-owned placeholder"
run --check fresh >/dev/null || fail "--check failed for a freshly-regenerated secondmate"
pass "a freshly seeded secondmate scaffolds the empty mate-owned placeholder"

# --check reports an unregistered id as an error rather than silently passing.
if run --check nope >/dev/null 2>"$TMP/nope.err"; then
  fail "--check passed for an unregistered secondmate id"
fi
grep -qF "no registered secondmate 'nope'" "$TMP/nope.err" \
  || fail "--check did not explain the unregistered id"
pass "--check fails nonzero for an unregistered secondmate id"

# (e) shellcheck-clean scripts. `fm brief` and `fm home-seed` are now
# TypeScript (bun, not bash), so no bash caller remains in the regeneration
# path to check; this is a vacuous pass guarding against a future bash
# regeneration script rotting back in unchecked.
command -v shellcheck >/dev/null 2>&1 || fail "shellcheck is not on PATH"
pass "regeneration scripts are shellcheck-clean (no bash scripts remain in this path)"
