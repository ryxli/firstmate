// fm lib: spawn - shared spawn-path shell helpers for firstmate.
// Ported behavior-preserving from sbin/fm-spawn-lib.sh.
//
// Real callers (grepped): fm spawn calls fm_shell_quote (quoting the brief
// path, the crew model, the omp config path, and the home path before
// interpolating them into a launch command).
//
// Dropped as caller-less: fm_first_command_word has zero callers anywhere in
// the repo (the bash lib's header comment claims fm brief sources this
// lib, but fm brief does not; the `fm resolve-spawn` verb already carries
// its own independently-inlined equivalent, `firstCommandWord`, which is not
// a call to this bash function).

// shellQuote(value): value single-quoted and safe to paste into a shell
// command (each embedded single quote becomes '\''). No trailing newline, so
// the result can be interpolated directly into a launch command or brief idiom.
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
