import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

import type { ChildAgentIdentity } from "./child-identity.ts";
import {
	deriveMessageIdentity,
	type ToolCallPointer,
} from "./identities.ts";
import type { Message } from "./message.ts";
import {
	inspectStandaloneMessageDelivery,
	type DeliveryInspection,
	type MessageDeliveryItem,
} from "./message-delivery.ts";

/** Loaded child records already contain the reconstructed canonical spawn input. */
export function resolveCreationRequest(options: {
	childIdentity: ChildAgentIdentity;
	creationInput: import("./agent-spawn-input.ts").AgentSpawnInput;
}): Extract<Message, { kind: "request" }> {
	const { childIdentity, creationInput } = options;
	return {
		kind: "request",
		origin: "agent_spawn",
		messageId: deriveMessageIdentity(childIdentity.spawnSource),
		workflowId: childIdentity.workflowId,
		fromAgentId: childIdentity.directSpawnerAgentId,
		targetAgentId: childIdentity.agentId,
		deliveryMode: "deferred",
		source: childIdentity.spawnSource,
		question: creationInput.request,
	};
}

export function createCreationRequestDeliveryItem(options: {
	requestId: string;
	fromAgentId: string;
	question: string;
	source: ToolCallPointer;
}): MessageDeliveryItem {
	const { requestId, fromAgentId, question, source } = options;
	return {
		source,
		projection: {
			kind: "request",
			requestMessageId: requestId,
			fromAgentId,
			question,
		},
	};
}

export function inspectCreationRequestDelivery(options: {
	recipientAgentId: string;
	transcript: TranscriptInspection;
	requestId: string;
	fromAgentId: string;
	question: string;
	source: ToolCallPointer;
}): DeliveryInspection {
	const {
		recipientAgentId,
		transcript,
		requestId,
		fromAgentId,
		question,
		source,
	} = options;
	return inspectStandaloneMessageDelivery({
		recipientAgentId,
		transcript,
		source,
		expectedProjection: {
			kind: "request",
			requestMessageId: requestId,
			fromAgentId,
			question,
		},
		subject: `Creation Request ${requestId}`,
	});
}
