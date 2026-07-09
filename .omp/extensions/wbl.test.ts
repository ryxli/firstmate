// wbl command extension tests. Run: bun .omp/extensions/wbl.test.ts

import wbl, { buildWbLoopMessage, WB_LOOP_MESSAGE } from "./wbl";

let failures = 0;
function check(name: string, cond: boolean): void {
	if (!cond) {
		console.error(`FAIL ${name}`);
		failures++;
	}
}

const registered: Record<string, any> = {};
const sent: any[] = [];
const notices: string[] = [];
const pi = {
	setLabel(label: string) {
		check("label is wbl", label === "wbl");
	},
	registerCommand(name: string, command: any) {
		registered[name] = command;
	},
	sendMessage(message: any, options: any) {
		sent.push({ message, options });
	},
};
const ctx = {
	hasUI: true,
	ui: {
		notify(message: string) {
			notices.push(message);
		},
	},
};

wbl(pi as any);
check("registers /wbl", !!registered.wbl);
check("completes loop", registered.wbl.getArgumentCompletions("").some((v: any) => v.value === "loop"));

await registered.wbl.handler("", ctx);
check("sends one loop message", sent.length === 1);
check("message type", sent[0]?.message?.customType === "wb-loop");
check("message contains protocol", sent[0]?.message?.content === WB_LOOP_MESSAGE && WB_LOOP_MESSAGE.includes("reserved `/wb` whiteboard FIRST"));
check("message triggers turn", sent[0]?.options?.deliverAs === "nextTurn" && sent[0]?.options?.triggerTurn === true);
check("notifies queued", notices.includes("wbl: loop queued"));

await registered.wbl.handler("im certain", ctx);
check("passes captain note", sent[1]?.message?.content === buildWbLoopMessage("im certain") && sent[1]?.message?.content.includes("Captain note: im certain"));

if (failures) process.exit(1);
console.log("ok - wbl command queues the whiteboard protocol");

