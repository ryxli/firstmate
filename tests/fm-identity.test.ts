// Unit tests for .omp/extensions/fm-identity/identity.ts
// Run: bun test tests/fm-identity.test.ts
import { describe, expect, it } from "bun:test";

import {
	buildMetadataRequest,
	buildRenameRequest,
	CURRENT_SCHEMA_VERSION,
	IDENTITY_SOURCE,
	isVersioned,
	parseIdentityFile,
	planPropagation,
	resolveHome,
	resolveIdentity,
	slug,
} from "../.omp/extensions/fm-identity/identity";

describe("parseIdentityFile", () => {
	it("parses key=value pairs", () => {
		expect(parseIdentityFile("name=Riggs\nrole=Harness")).toEqual({
			name: "Riggs",
			role: "Harness",
		});
	});

	it("ignores blank lines and comments", () => {
		expect(parseIdentityFile("# comment\n\nname=Fran")).toEqual({ name: "Fran" });
	});

	it("last key wins on duplicates", () => {
		expect(parseIdentityFile("name=First\nname=Second")).toEqual({ name: "Second" });
	});

	it("handles value with embedded equals", () => {
		expect(parseIdentityFile("role=a=b=c")).toEqual({ role: "a=b=c" });
	});

	it("returns empty object for empty string", () => {
		expect(parseIdentityFile("")).toEqual({});
	});

	it("skips lines with no equals", () => {
		expect(parseIdentityFile("noequals\nname=ok")).toEqual({ name: "ok" });
	});
});

describe("slug", () => {
	it("lowercases and hyphenates spaces", () => {
		expect(slug("Hello World")).toBe("hello-world");
	});

	it("drops non-alphanumeric chars except ._-", () => {
		expect(slug("Keel!@#")).toBe("keel");
	});

	it("collapses multiple spaces", () => {
		expect(slug("a  b")).toBe("a-b");
	});

	it("preserves dots and underscores", () => {
		expect(slug("v1.0_beta")).toBe("v1.0_beta");
	});
});

describe("resolveHome", () => {
	it("prefers FM_HOME when set", () => {
		expect(resolveHome({ FM_HOME: "/mates/riggs", cwd: "/other" })).toBe("/mates/riggs");
	});

	it("falls back to cwd when FM_HOME absent", () => {
		expect(resolveHome({ cwd: "/mates/fran" })).toBe("/mates/fran");
	});

	it("falls back to cwd when FM_HOME is whitespace-only", () => {
		expect(resolveHome({ FM_HOME: "   ", cwd: "/mates/atlas" })).toBe("/mates/atlas");
	});
});

describe("resolveIdentity", () => {
	it("returns null when identityText is null", () => {
		expect(resolveIdentity("/home", { markerText: null, identityText: null })).toBeNull();
	});

	it("returns null when name= is missing", () => {
		expect(
			resolveIdentity("/home", { markerText: null, identityText: "role=Engineer" }),
		).toBeNull();
	});

	it("returns null when name= is empty", () => {
		expect(
			resolveIdentity("/home", { markerText: null, identityText: "name=" }),
		).toBeNull();
	});

	it("uses marker as id when present", () => {
		const r = resolveIdentity("/home", {
			markerText: "riggs",
			identityText: "name=Riggs\nrole=Harness",
		});
		expect(r).not.toBeNull();
		expect(r!.id).toBe("riggs");
		expect(r!.name).toBe("Riggs");
		expect(r!.role).toBe("Harness");
	});

	it("falls back to slug(name) when marker is absent", () => {
		const r = resolveIdentity("/home", {
			markerText: null,
			identityText: "name=My Agent",
		});
		expect(r!.id).toBe("my-agent");
	});

	it("falls back to slug(name) when marker is empty string", () => {
		const r = resolveIdentity("/home", {
			markerText: "",
			identityText: "name=Keel",
		});
		expect(r!.id).toBe("keel");
	});

	it("home is preserved in result", () => {
		const r = resolveIdentity("/mates/riggs", {
			markerText: "riggs",
			identityText: "name=Riggs",
		});
		expect(r!.home).toBe("/mates/riggs");
	});
});

describe("buildRenameRequest", () => {
	it("produces agent.rename with target and name", () => {
		expect(buildRenameRequest("w1:p2", "riggs")).toEqual({
			method: "agent.rename",
			params: { target: "w1:p2", name: "riggs" },
		});
	});
});

describe("buildMetadataRequest", () => {
	it("produces pane.report_metadata with name and role title", () => {
		const identity = {
			home: "/h",
			id: "riggs",
			name: "Riggs",
			role: "Harness",
			fields: {},
		};
		const req = buildMetadataRequest("w1:p2", identity);
		expect(req.method).toBe("pane.report_metadata");
		expect(req.params.source).toBe(IDENTITY_SOURCE);
		expect(req.params.display_agent).toBe("Riggs");
		expect(req.params.title).toBe("Riggs - Harness");
	});

	it("omits role from title when role is empty", () => {
		const identity = { home: "/h", id: "fran", name: "Fran", role: "", fields: {} };
		const req = buildMetadataRequest("w1:p1", identity);
		expect(req.params.title).toBe("Fran");
	});
});

describe("planPropagation", () => {
	const herdrEnv = {
		cwd: "/mates/riggs",
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		HERDR_PANE_ID: "w2:p1",
	};
	const herdrFiles = {
		markerText: "riggs",
		identityText: "name=Riggs\nrole=Harness",
	};

	it("returns null when HERDR_ENV is not 1", () => {
		expect(planPropagation({ ...herdrEnv, HERDR_ENV: undefined }, herdrFiles)).toBeNull();
	});

	it("returns null when HERDR_PANE_ID is absent", () => {
		expect(
			planPropagation({ ...herdrEnv, HERDR_PANE_ID: undefined }, herdrFiles),
		).toBeNull();
	});

	it("returns null when HERDR_SOCKET_PATH is absent", () => {
		expect(
			planPropagation({ ...herdrEnv, HERDR_SOCKET_PATH: undefined }, herdrFiles),
		).toBeNull();
	});

	it("returns null when not a named mate (no name=)", () => {
		expect(planPropagation(herdrEnv, { markerText: "riggs", identityText: null })).toBeNull();
	});

	it("returns plan with rename + metadata requests for a named mate", () => {
		const plan = planPropagation(herdrEnv, herdrFiles);
		expect(plan).not.toBeNull();
		expect(plan!.label).toBe("Riggs");
		expect(plan!.requests).toHaveLength(2);
		expect(plan!.requests[0].method).toBe("agent.rename");
		expect(plan!.requests[1].method).toBe("pane.report_metadata");
	});

	it("skips the status-resetting rename when the launcher already owns the canonical slot", () => {
		const plan = planPropagation({ ...herdrEnv, FM_AGENT_SLOT: "riggs" }, herdrFiles);
		expect(plan).not.toBeNull();
		expect(plan!.requests).toEqual([buildMetadataRequest("w2:p1", plan!.identity)]);
	});
});

describe("isVersioned", () => {
	it("returns true when schema_version=1", () => {
		const r = resolveIdentity("/h", {
			markerText: "fran",
			identityText: "schema_version=1\nname=Fran\nrole=Schwarzwald",
		});
		expect(r).not.toBeNull();
		expect(isVersioned(r!)).toBe(true);
	});

	it("returns false when schema_version is absent", () => {
		const r = resolveIdentity("/h", {
			markerText: "fran",
			identityText: "name=Fran\nrole=Schwarzwald",
		});
		expect(r).not.toBeNull();
		expect(isVersioned(r!)).toBe(false);
	});

	it("returns false when schema_version is wrong value", () => {
		const r = resolveIdentity("/h", {
			markerText: "fran",
			identityText: "schema_version=2\nname=Fran",
		});
		expect(r).not.toBeNull();
		expect(isVersioned(r!)).toBe(false);
	});

	it("CURRENT_SCHEMA_VERSION is '1'", () => {
		expect(CURRENT_SCHEMA_VERSION).toBe("1");
	});

	it("unversioned file still resolves (backward compat)", () => {
		const r = resolveIdentity("/h", {
			markerText: "keel",
			identityText: "name=Keel\nrole=Main firstmate crew supervisor",
		});
		expect(r).not.toBeNull();
		expect(r!.name).toBe("Keel");
		expect(r!.fields.schema_version).toBeUndefined();
		expect(isVersioned(r!)).toBe(false);
	});
});
