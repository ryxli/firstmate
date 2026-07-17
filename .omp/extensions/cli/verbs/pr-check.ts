// fm verb: pr-check - record a PR-ready task: appends pr=<url> to
// state/<id>.meta and registers its merged-PR check with automatic
// in-process supervision. The generated check prints one line iff the PR is
// merged (the check contract: output = wake firstmate, silence = keep
// sleeping).
// Ported behavior-preserving from the former sbin/fm pr-check.
// Usage: fm pr-check <task-id> <pr-url>

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
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

// Mirrors the script's shell_quote(): wrap in single quotes, escaping any
// embedded single quotes the POSIX-shell way.
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

async function run(argv: string[]): Promise<number> {
	const args = argv.slice(1);
	const id = args[0];
	const url = args[1];
	if (!id || !url) {
		process.stderr.write("Usage: fm pr-check <task-id> <pr-url>\n");
		return 1;
	}

	const state = resolveState();
	const metaPath = join(state, `${id}.meta`);

	if (existsSync(metaPath)) {
		const contents = readFileSync(metaPath, "utf8");
		const lines = contents.split("\n");
		if (!lines.includes(`pr=${url}`)) {
			appendFileSync(metaPath, `pr=${url}\n`);
		}
	}

	const checkUrl = shellQuote(url);
	const checkScript = `URL=${checkUrl}
PR_REF=\${URL#https://github.com/}
PR_REPO=\${PR_REF%%/pull/*}
PR_NUMBER=\${PR_REF##*/pull/}
state=$(gh-axi pr view "$PR_NUMBER" --repo "$PR_REPO" 2>/dev/null | awk -F': *' '/^[[:space:]]*state:/{print toupper($2); exit}')
[ "$state" = "MERGED" ] && echo "merged"
`;
	writeFileSync(join(state, `${id}.check.sh`), checkScript);

	process.stdout.write(`armed: state/${id}.check.sh polls ${url}\n`);
	return 0;
}

export default {
	name: "pr-check",
	describe: "Record a PR URL into a task's meta file and arm its merged-PR poll check.",
	run,
};
