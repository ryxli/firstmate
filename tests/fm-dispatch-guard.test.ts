import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import dispatchGuard, { managerAgentPrefix, reviewTaskCall } from "../.omp/extensions/dispatch-guard";

const root = mkdtempSync(join(tmpdir(), "fm-dispatch-guard-"));
const homes = Object.fromEntries(["Keel", "Plum", "Kodiak"].map((name) => {
	const home = join(root, name.toLowerCase());
	mkdirSync(join(home, "config"), { recursive: true });
	writeFileSync(join(home, "config", "identity"), `name=${name}\n`);
	return [name, home];
})) as Record<"Keel" | "Plum" | "Kodiak", string>;

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("manager-local named agents", () => {
	test("derives a CamelCase owner prefix from each operational home", () => {
		expect(managerAgentPrefix(homes.Keel)).toBe("KeelLocal");
		expect(managerAgentPrefix(homes.Plum)).toBe("PlumLocal");
		expect(managerAgentPrefix(homes.Kodiak)).toBe("KodiakLocal");
	});

	test.each([
		["Keel", "KeelLocalRecon"],
		["Plum", "PlumLocalRecon"],
		["Kodiak", "KodiakLocalReview"],
	] as const)("%s accepts its own named specialist", (owner, name) => {
		expect(reviewTaskCall({
			toolName: "task",
			input: { tasks: [{ name, task: "Inspect src/app.ts:42." }] },
		}, homes[owner])).toBeUndefined();
	});

	test.each([
		["Plum", "KeelLocalRecon"],
		["Plum", "KodiakLocalReview"],
		["Kodiak", "PlumLocalRecon"],
		["Keel", "Recon"],
	] as const)("%s rejects foreign or unqualified %s", (owner, name) => {
		const decision = reviewTaskCall({
			toolName: "task",
			input: { tasks: [{ name, task: "Inspect src/app.ts:42." }] },
		}, homes[owner]);
		expect(decision?.block).toBeTrue();
		expect(decision?.reason).toContain(`must start with ${owner}Local`);
		expect(decision?.reason).toContain(name);
	});

	test("one foreign name blocks a mixed batch", () => {
		const decision = reviewTaskCall({
			toolName: "task",
			input: {
				tasks: [
					{ name: "PlumLocalRecon", task: "Inspect src/app.ts:42." },
					{ name: "KeelLocalReview", task: "Inspect src/app.ts:42." },
				],
			},
		}, homes.Plum);
		expect(decision?.block).toBeTrue();
		expect(decision?.reason).toContain("KeelLocalReview");
	});

	test("rejects overlapping owner prefixes", () => {
		const home = join(root, "keel-two");
		mkdirSync(join(home, "config"), { recursive: true });
		writeFileSync(join(home, "config", "identity"), "name=Keel Two\n");
		expect(managerAgentPrefix(home)).toBe("KeelTwoLocal");
		expect(reviewTaskCall({
			toolName: "task",
			input: { tasks: [{ name: "KeelLocalRecon", task: "Inspect src/app.ts:42." }] },
		}, home)).toMatchObject({ block: true });
	});

	test("fails closed for named agents when identity is missing", () => {
		const home = join(root, "missing-identity");
		mkdirSync(home);
		expect(managerAgentPrefix(home)).toBeNull();
		const decision = reviewTaskCall({
			toolName: "task",
			input: { tasks: [{ name: "FmLocalRecon", task: "Inspect src/app.ts:42." }] },
		}, home);
		expect(decision).toMatchObject({ block: true });
		expect(decision?.reason).toContain("require config/identity name");
	});

	test("unnamed disposable workers remain allowed", () => {
		expect(reviewTaskCall({
			toolName: "task",
			input: { tasks: [{ task: "Inspect src/app.ts:42." }] },
		}, homes.Plum)).toBeUndefined();
	});
});

describe("dispatch grounding", () => {
	test("checks the current task and name fields", () => {
		const decision = reviewTaskCall({
			toolName: "task",
			input: { tasks: [{ name: "PlumLocalRecon", task: "Fix the bug." }] },
		}, homes.Plum);
		expect(decision?.block).toBeTrue();
		expect(decision?.reason).toContain("lack code grounding");
		expect(decision?.reason).toContain("PlumLocalRecon");
	});

	test("accepts shared grounding and explicit non-code exemptions", () => {
		expect(reviewTaskCall({
			toolName: "task",
			input: {
				context: "Observed lib/core.ts:8-12.",
				tasks: [{ name: "PlumLocalRecon", task: "Apply the established pattern." }],
			},
		}, homes.Plum)).toBeUndefined();
		expect(reviewTaskCall({
			toolName: "task",
			input: { tasks: [{ name: "PlumLocalResearch", task: "GROUNDING-EXEMPT: external API research" }] },
		}, homes.Plum)).toBeUndefined();
	});

	test("preserves legacy single-task input and ignores non-task tools", () => {
		expect(reviewTaskCall({
			toolName: "task",
			input: { id: "PlumLocalLegacy", assignment: "Change src/app.ts:42." },
		}, homes.Plum)).toBeUndefined();
		expect(reviewTaskCall({ toolName: "bash", input: {} }, homes.Plum)).toBeUndefined();
	});

	test("default extension uses FM_HOME ownership", () => {
		const originalHome = process.env.FM_HOME;
		process.env.FM_HOME = homes.Kodiak;
		let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
		dispatchGuard({
			on(event, registered) {
				if (event === "tool_call") handler = registered;
			},
		});
		try {
			expect(handler?.({
				toolName: "task",
				input: { tasks: [{ name: "PlumLocalRecon", task: "Inspect src/app.ts:42." }] },
			}, {})).toMatchObject({ block: true });
		} finally {
			if (originalHome === undefined) delete process.env.FM_HOME;
			else process.env.FM_HOME = originalHome;
		}
	});
});
