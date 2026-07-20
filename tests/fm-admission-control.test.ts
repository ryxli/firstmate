// Admission-control: captainContextBlock, mainPreloadBlock, identity name bound.
// Run: bun test tests/fm-admission-control.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CAPTAIN_CONTEXT_MAX_BYTES,
	CaptainContextOversizeError,
	STARTUP_PRELOAD_STUB,
	captainContextBlock,
	mainPreloadBlock,
	normalizeCaptainPayload,
} from "../.omp/extensions/cli/lib/startup-context";
import {
	IDENTITY_DISPLAY_NAME_MAX_BYTES,
	IdentityNameOversizeError,
	assertIdentityDisplayName,
	mainRoleContract,
	roleContractForHome,
} from "../.omp/extensions/cli/lib/role-contract";
import { utf8ByteLength } from "../.omp/extensions/cli/lib/identity";

function tempHome(): string {
	const home = mkdtempSync(join(tmpdir(), "fm-admission-"));
	mkdirSync(join(home, "data"), { recursive: true });
	mkdirSync(join(home, "config"), { recursive: true });
	return home;
}

describe("normalizeCaptainPayload", () => {
	it("keeps one terminal newline and preserves leading whitespace", () => {
		expect(normalizeCaptainPayload("  hello\n\n\n")).toBe("  hello\n");
		expect(normalizeCaptainPayload("hello")).toBe("hello\n");
	});
});

describe("captainContextBlock / mainPreloadBlock", () => {
	it("omits captain when missing and returns stub only", () => {
		const home = tempHome();
		try {
			expect(captainContextBlock(home)).toBeNull();
			const preload = mainPreloadBlock(home);
			expect(preload).toBe(STARTUP_PRELOAD_STUB.replace(/\n+$/u, ""));
			expect(preload).not.toContain("# Preloaded fleet registries");
			expect(preload).not.toContain("## data/projects.md");
			expect(preload).not.toContain("## data/secondmates.md");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("admits compact cap and preserves terminal newline in preload join", () => {
		const home = tempHome();
		const body = "# Captain preferences\n\nTerse.\n";
		writeFileSync(join(home, "data", "cap.md"), body);
		try {
			const admitted = captainContextBlock(home);
			expect(admitted).toBe(normalizeCaptainPayload(body));
			const stubPart = STARTUP_PRELOAD_STUB.replace(/\n+$/u, "");
			const preload = mainPreloadBlock(home);
			expect(Buffer.byteLength(preload, "utf8")).toBe(
				Buffer.byteLength(stubPart, "utf8") + 2 + Buffer.byteLength(admitted!, "utf8"),
			);
			expect(preload.startsWith(stubPart + "\n\n")).toBe(true);
			expect(preload.endsWith("\n")).toBe(true);
			expect(preload).toContain("# Captain preferences");
			expect(preload).not.toContain("# Preloaded fleet registries");
			expect(preload).not.toContain("SENTINEL_PROJECT_DESCRIPTION_NOT_ADMITTED");
			expect(preload).not.toContain("SENTINEL_MATE_SCOPE_NOT_ADMITTED");
			expect(preload).not.toContain("SENTINEL_HOME_PATH_NOT_ADMITTED");
			expect(preload).not.toContain("SENTINEL_HISTORICAL_MODEL_ROSTER");
			expect(preload).not.toContain("SENTINEL_UPDATE_TARGET_NOT_ADMITTED");
			expect(preload).not.toContain("/Users/");
			expect(preload).not.toContain("home: /");
			expect(preload).not.toContain("added 2026-");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("does not admit planted registry sentinels from projects/secondmates files", () => {
		const home = tempHome();
		writeFileSync(join(home, "data", "cap.md"), "# Captain preferences\nok\n");
		writeFileSync(
			join(home, "data", "projects.md"),
			`- demo [trunk] - SENTINEL_PROJECT_DESCRIPTION_NOT_ADMITTED (added 2026-01-01)\n`,
		);
		writeFileSync(
			join(home, "data", "secondmates.md"),
			`- x - SENTINEL_MATE_SCOPE_NOT_ADMITTED (home: SENTINEL_HOME_PATH_NOT_ADMITTED; added 2026-01-01)\n`,
		);
		writeFileSync(join(home, "data", "update-targets.md"), "- SENTINEL_UPDATE_TARGET_NOT_ADMITTED\n");
		try {
			const preload = mainPreloadBlock(home);
			expect(preload).not.toContain("SENTINEL_PROJECT_DESCRIPTION_NOT_ADMITTED");
			expect(preload).not.toContain("SENTINEL_MATE_SCOPE_NOT_ADMITTED");
			expect(preload).not.toContain("SENTINEL_HOME_PATH_NOT_ADMITTED");
			expect(preload).not.toContain("SENTINEL_UPDATE_TARGET_NOT_ADMITTED");
			expect(preload).not.toContain("## data/projects.md");
			expect(preload).not.toContain("## data/secondmates.md");
			expect(preload).not.toContain("added 2026-01-01");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("admits exactly at the captain byte ceiling", () => {
		const home = tempHome();
		const prefix = "# Captain preferences\n\n";
		const pad = "x".repeat(CAPTAIN_CONTEXT_MAX_BYTES - Buffer.byteLength(prefix, "utf8") - 1);
		const raw = `${prefix}${pad}`;
		const admitted = normalizeCaptainPayload(raw);
		expect(Buffer.byteLength(admitted, "utf8")).toBe(CAPTAIN_CONTEXT_MAX_BYTES);
		writeFileSync(join(home, "data", "cap.md"), raw);
		try {
			expect(captainContextBlock(home)).toBe(admitted);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("fails closed one byte over the captain ceiling and never truncates", () => {
		const home = tempHome();
		const path = join(home, "data", "cap.md");
		const prefix = "# Captain preferences\n\n";
		const pad = "x".repeat(CAPTAIN_CONTEXT_MAX_BYTES - Buffer.byteLength(prefix, "utf8"));
		const raw = `${prefix}${pad}`;
		expect(Buffer.byteLength(normalizeCaptainPayload(raw), "utf8")).toBe(CAPTAIN_CONTEXT_MAX_BYTES + 1);
		writeFileSync(path, raw);
		try {
			expect(() => captainContextBlock(home)).toThrow(CaptainContextOversizeError);
			try {
				captainContextBlock(home);
			} catch (error) {
				const err = error as CaptainContextOversizeError;
				expect(err.path).toBe(path);
				expect(err.actualBytes).toBe(CAPTAIN_CONTEXT_MAX_BYTES + 1);
				expect(err.maxBytes).toBe(CAPTAIN_CONTEXT_MAX_BYTES);
			}
			expect(() => mainPreloadBlock(home)).toThrow(CaptainContextOversizeError);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("counts multibyte UTF-8 at the captain ceiling without truncating", () => {
		const home = tempHome();
		const prefix = "# Captain preferences\n\n";
		const budget = CAPTAIN_CONTEXT_MAX_BYTES - Buffer.byteLength(prefix, "utf8") - 1;
		const chars = Math.floor(budget / 2);
		const raw = `${prefix}${"é".repeat(chars)}`;
		const admitted = normalizeCaptainPayload(raw);
		expect(Buffer.byteLength(admitted, "utf8")).toBeLessThanOrEqual(CAPTAIN_CONTEXT_MAX_BYTES);
		writeFileSync(join(home, "data", "cap.md"), raw);
		try {
			expect(captainContextBlock(home)).toBe(admitted);
			const over = `${prefix}${"é".repeat(chars + 1)}`;
			writeFileSync(join(home, "data", "cap.md"), over);
			expect(() => captainContextBlock(home)).toThrow(CaptainContextOversizeError);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
	it("fails closed when data/cap.md is unreadable for a non-ENOENT reason", () => {
		const home = tempHome();
		const path = join(home, "data", "cap.md");
		mkdirSync(path);
		try {
			expect(() => captainContextBlock(home)).toThrow();
			try {
				captainContextBlock(home);
			} catch (error) {
				expect((error as NodeJS.ErrnoException).code).not.toBe("ENOENT");
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("identity display name bound", () => {
	it("accepts ASCII and multibyte names at 64 UTF-8 bytes", () => {
		const ascii = "A".repeat(IDENTITY_DISPLAY_NAME_MAX_BYTES);
		expect(utf8ByteLength(ascii)).toBe(64);
		assertIdentityDisplayName(ascii);
		const multi = `${"é".repeat(21)}${"B".repeat(22)}`;
		expect(utf8ByteLength(multi)).toBe(64);
		assertIdentityDisplayName(multi);
	});

	it("rejects one byte over and reports field/bytes", () => {
		const over = "A".repeat(IDENTITY_DISPLAY_NAME_MAX_BYTES + 1);
		expect(() => assertIdentityDisplayName(over, "name", "/tmp/identity")).toThrow(IdentityNameOversizeError);
		try {
			assertIdentityDisplayName(over, "name", "/tmp/identity");
		} catch (error) {
			const err = error as IdentityNameOversizeError;
			expect(err.field).toBe("name");
			expect(err.actualBytes).toBe(65);
			expect(err.maxBytes).toBe(64);
			expect(err.path).toBe("/tmp/identity");
		}
	});

	it("fails role-contract generation for a manually oversize identity name", () => {
		const home = tempHome();
		const over = "A".repeat(IDENTITY_DISPLAY_NAME_MAX_BYTES + 1);
		writeFileSync(join(home, "config", "identity"), `schema_version=1\nname=${over}\nrole=firstmate\nparent=captain\n`);
		try {
			expect(() => mainRoleContract({ home })).toThrow(IdentityNameOversizeError);
			expect(() => roleContractForHome(home)).toThrow(IdentityNameOversizeError);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("role contract at max name stays within the main/unverified byte ratchet", () => {
		const home = tempHome();
		const maxName = "A".repeat(IDENTITY_DISPLAY_NAME_MAX_BYTES);
		writeFileSync(join(home, "config", "identity"), `schema_version=1\nname=${maxName}\nrole=firstmate\nparent=captain\n`);
		try {
			const contract = mainRoleContract({ home });
			expect(Buffer.byteLength(contract, "utf8")).toBeLessThanOrEqual(581);
			expect(Buffer.byteLength(contract, "utf8")).toBe(517);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("unverified contracts use bounded status evidence and stay under the role ceiling", () => {
		const home = tempHome();
		// Conflict without a secondmate marker: descriptive role/parent are huge,
		// but kind resolution must still land on unverified (not secondmate write path).
		writeFileSync(
			join(home, "config", "identity"),
			`schema_version=1\nname=Riggs\nrole=${"R".repeat(500)}\nparent=${"P".repeat(500)}\n`,
		);
		try {
			const contract = roleContractForHome(home);
			expect(contract).toContain("kind: unverified");
			expect(contract).toContain("role is set");
			expect(contract).toContain("parent is set");
			expect(contract).not.toContain("R".repeat(20));
			expect(contract).not.toContain("P".repeat(20));
			expect(Buffer.byteLength(contract, "utf8")).toBeLessThanOrEqual(581);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
