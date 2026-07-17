// fm verb: freeze - toggle the global dispatch-freeze flag and per-mate focus locks.
// Ported behavior-preserving from the former sbin/fm freeze.
//
// The dispatch freeze blocks fm-send from delivering new work to any mate.
// A focus lock blocks fm-send from delivering new work to a specific mate.
// Both are bypassed by --steer or FM_DISPATCH_OVERRIDE=1 in fm send.

import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function resolveState(): string {
	const rootOverride = process.env.FM_ROOT_OVERRIDE?.trim();
	const fmRoot = rootOverride || REPO_ROOT;
	const fmHome = process.env.FM_HOME?.trim() || rootOverride || fmRoot;
	const stateOverride = process.env.FM_STATE_OVERRIDE?.trim();
	return stateOverride || join(fmHome, "state");
}

function usage(): number {
	process.stderr.write("Usage: fm freeze on [reason]\n");
	process.stderr.write("       fm freeze off\n");
	process.stderr.write("       fm freeze focus <id> on [reason]\n");
	process.stderr.write("       fm freeze focus <id> off\n");
	return 1;
}

function writeMarker(path: string, reason: string): void {
	writeFileSync(path, `${reason}\n`);
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	if (!args[0]) return usage();

	const state = resolveState();

	try {
		switch (args[0]) {
			case "on": {
				const reason = args[1] ?? "";
				writeMarker(join(state, ".dispatch-freeze"), reason);
				process.stdout.write(`dispatch frozen${reason ? `: ${reason}` : ""}\n`);
				return 0;
			}
			case "off": {
				rmSync(join(state, ".dispatch-freeze"), { force: true });
				process.stdout.write("dispatch unfrozen\n");
				return 0;
			}
			case "focus": {
				const id = args[1];
				if (!id) return usage();
				const sub = args.slice(2);
				switch (sub[0]) {
					case "on": {
						const reason = sub[1] ?? "";
						writeMarker(join(state, `.focus-${id}`), reason);
						process.stdout.write(`focus lock set for ${id}${reason ? `: ${reason}` : ""}\n`);
						return 0;
					}
					case "off": {
						rmSync(join(state, `.focus-${id}`), { force: true });
						process.stdout.write(`focus lock removed for ${id}\n`);
						return 0;
					}
					default:
						return usage();
				}
			}
			default:
				return usage();
		}
	} catch (error) {
		process.stderr.write(`fm freeze: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

export default {
	name: "freeze",
	describe: "Toggle the global dispatch-freeze flag and per-mate focus locks.",
	run,
};
