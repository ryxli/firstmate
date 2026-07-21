import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const WAIT_REASON =
	"fm-lifecycle-guard: event-driven supervision forbids wait calls; inspect current state or continue other work.";
const LIFECYCLE_REASON =
	"fm-lifecycle-guard: registered-mate lifecycle and state changes must use the owning fm verb; diagnose read-only and report a blocker if fm cannot complete safely.";
const RAW_WRAPPER_REASON =
	"fm-lifecycle-guard: OMP secondmates must use canonical fm spawn without a raw launch wrapper or positional prompt; the launcher injects role and charter context.";

const HERDR_WAIT = /(?:^|[\s;&|()'"])['"]?(?:[^\s;&|()'"]*\/)?herdr['"]?\s+['"]?wait['"]?(?=$|[\s;&|()'"])/;
const HERDR_PANE_CLOSE = /(?:^|[\s;&|()'"])['"]?(?:[^\s;&|()'"]*\/)?herdr['"]?\s+['"]?pane['"]?\s+['"]?close['"]?(?=$|[\s;&|()'"])/;
const HERDR_SEND = /(?:^|[\s;&|()'"])['"]?(?:[^\s;&|()'"]*\/)?herdr['"]?\s+['"]?(?:send|type|paste)['"]?(?=$|[\s;&|()'"])/;
const RM_OR_UNLINK = /(?:^|[\s"'(])['"]?(?:[^\s"';&|()]*\/)?(?:rm|unlink)['"]?(?=$|[\s"';&|()])/;
const STATE_META_TOKEN = /(?:^|[\s"';&|()])(?:[^\s"';&|()]*\/)?state\/[^\/\s"';&|()]+\.meta(?=$|[\s"';&|()])/;
const STATE_META_PATH = /(^|\/)state\/[^/]+\.meta$/;
const FM_SPAWN = /(?:^|[\s"';&|()])['"]?(?:fm|(?:[^\s"';&|()]*\/)?sbin\/fm)['"]?\s+['"]?spawn['"]?(?=$|[\s"';&|()])/;
const SECOND_MATE = /(?:^|[\s"';&|()])['"]?--secondmate['"]?(?=$|[\s"';&|()=])/;
const QUOTED_OMP_ASSIGNMENT = /(?:^|[\s;&|()])[A-Za-z_][A-Za-z0-9_.-]*=(['"])omp /;
const QUOTED_OMP_POSITIONAL = /(?:^|[\s;&|()])(['"])omp /;
const HASHLINE_FILE_HEADER = /^\[([^\]\r\n#]+)#[0-9A-Fa-f]{4}\]\s*$/gm;

type Block = { block: true; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let segment = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of command) {
		if (escaped) {
			segment += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			segment += character;
			escaped = true;
			continue;
		}
		if (quote) {
			segment += character;
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			segment += character;
			continue;
		}
		if (character === ";" || character === "|" || character === "&" || character === "\n") {
			segments.push(segment);
			segment = "";
			continue;
		}
		segment += character;
	}
	segments.push(segment);
	return segments;
}

function containsStateDestruction(command: string): boolean {
	for (const segment of splitShellSegments(command)) {
		const destructive = RM_OR_UNLINK.exec(segment);
		const remainder = destructive ? segment.slice(destructive.index + destructive[0].length).replace(/\\\//g, "/") : "";
		if (destructive && STATE_META_TOKEN.test(remainder)) return true;
	}
	return false;
}

function containsRawSecondmateWrapper(command: string): boolean {
	return FM_SPAWN.test(command) && SECOND_MATE.test(command) && (QUOTED_OMP_ASSIGNMENT.test(command) || QUOTED_OMP_POSITIONAL.test(command));
}

function editTargetsStateMeta(patch: string): boolean {
	for (const match of patch.matchAll(HASHLINE_FILE_HEADER)) {
		if (STATE_META_PATH.test(match[1])) return true;
	}
	return false;
}

export function evaluateFleetToolCall(
	toolName: string,
	input: Record<string, unknown> | undefined,
): Block | undefined {
	if (!input) return undefined;

	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		if (HERDR_WAIT.test(command)) return { block: true, reason: WAIT_REASON };
		if (HERDR_PANE_CLOSE.test(command) || HERDR_SEND.test(command)) return { block: true, reason: LIFECYCLE_REASON };
		if (containsStateDestruction(command)) return { block: true, reason: LIFECYCLE_REASON };
		if (containsRawSecondmateWrapper(command)) return { block: true, reason: RAW_WRAPPER_REASON };
		return undefined;
	}

	if (toolName === "hub") return input.op === "wait" ? { block: true, reason: WAIT_REASON } : undefined;
	if (toolName === "write") {
		return typeof input.path === "string" && STATE_META_PATH.test(input.path) ? { block: true, reason: LIFECYCLE_REASON } : undefined;
	}
	if (toolName === "edit") {
		const patch =
			typeof input.input === "string"
				? input.input
				: typeof input._input === "string"
					? input._input
					: typeof input.patch === "string"
						? input.patch
						: undefined;
		return patch !== undefined && editTargetsStateMeta(patch) ? { block: true, reason: LIFECYCLE_REASON } : undefined;
	}
	return undefined;
}

export default function fmLifecycleGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", event => {
		const call = isRecord(event) ? event : undefined;
		return evaluateFleetToolCall(
			typeof call?.toolName === "string" ? call.toolName : "",
			isRecord(call?.input) ? call.input : undefined,
		);
	});
}
