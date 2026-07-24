import { FM_START_STATIC_CONTEXT_ENV } from "./cli/lib/startup-context";

const CUSTOM_TYPE = "fm-start-static";

interface SessionStartContext {
	sessionManager: {
		getHeader(): { titleSource?: "auto" | "user" } | undefined;
	};
}

interface ExtensionApi {
	on(
		event: "session_start",
		handler: (event: unknown, ctx: SessionStartContext) => Promise<void> | void,
	): void;
	sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean }): void;
	setSessionName(name: string): Promise<void>;
}

export async function emitFmStartStatic(
	pi: Pick<ExtensionApi, "sendMessage" | "setSessionName">,
	ctx: SessionStartContext,
	env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
	const content = env[FM_START_STATIC_CONTEXT_ENV];
	if (!content) return false;
	if (ctx.sessionManager.getHeader()?.titleSource !== "user") {
		await pi.setSessionName("Firstmate");
	}
	pi.sendMessage({ customType: CUSTOM_TYPE, content, display: true }, { triggerTurn: false });
	return true;
}

export default function fmStartStatic(pi: ExtensionApi): void {
	pi.on("session_start", async (_event, ctx) => {
		await emitFmStartStatic(pi, ctx);
	});
}
