import type { SessionManager } from "@earendil-works/pi-coding-agent";

import type { ChildAgentIdentity } from "./child-identity.ts";
import {
	deriveMessageIdentity,
	ProtocolInvariantError,
	resolveCommittedSpawnSource,
	type ToolCallPointer,
} from "./identities.ts";
import type { Message } from "./message.ts";
import { validateAgentSpawnInput } from "./agent-spawn-input.ts";
import {
	inspectStandaloneMessageDelivery,
	type DeliveryInspection,
	type MessageDeliveryItem,
} from "./message-delivery.ts";

export function resolveCreationRequest(options: {
	requestId: string;
	workflowId: string;
	spawnerSessionManager: SessionManager;
	childIdentity: ChildAgentIdentity;
}): Extract<Message, { kind: "request" }> {
	const {
		requestId,
		workflowId,
		spawnerSessionManager,
		childIdentity,
	} = options;
	const source = childIdentity.spawnSource;
	if (
		childIdentity.workflowId !== workflowId ||
		source.agentId !== childIdentity.directSpawnerAgentId ||
		deriveMessageIdentity(source) !== requestId
	) {
		throw new ProtocolInvariantError(
			`Creation Request ${requestId} contradicts its child Identity`,
		);
	}
	const { input } = resolveCommittedSpawnSource({
		agentId: childIdentity.directSpawnerAgentId,
		sessionManager: spawnerSessionManager,
		toolCallId: source.toolCallId,
	});
	let spawnInput;
	try {
		spawnInput = validateAgentSpawnInput(input);
	} catch {
		throw new ProtocolInvariantError(
			`Creation Request ${requestId} has an invalid Agent Spawn source`,
		);
	}
	return {
		kind: "request",
		origin: "agent_spawn",
		messageId: requestId,
		workflowId,
		fromAgentId: childIdentity.directSpawnerAgentId,
		targetAgentId: childIdentity.agentId,
		deliveryMode: "deferred",
		source,
		question: spawnInput.request,
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
		projection: { kind: "request", requestId, fromAgentId, question },
	};
}

export function inspectCreationRequestDelivery(options: {
	recipientAgentId: string;
	sessionManager: SessionManager;
	requestId: string;
	fromAgentId: string;
	question: string;
	source: ToolCallPointer;
}): DeliveryInspection {
	const {
		recipientAgentId,
		sessionManager,
		requestId,
		fromAgentId,
		question,
		source,
	} = options;
	return inspectStandaloneMessageDelivery({
		recipientAgentId,
		sessionManager,
		source,
		expectedProjection: {
			kind: "request",
			requestId,
			fromAgentId,
			question,
		},
		subject: `Creation Request ${requestId}`,
	});
}
