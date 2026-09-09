import { coordinationEntries } from "../transcript/retained-transcript.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import type { EntryPointer } from "./moderator-input.ts";
import { ProtocolInvariantError } from "./identities.ts";

import { WORKFLOW_CONTINUATION_CUSTOM_TYPE } from "./custom-entry-types.ts";
export { WORKFLOW_CONTINUATION_CUSTOM_TYPE } from "./custom-entry-types.ts";

export type ModelVisibleWorkflowContinuation = Readonly<{
	customType: typeof WORKFLOW_CONTINUATION_CUSTOM_TYPE;
	content: string;
	display: true;
}>;

export function createWorkflowContinuation(options: {
	agentId: string;
	runSequence: number;
	requestMessageIds: readonly string[];
}): ModelVisibleWorkflowContinuation {
	return {
		customType: WORKFLOW_CONTINUATION_CUSTOM_TYPE,
		display: true,
		content: JSON.stringify({
			...options,
			guidance: "The Owner explicitly requested workflow continuation. Continue the outstanding Request work under your existing Answer obligations. Inspect interrupted tool side effects before repeating any operation; do not assume an interrupted tool did nothing. This is runtime-generated continuation, not a new Message or Request.",
		}),
	};
}

export function inspectWorkflowContinuation(
	agentId: string,
	transcript: TranscriptInspection,
	message: ModelVisibleWorkflowContinuation,
): EntryPointer | undefined {
	const matches = coordinationEntries(transcript, agentId, `custom:${WORKFLOW_CONTINUATION_CUSTOM_TYPE}`)
		.filter((entry) => entry.type === "custom_message" &&
			entry.customType === message.customType &&
			entry.content === message.content && entry.display);
	if (matches.length > 1) {
		throw new ProtocolInvariantError("Workflow continuation has duplicate Deliveries");
	}
	return matches[0] ? { agentId, entryId: matches[0].id } : undefined;
}
