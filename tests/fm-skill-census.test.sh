#!/usr/bin/env bash
# Behavior tests for sbin/fm skill-census.
# Scenarios: exact-duplicate-of-template (merge), same-name-drift (drift, plus
# --check exiting nonzero), cache-only (graduate-or-delete), unique mate-local
# (healthy), and a stale_when in the past (expire) - plus confirming a
# mate-home entry that only resolves back to the template through a symlink
# is skipped rather than emitted.
set -eu

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CENSUS="$ROOT/sbin/fm"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fm-skill-census-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $1" >&2
  [ -n "${2:-}" ] && { echo "--- output ---" >&2; cat "$2" >&2; }
  exit 1
}
pass() { echo "ok - $1"; }
have() { grep -qF "$1" "$2" || fail "expected line containing: $1" "$2"; }
lack() { grep -qF "$1" "$2" && fail "unexpected line containing: $1" "$2"; return 0; }

write_skill() {
  # write_skill <path> <description> [extra-frontmatter-lines...]
  local path=$1 desc=$2
  shift 2
  mkdir -p "$(dirname "$path")"
  {
    echo "---"
    echo "name: $(basename "$(dirname "$path")")"
    echo "description: $desc"
    for line in "$@"; do echo "$line"; done
    echo "---"
    echo ""
    echo "# $(basename "$(dirname "$path")")"
    echo "$desc"
  } > "$path"
}

# ---------------------------------------------------------------------------
# Fixture: a fake code root with two template skills (alpha, beta), a fake
# mate home registered in its own secondmates.md with local skills covering
# merge/drift/healthy/expire, one entry that symlinks back to the template
# (must be skipped), and two cache dirs covering merge and cache-only.
# ---------------------------------------------------------------------------
CODE_ROOT="$TMP/code"
write_skill "$CODE_ROOT/.agents/skills/alpha/SKILL.md" "Alpha template skill."
write_skill "$CODE_ROOT/.agents/skills/beta/SKILL.md" "Beta template skill."

HOME_DIR="$TMP/home"
mkdir -p "$HOME_DIR/data"
cat > "$HOME_DIR/data/secondmates.md" <<EOF
- testmate - a fixture mate (home: $TMP/matehome; workspace: w1; name: Testmate; scope: test; projects: (none); added 2026-07-17)
EOF

MATE_HOME="$TMP/matehome"
mkdir -p "$MATE_HOME/.agents/skills"
# merge: identical content + name to template alpha
write_skill "$MATE_HOME/.agents/skills/alpha/SKILL.md" "Alpha template skill."
# drift: same name as template beta, different content
write_skill "$MATE_HOME/.agents/skills/beta/SKILL.md" "Beta but rewritten locally."
# healthy: unique mate-local skill, no template counterpart
write_skill "$MATE_HOME/.agents/skills/gamma/SKILL.md" "Gamma is mate-local only."
# expire: stale_when already in the past relative to fixed FM_SKILL_CENSUS_TODAY
write_skill "$MATE_HOME/.agents/skills/delta/SKILL.md" "Delta is overdue for review." \
  "origin: copied from template" "date: 2026-01-01" "stale_when: 2026-01-15"
# symlink-through-to-template, directory level (mirrors the real fleet: a
# mate's whole .agents/skills dir, or one skill's directory, symlinked back
# to the template) - must never be emitted as a mate-local row
ln -s "$CODE_ROOT/.agents/skills/alpha" "$MATE_HOME/.agents/skills/afk-proxy"
# symlink-through-to-template, file level (only the SKILL.md leaf is a
# symlink) - must also be skipped
mkdir -p "$MATE_HOME/.agents/skills/afk-proxy-file"
ln -s "$CODE_ROOT/.agents/skills/alpha/SKILL.md" "$MATE_HOME/.agents/skills/afk-proxy-file/SKILL.md"

OMP_CACHE="$TMP/cache/omp-managed-skills"
CLAUDE_CACHE="$TMP/cache/claude-skills"
# merge: cache copy identical to template alpha
write_skill "$OMP_CACHE/alpha/SKILL.md" "Alpha template skill."
# cache-only: no template skill named zeta
write_skill "$CLAUDE_CACHE/zeta/SKILL.md" "Zeta lives only in a machine cache."

run_census() {
  FM_CODE_ROOT_OVERRIDE="$CODE_ROOT" \
  FM_HOME="$HOME_DIR" \
  FM_SKILL_CACHE_OMP_OVERRIDE="$OMP_CACHE" \
  FM_SKILL_CACHE_CLAUDE_OVERRIDE="$CLAUDE_CACHE" \
  FM_SKILL_CENSUS_TODAY="2026-07-17" \
  "$CENSUS" skill-census "$@"
}

# --- default run: exit 0, every disposition present -------------------------
OUT="$TMP/out.tsv"
if ! run_census > "$OUT" 2>"$TMP/err"; then
  fail "default run exited nonzero" "$TMP/err"
fi
[ -s "$TMP/err" ] && fail "default run wrote to stderr" "$TMP/err"

have $'template\talpha' "$OUT"
have $'template\tbeta' "$OUT"
pass "template rows present for both fixture template skills"

have $'mate:testmate:.agents\talpha' "$OUT"
grep -F $'mate:testmate:.agents' "$OUT" | grep -F $'alpha' | grep -qF $'\tmerge' \
  || fail "mate alpha row not classified merge" "$OUT"
pass "mate-local exact duplicate of template classified merge"

grep -F $'mate:testmate:.agents' "$OUT" | grep -F $'beta' | grep -qF $'\tdrift' \
  || fail "mate beta row not classified drift" "$OUT"
pass "mate-local same-name divergent copy classified drift"

grep -F $'mate:testmate:.agents' "$OUT" | grep -F $'gamma' | grep -qF $'\thealthy' \
  || fail "mate gamma row not classified healthy" "$OUT"
pass "unique mate-local skill classified healthy"

grep -F $'mate:testmate:.agents' "$OUT" | grep -F $'delta' | grep -qF $'\texpire' \
  || fail "mate delta row not classified expire" "$OUT"
pass "past stale_when classified expire ahead of duplicate/drift/healthy"

lack "afk-proxy" "$OUT"
pass "symlink-through-to-template mate entries (directory- and file-level) are skipped, not emitted"

grep -F 'cache:omp-managed-skills' "$OUT" | grep -F 'alpha' | grep -qF $'\tmerge' \
  || fail "cache alpha row not classified merge" "$OUT"
pass "cache copy identical to template classified merge"

grep -F 'cache:claude-skills' "$OUT" | grep -F 'zeta' | grep -qF $'\tgraduate-or-delete' \
  || fail "cache zeta row not classified graduate-or-delete" "$OUT"
pass "cache-only skill (no template copy) classified graduate-or-delete"

have $'disposition\tcount' "$OUT"
have $'drift\t1' "$OUT"
have $'expire\t1' "$OUT"
have $'healthy\t1' "$OUT"
pass "summary reports one count per observed disposition flag"

# --- --check mode: nonzero because a drift row exists -----------------------
if run_census --check > "$TMP/check-out.tsv" 2>"$TMP/check-err"; then
  fail "--check exited 0 despite a drift row" "$TMP/check-err"
fi
diff "$OUT" "$TMP/check-out.tsv" > /dev/null \
  || fail "--check output differs from default output" "$TMP/check-out.tsv"
pass "--check exits nonzero when a drift row exists, output unchanged"

# --- --check mode with no drift: exits 0 ------------------------------------
NODRIFT_MATE="$TMP/matehome-nodrift"
mkdir -p "$NODRIFT_MATE/.agents/skills"
write_skill "$NODRIFT_MATE/.agents/skills/alpha/SKILL.md" "Alpha template skill."
NODRIFT_HOME="$TMP/home-nodrift"
mkdir -p "$NODRIFT_HOME/data"
cat > "$NODRIFT_HOME/data/secondmates.md" <<EOF
- clean - a fixture mate with no drift (home: $NODRIFT_MATE; workspace: w2; name: Clean; scope: test; projects: (none); added 2026-07-17)
EOF
if ! FM_CODE_ROOT_OVERRIDE="$CODE_ROOT" \
   FM_HOME="$NODRIFT_HOME" \
   FM_SKILL_CACHE_OMP_OVERRIDE="$TMP/cache/empty-omp" \
   FM_SKILL_CACHE_CLAUDE_OVERRIDE="$TMP/cache/empty-claude" \
   FM_SKILL_CENSUS_TODAY="2026-07-17" \
   "$CENSUS" skill-census --check > "$TMP/nodrift-out.tsv" 2>"$TMP/nodrift-err"; then
  fail "--check exited nonzero with no drift present" "$TMP/nodrift-err"
fi
pass "--check exits 0 when no drift row exists"

# --- degrades gracefully: real roots with no .agents/skills, no
# data/secondmates.md, and no cache dirs underneath them ---------------------
EMPTY_CODE_ROOT="$TMP/empty-code-root"
EMPTY_HOME="$TMP/empty-home"
mkdir -p "$EMPTY_CODE_ROOT" "$EMPTY_HOME"
if ! FM_CODE_ROOT_OVERRIDE="$EMPTY_CODE_ROOT" \
   FM_HOME="$EMPTY_HOME" \
   FM_SKILL_CACHE_OMP_OVERRIDE="$TMP/no-such-omp-cache" \
   FM_SKILL_CACHE_CLAUDE_OVERRIDE="$TMP/no-such-claude-cache" \
   "$CENSUS" skill-census > "$TMP/empty-out.tsv" 2>"$TMP/empty-err"; then
  fail "run over entirely-missing surfaces exited nonzero" "$TMP/empty-err"
fi
[ -s "$TMP/empty-err" ] && fail "run over entirely-missing surfaces wrote to stderr" "$TMP/empty-err"
have $'total\t0' "$TMP/empty-out.tsv"
pass "missing template/registry/caches degrade to an empty, non-crashing report"

echo "all fm-skill-census tests passed"
