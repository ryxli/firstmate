// wb command extension tests. Run: bun .omp/extensions/wb.test.ts

import wb, { WB_LOOP_MESSAGE } from "./wb";

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
		check("label is wb", label === "wb");
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

wb(pi as any);
check("registers /wb", !!registered.wb);
check("completes loop", registered.wb.getArgumentCompletions("").some((v: any) => v.value === "loop"));

await registered.wb.handler("loop", ctx);
check("sends one loop message", sent.length === 1);
check("message type", sent[0]?.message?.customType === "wb-loop");
check("message contains protocol", sent[0]?.message?.content === WB_LOOP_MESSAGE && WB_LOOP_MESSAGE.includes("Read the shared whiteboard FIRST"));
check("message triggers turn", sent[0]?.options?.deliverAs === "nextTurn" && sent[0]?.options?.triggerTurn === true);
check("notifies queued", notices.includes("wb: loop queued"));

await registered.wb.handler("", ctx);
check("help on missing arg", notices.some(n => n.includes("Usage: /wb loop")));

if (failures) process.exit(1);
console.log("ok - wb loop command queues the whiteboard protocol");
