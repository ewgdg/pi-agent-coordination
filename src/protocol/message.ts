import type {
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
	deriveMessageIdentity,
	currentCoordinationScope,
	ProtocolInvariantError,
	resolveCommittedToolCall,
	type ToolCallPointer,
} from "./identities.ts";
import {
	inspectStandaloneMessageDelivery,
	type DeliveryInspection,
	type EntryPointer,
	type MessageDeliveryItem,
} from "./message-delivery.ts";

export type { DeliveryInspection, EntryPointer } from "./message-delivery.ts";

export type MessageDeliveryMode = "deferred" | "steer";

export type MessageSendInput = Readonly<{
	operation: "send";
	targetAgentId: string;
	content: string;
	deliveryMode?: MessageDeliveryMode;
}>;

export type MessagePollInput = Readonly<{
	operation: "poll";
	messageId: string;
}>;

export type MessageRetryInput = Readonly<{
	operation: "retry";
	messageId: string;
}>;

export type AgentMessageInput =
	| MessageSendInput
	| MessagePollInput
	| MessageRetryInput;

export type CanonicalMessageInspection =
	| Readonly<{ state: "canonical"; message: Message }>
	| Readonly<{ state: "indeterminate"; message: Message }>
	| Readonly<{ state: "not_created"; message: Message }>;

export type Message = Readonly<{
	messageId: string;
	workflowId: string;
	fromAgentId: string;
	targetAgentId: string;
	content: string;
	deliveryMode: MessageDeliveryMode;
	source: ToolCallPointer;
}>;

export function resolveCommittedMessage(options: {
	fromAgentId: string;
	workflowId: string;
	sessionManager: SessionManager;
	toolCallId: string;
	providedInput: MessageSendInput;
}): Message {
	const { fromAgentId, workflowId, sessionManager, toolCallId, providedInput } = options;
	const { source, input } = resolveCommittedToolCall({
		agentId: fromAgentId,
		sessionManager,
		toolCallId,
		toolName: "agent_message",
	});
	const committedInput = validateMessageSendInput(input);
	if (!sameAgentMessageInput(committedInput, providedInput)) {
		throw new Error("invariant_violation: executed Agent Message input differs from its source");
	}
	return {
		messageId: deriveMessageIdentity(source),
		workflowId,
		fromAgentId,
		targetAgentId: committedInput.targetAgentId,
		content: committedInput.content,
		deliveryMode: committedInput.deliveryMode ?? "deferred",
		source,
	};
}

export function resolveCommittedAgentMessageInput(options: {
	agentId: string;
	sessionManager: SessionManager;
	toolCallId: string;
}): AgentMessageInput {
	const { input } = resolveCommittedToolCall({
		...options,
		toolName: "agent_message",
	});
	return validateAgentMessageInput(input);
}

export function sameAgentMessageInput(
	left: AgentMessageInput,
	right: AgentMessageInput,
): boolean {
	switch (left.operation) {
		case "send":
			return right.operation === "send" &&
				left.targetAgentId === right.targetAgentId &&
				left.content === right.content &&
				(left.deliveryMode ?? "deferred") ===
					(right.deliveryMode ?? "deferred");
		case "poll":
			return right.operation === "poll" && left.messageId === right.messageId;
		case "retry":
			return right.operation === "retry" && left.messageId === right.messageId;
	}
}

export function findAuthoredMessage(options: {
	fromAgentId: string;
	workflowId: string;
	sessionManager: SessionManager;
	messageId: string;
}): Message | undefined {
	const { fromAgentId, workflowId, sessionManager, messageId } = options;
	const matches: Message[] = [];
	for (const entry of currentCoordinationScope(sessionManager, fromAgentId)) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content) {
			if (part.type !== "toolCall" || part.name !== "agent_message") continue;
			let input: AgentMessageInput;
			try {
				input = validateAgentMessageInput(part.arguments);
			} catch {
				throw new ProtocolInvariantError(
					`committed agent_message source ${part.id} is invalid`,
				);
			}
			if (input.operation !== "send") continue;
			const source = {
				agentId: fromAgentId,
				entryId: entry.id,
				toolCallId: part.id,
			};
			if (deriveMessageIdentity(source) !== messageId) continue;
			matches.push({
				messageId,
				workflowId,
				fromAgentId,
				targetAgentId: input.targetAgentId,
				content: input.content,
				deliveryMode: input.deliveryMode ?? "deferred",
				source,
			});
		}
	}
	if (matches.length > 1) {
		throw new Error(`invariant_violation: Message ${messageId} has multiple author sources`);
	}
	return matches[0];
}

export function inspectCanonicalMessage(options: {
	message: Message;
	authorSessionManager: SessionManager;
	deliveryEvidence?: EntryPointer;
}): CanonicalMessageInspection {
	const { message, authorSessionManager, deliveryEvidence } = options;
	const results = currentCoordinationScope(authorSessionManager, message.fromAgentId).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "agent_message" &&
			entry.message.toolCallId === message.source.toolCallId,
	);
	if (results.length > 1) {
		throw new Error(`invariant_violation: Message ${message.messageId} has multiple author results`);
	}
	const result = results[0];
	if (result && result.type === "message" && result.message.role === "toolResult") {
		if (result.message.isError) {
			if (deliveryEvidence) {
				throw new Error(
					`invariant_violation: Message ${message.messageId} has an error result and Delivery`,
				);
			}
			return { state: "not_created", message };
		}
		validateMessageAuthorResult(result.message.details, message.messageId);
		return { state: "canonical", message };
	}
	return deliveryEvidence
		? { state: "canonical", message }
		: { state: "indeterminate", message };
}

function validateMessageAuthorResult(value: unknown, messageId: string): void {
	if (!isRecord(value)) {
		throw new Error(
			`invariant_violation: Message ${messageId} author result has an invalid shape`,
		);
	}
	const keys = Object.keys(value).sort();
	if (value.delivery === "pending" || value.delivery === "indeterminate") {
		if (!sameStringList(keys, ["delivery", "messageId"])) {
			throw new Error(
				`invariant_violation: Message ${messageId} author result has an invalid shape`,
			);
		}
	} else if (value.delivery === "rejected") {
		if (
			!sameStringList(keys, ["delivery", "messageId", "rejectionReason"]) ||
			(value.rejectionReason !== "target_unavailable" &&
				value.rejectionReason !== "host_shutting_down" &&
				value.rejectionReason !== "capacity_exhausted")
		) {
			throw new Error(
				`invariant_violation: Message ${messageId} author result has an invalid shape`,
			);
		}
	} else {
		throw new Error(
			`invariant_violation: Message ${messageId} author result has an invalid shape`,
		);
	}
	if (value.messageId !== messageId) {
		throw new Error(
			`invariant_violation: Message ${messageId} author result has the wrong identity`,
		);
	}
}

export function inspectMessageDelivery(options: {
	recipientAgentId: string;
	sessionManager: SessionManager;
	message: Message;
}): DeliveryInspection {
	const { recipientAgentId, sessionManager, message } = options;
	return inspectStandaloneMessageDelivery({
		recipientAgentId,
		sessionManager,
		source: message.source,
		expectedProjection: {
			kind: "message",
			messageId: message.messageId,
			fromAgentId: message.fromAgentId,
			content: message.content,
		},
		subject: `Message ${message.messageId}`,
	});
}

export function createMessageDeliveryItem(message: Message): MessageDeliveryItem {
	return {
		source: message.source,
		projection: {
			kind: "message",
			messageId: message.messageId,
			fromAgentId: message.fromAgentId,
			content: message.content,
		},
	};
}

function validateMessageSendInput(
	value: Record<string, unknown>,
): MessageSendInput {
	const keys = Object.keys(value).sort();
	const expectedKeys = value.deliveryMode === undefined
		? ["content", "operation", "targetAgentId"]
		: ["content", "deliveryMode", "operation", "targetAgentId"];
	if (!sameStringList(keys, expectedKeys)) {
		throw new Error("invalid_input: Agent Message send input has an invalid shape");
	}
	if (value.operation !== "send") {
		throw new Error("invalid_input: Agent Message operation must be send");
	}
	if (typeof value.targetAgentId !== "string" || value.targetAgentId.length === 0) {
		throw new Error("invalid_input: Agent Message targetAgentId must not be empty");
	}
	if (typeof value.content !== "string" || value.content.length === 0) {
		throw new Error("invalid_input: Agent Message content must not be empty");
	}
	if (
		value.deliveryMode !== undefined &&
		value.deliveryMode !== "deferred" &&
		value.deliveryMode !== "steer"
	) {
		throw new Error("invalid_input: Agent Message deliveryMode is unavailable");
	}
	return {
		operation: "send",
		targetAgentId: value.targetAgentId,
		content: value.content,
		...(value.deliveryMode === undefined
			? {}
			: { deliveryMode: value.deliveryMode }),
	};
}

function validateAgentMessageInput(value: Record<string, unknown>): AgentMessageInput {
	if (value.operation === "send") return validateMessageSendInput(value);
	const keys = Object.keys(value).sort();
	if (!sameStringList(keys, ["messageId", "operation"])) {
		throw new Error("invalid_input: Agent Message poll input has an invalid shape");
	}
	if (value.operation !== "poll" && value.operation !== "retry") {
		throw new Error("invalid_input: Agent Message operation is unavailable");
	}
	if (typeof value.messageId !== "string" || value.messageId.length === 0) {
		throw new Error("invalid_input: Agent Message messageId must not be empty");
	}
	return { operation: value.operation, messageId: value.messageId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
