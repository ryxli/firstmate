// fm verb: accept - derive candidate from git, freeze verdict, queue integrate.
// Usage: fm accept <task-id> [--sha <commit>] [--by <who>] [--mode trunk|pr] [--full]

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	accept,
	canonicalizeDeliveryMode,
	ensureArtifact,
	loadArtifact,
	projectRepo,
	saveArtifact,
} from "../lib/artifact";
import {
	assertPrMatchesAccept,
	deriveAndSubmitCandidate,
	metaField,
	readTaskMeta,
	receiptLine,
	releaseWorkerPane,
	resolvePrUrl,
	shortSha,
} from "../lib/operator";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/+$/, "");

function flagVal(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

function resolveMode(taskId: string, override?: string): "trunk" | "pr" {
	if (override) return canonicalizeDeliveryMode(override);
	const meta = readTaskMeta(taskId);
	if (meta) {
		const mode = metaField(meta.text, "mode=");
		if (mode) return canonicalizeDeliveryMode(mode);
		const project = metaField(meta.text, "project=");
		const name = project.split("/").filter(Boolean).pop() || project;
		if (name) {
			const res = spawnSync(join(REPO_ROOT, "sbin", "fm"), ["project-mode", name], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			const word = (res.stdout ?? "").trim().split(/\s+/)[0];
			if (word) return canonicalizeDeliveryMode(word);
		}
	}
	return "pr";
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const id = args.find(a => !a.startsWith("-"));
	if (!id || args.includes("--help") || args.includes("-h")) {
		process.stderr.write(
			"usage: fm accept <task-id> [--sha <commit>] [--by <who>] [--mode trunk|pr] [--full]\n" +
				"Approves the candidate and queues integration.\n" +
				"Derives from git if needed, freezes the verdict, and closes the worker pane.\n",
		);
		return id ? 0 : 1;
	}
	const full = args.includes("--full");
	const meta = readTaskMeta(id);
	const projectPath = meta ? metaField(meta.text, "project=") : "";
	const project = projectPath.split("/").filter(Boolean).pop() || flagVal(args, "--project") || "unknown";

	try {
		const record = ensureArtifact(id, project);
		if (record.reviewState === "accepted") {
			receiptLine(`accepted ${id}: already accepted -> queued for ${record.delivery?.mode ?? "pr"}`);
			return 0;
		}
		if (record.reviewState !== "candidate") {
			deriveAndSubmitCandidate(record, { sha: flagVal(args, "--sha"), parent: flagVal(args, "--parent") });
		}
		const mode = resolveMode(id, flagVal(args, "--mode"));
		if (mode === "pr") {
			const prUrl = resolvePrUrl(id);
			if (!prUrl) {
				process.stderr.write(
					`error: ${id} has no PR URL (meta pr= or status done: PR <url>); refuse accept until the worker opens a PR and reports the URL\n`,
				);
				return 1;
			}
			const candidateSha =
				record.revisions.at(-1)?.candidateSha ?? record.acceptedRevision?.candidateSha ?? "";
			if (!candidateSha) {
				process.stderr.write(`error: ${id} has no candidate SHA to compare against the PR head\n`);
				return 1;
			}
			assertPrMatchesAccept({
				prUrl,
				candidateSha,
				projectPath: projectPath || projectRepo(project),
			});
		}
		accept(record, mode, {
			by: flagVal(args, "--by") ?? "firstmate",
			criteria: ["operator-accept"],
			note: flagVal(args, "--note"),
		});
		saveArtifact(record);
		releaseWorkerPane(id);
		const sha = shortSha(record.acceptedRevision?.candidateSha ?? "");
		receiptLine(`accepted ${id} ${sha} -> queued for ${mode}`);
		if (full) {
			process.stdout.write(`${JSON.stringify(loadArtifact(id), null, 2)}\n`);
		}
		return 0;
	} catch (err) {
		process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

export default {
	name: "accept",
	describe: "Approve a task's candidate and queue it for integration.",
	surface: "captain",
	run,
};
