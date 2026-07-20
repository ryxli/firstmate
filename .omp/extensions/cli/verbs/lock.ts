// fm verb: lock - acquire or report the per-home firstmate session lock.
// Ported verbatim (behavior-preserving) out of the former sbin/fm lock.
//
// Writes the harness (agent) process PID found by walking process ancestry,
// which lives as long as the firstmate session - unlike the transient PID of
// any one tool-call process, which is dead moments after it is written.
// Usage: fm lock           acquire; exit 1 if another live session holds it
//        fm lock release   release only if this harness is the recorded owner
//        fm lock status    print holder and liveness; always exits 0

import { unlinkSync } from "node:fs";
import { harnessPid, holderAlive, lockSnapshot, readLockRaw, resolveLockPaths, withLockClaim, writeLockOwner } from "../lib/session-lock";

const CLAIM_TIMEOUT_MS = 5_000;

const USAGE = `Usage: fm lock
       fm lock status
       fm lock release
`;

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		process.stdout.write(USAGE);
		return 0;
	}
	const paths = resolveLockPaths();

	if (args[0] === "status") {
		const snapshot = lockSnapshot(paths);
		if (snapshot.state === "free") {
			process.stdout.write("lock: free\n");
		} else if (snapshot.state === "live") {
			process.stdout.write(`lock: held by live harness pid ${snapshot.raw}\n`);
		} else {
			process.stdout.write(`lock: stale (pid ${snapshot.raw} dead or not a harness)\n`);
		}
		return 0;
	}

	const me = harnessPid();
	if (me === undefined) {
		process.stderr.write("error: cannot locate harness process in ancestry\n");
		return 1;
	}

	try {
		return await withLockClaim(paths, Date.now() + CLAIM_TIMEOUT_MS, () => {
			if (args[0] === "release") {
				const old = readLockRaw(paths);
				if (old !== String(me) || !holderAlive(me)) {
					process.stderr.write(`error: cannot release firstmate lock: recorded owner is ${old ?? "none"}, caller harness pid is ${me}\n`);
					return 1;
				}
				unlinkSync(paths.lockFile);
				process.stdout.write(`lock released: harness pid ${me}\n`);
				return 0;
			}

			const snapshot = lockSnapshot(paths);
			if (snapshot.state === "live" && snapshot.raw !== String(me)) {
				process.stderr.write(`error: another live firstmate session holds the lock (pid ${snapshot.raw}); operate read-only until resolved\n`);
				return 1;
			}
			writeLockOwner(paths, me);
			process.stdout.write(`lock acquired: harness pid ${me}\n`);
			return 0;
		});
	} catch (error) {
		process.stderr.write(`error: ${(error as Error).message}\n`);
		return 1;
	}
}

export default {
	name: "lock",
	describe: "Acquire, release, or report the per-home firstmate session lock.",
	run,
};
