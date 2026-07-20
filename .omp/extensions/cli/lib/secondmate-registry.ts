export interface SecondmateRegistryEntry {
	id: string;
	summary: string;
	home: string;
	workspace: string;
	name: string;
	scope: string;
	projects: string;
	added: string;
}

type FieldName = "home" | "workspace" | "name" | "scope" | "projects" | "added";

const FIELD_BOUNDARY = /; (workspace|name|scope|projects): |; (added)(?::)? /g;

/**
 * Parse one registered secondmate roster line.
 *
 * Only explicit, keyed delimiters terminate a field. A bare semicolon in a
 * free-form scope or summary remains part of that field.
 */
export function parseSecondmateRegistryLine(rawLine: string): SecondmateRegistryEntry | null {
	const line = rawLine.trimEnd();
	const idMatch = /^-\s+(\S+)\s+-\s+/.exec(line);
	if (!idMatch) return null;

	const prefixEnd = idMatch[0].length;
	const fieldStart = line.indexOf(" (home: ", prefixEnd);
	if (fieldStart === -1) return null;

	const fieldsText = line.slice(fieldStart + " (home: ".length, line.endsWith(")") ? -1 : undefined);
	const fields: Record<FieldName, string> = {
		home: "",
		workspace: "",
		name: "",
		scope: "",
		projects: "",
		added: "",
	};
	let current: FieldName = "home";
	let valueStart = 0;
	for (const boundary of fieldsText.matchAll(FIELD_BOUNDARY)) {
		fields[current] = fieldsText.slice(valueStart, boundary.index).trim();
		current = (boundary[1] ?? boundary[2]) as FieldName;
		valueStart = (boundary.index ?? 0) + boundary[0].length;
	}
	fields[current] = fieldsText.slice(valueStart).trim();

	return {
		id: idMatch[1],
		summary: line.slice(prefixEnd, fieldStart).trimEnd(),
		...fields,
	};
}
