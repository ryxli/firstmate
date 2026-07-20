// fm verb: pr-check - optional helper: appends pr=<url> to state/<id>.meta and
// arms a merged-PR wake check. Prefer worker `done: PR <url>` (finish resolves
// it) plus `fm finish <id>`; this verb is not required on the happy path.
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
	// On MERGED: wake supervisor; finish drains land/backlog/cleanup.
	const fmBin = shellQuote(join(REPO_ROOT, "sbin", "fm"));
	const homeExport = process.env.FM_HOME?.trim() ? `FM_HOME=${shellQuote(process.env.FM_HOME.trim())} ` : "";
	const checkScript = `URL=${checkUrl}
PR_REF=\${URL#https://github.com/}
PR_REPO=\${PR_REF%%/pull/*}
PR_NUMBER=\${PR_REF##*/pull/}
state=$(gh-axi pr view "$PR_NUMBER" --repo "$PR_REPO" 2>/dev/null | awk -F': *' '/^[[:space:]]*state:/{print toupper($2); exit}')
if [ "$state" = "MERGED" ]; then
  echo "merged"
  ${homeExport}${fmBin} finish ${shellQuote(id)} >/dev/null 2>&1 || true
fi
`;
	writeFileSync(join(state, `${id}.check.sh`), checkScript);

	process.stdout.write(`armed: state/${id}.check.sh polls ${url}\n`);
	return 0;
}

export default {
	name: "pr-check",
	describe: "Optional helper: record a PR URL on meta and arm a merged-PR wake that runs fm finish.",
	run,
};
