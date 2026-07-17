// fm lib: root - shared root/home resolver for firstmate shell scripts.
// Ported behavior-preserving from sbin/fm-root-lib.sh.
//
// Real callers (grepped): fm bootstrap calls fm_home_from_cwd. Nothing
// else in the repo calls any other function in the bash lib, including
// fm_init_roots itself (defined, never invoked by any script).
//
// Dropped as caller-less (defined in the bash lib, invoked by nothing -
// neither an external script nor fm_home_from_cwd, the only kept function):
// fm_realpath_existing, fm_normalize_path, fm_script_dir_physical,
// fm_code_root_from_script, fm_init_roots. These form their own isolated
// dead subgraph (fm_init_roots calls the other three, but nothing calls
// fm_init_roots), so none of them are reachable from a real caller.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// homeFromCwd(startDir?): resolve the operational home by walking up from
// startDir (default: the physical cwd) to the nearest AGENTS.md marker. Lets a
// session opened directly in a symlinked secondmate home (no FM_HOME exported)
// find its real home instead of collapsing onto the physical code root.
// Returns the home path, or null if unmarked. Mirrors the bash loop exactly:
// the walk stops BEFORE checking "/" itself, so a marker at the filesystem
// root would never be found (matches the original's `[ "$d" != "/" ]` guard).
export function homeFromCwd(startDir: string = process.cwd()): string | null {
	let d = startDir;
	while (d.length > 0 && d !== "/") {
		if (existsSync(join(d, "AGENTS.md"))) return d;
		const parent = dirname(d);
		if (parent === d) break;
		d = parent;
	}
	return null;
}
