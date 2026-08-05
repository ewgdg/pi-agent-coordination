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
} from "./message-delivery.ts";

export type { DeliveryInspection, EntryPointer } from "./message-delivery.ts";

export type DeferredMessageSendInput = Readonly<{
	operation: "send";
	targetAgentId: string;
	content: string;
}>;

export type DeferredMessagePollInput = Readonly<{
	operation: "poll";
	messageId: string;
}>;

export type DeferredMessageRetryInput = Readonly<{
	operation: "retry";
	messageId: string;
}>;

export type AgentMessageInput =
	| DeferredMessageSendInput
	| DeferredMessagePollInput
	| DeferredMessageRetryInput;

export type CanonicalMessageInspection =
	| Readonly<{ state: "canonical"; message: DeferredMessage }>
	| Readonly<{ state: "indeterminate"; message: DeferredMessage }>
	| Readonly<{ state: "not_created"; message: DeferredMessage }>;

export type DeferredMessage = Readonly<{
	messageId: string;
	workflowId: string;
	fromAgentId: string;
	targetAgentId: string;
	content: string;
	source: ToolCallPointer;
}>;

export function resolveCommittedDeferredMessage(options: {
	fromAgentId: string;
	workflowId: string;
	sessionManager: SessionManager;
	toolCallId: string;
	providedInput: DeferredMessageSendInput;
}): DeferredMessage {
	const { fromAgentId, workflowId, sessionManager, toolCallId, providedInput } = options;
	const { source, input } = resolveCommittedToolCall({
		agentId: fromAgentId,
		sessionManager,
		toolCallId,
		toolName: "agent_message",
	});
	const committedInput = validateDeferredMessageSendInput(input);
	if (!sameAgentMessageInput(committedInput, providedInput)) {
		throw new Error("invariant_violation: executed Agent Message input differs from its source");
	}
	return {
		messageId: deriveMessageIdentity(source),
		workflowId,
		fromAgentId,
		targetAgentId: committedInput.targetAgentId,
		content: committedInput.content,
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
				left.content === right.content;
		case "poll":
			return right.operation === "poll" && left.messageId === right.messageId;
		case "retry":
			return right.operation === "retry" && left.messageId === right.messageId;
	}
}

export function findAuthoredDeferredMessage(options: {
	fromAgentId: string;
	workflowId: string;
	sessionManager: SessionManager;
	messageId: string;
}): DeferredMessage | undefined {
	const { fromAgentId, workflowId, sessionManager, messageId } = options;
	const matches: DeferredMessage[] = [];
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
	message: DeferredMessage;
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
		validateDeferredMessageAuthorResult(result.message.details, message.messageId);
		return { state: "canonical", message };
	}
	return deliveryEvidence
		? { state: "canonical", message }
		: { state: "indeterminate", message };
}

function validateDeferredMessageAuthorResult(value: unknown, messageId: string): void {
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
				value.rejectionReason !== "host_shutting_down")
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

export function inspectDeferredMessageDelivery(options: {
	recipientAgentId: string;
	sessionManager: SessionManager;
	message: DeferredMessage;
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
		subject: `Deferred Message ${message.messageId}`,
	});
}

export function createDeferredMessageDelivery(message: DeferredMessage): {
	customType: "agent-coordination.message-delivery";
	content: string;
	display: true;
	details: { messages: readonly [ToolCallPointer] };
} {
	return {
		customType: "agent-coordination.message-delivery",
		content: JSON.stringify({
			messages: [
				{
					kind: "message",
					messageId: message.messageId,
					fromAgentId: message.fromAgentId,
					content: message.content,
				},
			],
		}),
		display: true,
		details: { messages: [message.source] },
	};
}

function validateDeferredMessageSendInput(
	value: Record<string, unknown>,
): DeferredMessageSendInput {
	const keys = Object.keys(value).sort();
	if (!sameStringList(keys, ["content", "operation", "targetAgentId"])) {
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
	return {
		operation: "send",
		targetAgentId: value.targetAgentId,
		content: value.content,
	};
}

function validateAgentMessageInput(value: Record<string, unknown>): AgentMessageInput {
	if (value.operation === "send") return validateDeferredMessageSendInput(value);
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
