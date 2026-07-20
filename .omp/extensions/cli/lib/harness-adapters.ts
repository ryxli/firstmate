// Internal typed harness adapter registry.
// Consumed by spawn/send/teardown and `fm harness inspect`.
// Public interrupt/exit remain via `fm send` using these facts - no parallel verbs.

export type HarnessName = "omp" | "claude" | "codex" | "opencode" | "pi";

export interface HarnessAdapter {
	name: HarnessName;
	exitCommand: string;
	/** Keys to send via `fm send --key` for interrupt. */
	interruptKeys: string[];
	/** How many Escape presses (or key sequence length) for interrupt. */
	interruptCount: number;
	skillInvocation: string;
	envMarker?: string;
	notes: string[];
}

export const HARNESS_ADAPTERS: Record<HarnessName, HarnessAdapter> = {
	omp: {
		name: "omp",
		exitCommand: "/quit",
		interruptKeys: ["Escape"],
		interruptCount: 1,
		skillInvocation: "/skill:<name>",
		envMarker: "OMPCODE=1",
		notes: [
			"Detect OMPCODE before CLAUDECODE (omp sets both).",
			"Launch: omp --auto-approve \"$(cat <brief>)\".",
			"Peek within ~20s after spawn.",
		],
	},
	claude: {
		name: "claude",
		exitCommand: "/exit",
		interruptKeys: ["Escape"],
		interruptCount: 1,
		skillInvocation: "/<skill>",
		envMarker: "CLAUDECODE=1",
		notes: [
			"Trust/bypass dialogs on first fresh worktree: fm send --key Enter.",
			"Spawn sets CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false.",
		],
	},
	codex: {
		name: "codex",
		exitCommand: "/quit",
		interruptKeys: ["Escape"],
		interruptCount: 1,
		skillInvocation: "$<skill>",
		notes: [
			"Slash popup needs ~1s between text and Enter; fm-send handles it.",
			"Directory trust on first run per repo root.",
			"Resume: codex resume <session-id>.",
		],
	},
	opencode: {
		name: "opencode",
		exitCommand: "/exit",
		interruptKeys: ["Escape", "Escape"],
		interruptCount: 2,
		skillInvocation: "(harness-native)",
		notes: [
			"Double Escape interrupt; flaky during long shells - may need exit + relaunch.",
			"Auto-upgrade can exit mid-task; relaunch with --continue then fm send.",
		],
	},
	pi: {
		name: "pi",
		exitCommand: "/quit",
		interruptKeys: ["Escape"],
		interruptCount: 1,
		skillInvocation: "(none)",
		envMarker: "PI_CODING_AGENT=true",
		notes: [
			"Always autonomous; brief must be one positional arg.",
			"Project trust may appear once per path in ~/.pi/agent/trust.json.",
		],
	},
};

export function getHarnessAdapter(name: string): HarnessAdapter | undefined {
	const key = name.trim().toLowerCase() as HarnessName;
	return HARNESS_ADAPTERS[key];
}

export function listHarnessAdapters(): HarnessAdapter[] {
	return Object.values(HARNESS_ADAPTERS);
}

export function interruptPlan(name: string): { keys: string[]; count: number } | undefined {
	const adapter = getHarnessAdapter(name);
	if (!adapter) return undefined;
	return { keys: adapter.interruptKeys, count: adapter.interruptCount };
}

export function exitCommand(name: string): string | undefined {
	return getHarnessAdapter(name)?.exitCommand;
}
