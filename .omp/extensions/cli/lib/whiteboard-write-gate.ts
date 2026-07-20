// Whiteboard write gate: write only when lane state, evidence, disposition,
// decision, or wake condition changes. Behavioral source of truth for
// skill://fm-supervise-lanes.

export type WhiteboardEventKind =
	| "duplicate-reviewer-completion"
	| "noop-system-notice"
	| "new-rejection"
	| "worker-working-to-ready"
	| "wake-condition-changed"
	| "cap-decision"
	| "lane-state-changed"
	| "evidence-changed"
	| "disposition-changed"
	| "other";

export interface WhiteboardEvent {
	kind: WhiteboardEventKind;
	/** True when this event duplicates a prior identical reviewer completion. */
	duplicate?: boolean;
	/** Disposition text for rejection/decision events. */
	disposition?: string;
	/** Prior accepted board lines that must remain after a real transition. */
	priorAccepted?: string[];
}

export interface WhiteboardWriteDecision {
	write: boolean;
	reason: string;
	disposition?: string;
	preserveAccepted: string[];
}

const WRITE_KINDS = new Set<WhiteboardEventKind>([
	"new-rejection",
	"worker-working-to-ready",
	"wake-condition-changed",
	"cap-decision",
	"lane-state-changed",
	"evidence-changed",
	"disposition-changed",
]);

export function shouldWriteWhiteboard(event: WhiteboardEvent): WhiteboardWriteDecision {
	const preserveAccepted = [...(event.priorAccepted ?? [])];

	if (event.kind === "duplicate-reviewer-completion" || event.duplicate === true) {
		return { write: false, reason: "duplicate reviewer completion", preserveAccepted };
	}
	if (event.kind === "noop-system-notice") {
		return { write: false, reason: "no-op system notice", preserveAccepted };
	}
	if (!WRITE_KINDS.has(event.kind) && event.kind === "other") {
		return { write: false, reason: "no lane/evidence/disposition/decision/wake change", preserveAccepted };
	}
	if (!WRITE_KINDS.has(event.kind)) {
		return { write: false, reason: `unrecognized non-writing kind: ${event.kind}`, preserveAccepted };
	}

	return {
		write: true,
		reason: `state change: ${event.kind}`,
		disposition: event.disposition,
		preserveAccepted,
	};
}

/** Apply a write decision onto a board string for monotonicity checks. */
export function applyWhiteboardWrite(
	board: string,
	decision: WhiteboardWriteDecision,
	line: string,
): { board: string; wrote: boolean } {
	if (!decision.write) return { board, wrote: false };
	const next = board.endsWith("\n") || board.length === 0 ? `${board}${line}\n` : `${board}\n${line}\n`;
	for (const accepted of decision.preserveAccepted) {
		if (!next.includes(accepted)) {
			throw new Error(`monotonicity violated: missing prior accepted state: ${accepted}`);
		}
	}
	return { board: next, wrote: true };
}
