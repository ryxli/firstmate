import { createHash } from "node:crypto";

export type CanonicalJson =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalJson[]
	| { readonly [key: string]: CanonicalJson };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertCanonicalValue(value: unknown, path: string): asserts value is CanonicalJson {
	if (value === null || typeof value === "boolean" || typeof value === "string") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
		return;
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			if (!Object.hasOwn(value, index)) throw new TypeError(`${path} must not be a sparse array`);
			assertCanonicalValue(value[index], `${path}[${index}]`);
		}
		return;
	}
	if (!isPlainObject(value)) {
		throw new TypeError(`${path} must be null, a JSON primitive, an array, or a plain object`);
	}
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined) throw new TypeError(`${path}.${key} must not be undefined`);
		assertCanonicalValue(item, `${path}.${key}`);
	}
}

function canonicalize(value: CanonicalJson): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
		.join(",")}}`;
}

/** RFC 8785-style deterministic JSON for the restricted JSON values accepted above. */
export function canonicalJson(value: unknown): string {
	assertCanonicalValue(value, "value");
	return canonicalize(value);
}

export function sha256Hex(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function canonicalSha256(value: unknown): string {
	return sha256Hex(canonicalJson(value));
}
