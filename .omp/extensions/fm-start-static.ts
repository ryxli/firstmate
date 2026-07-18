import { FM_START_STATIC_CONTEXT_ENV } from "./cli/lib/startup-context";

const CUSTOM_TYPE = "fm-start-static";

interface ExtensionApi {
	on(event: "session_start", handler: (event: unknown, ctx: unknown) => void): void;
	sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean }): void;
}

export function emitFmStartStatic(pi: Pick<ExtensionApi, "sendMessage">, env: NodeJS.ProcessEnv = process.env): boolean {
	const content = env[FM_START_STATIC_CONTEXT_ENV];
	if (!content) return false;
	pi.sendMessage({ customType: CUSTOM_TYPE, content, display: true }, { triggerTurn: false });
	return true;
}

export default function fmStartStatic(pi: ExtensionApi): void {
	pi.on("session_start", () => {
		emitFmStartStatic(pi);
	});
}
