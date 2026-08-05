import type {
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
	deriveMessageIdentity,
	currentCoordinationScope,
	ProtocolInvariantError,
	resolveCommittedToolCall,
	sameToolCallPointer,
	type ToolCallPointer,
} from "./identities.ts";
import {
	inspectStandaloneMessageDelivery,
	type DeliveryInspection,
	type EntryPointer,
	type MessageDeliveryItem,
	type ModelVisibleMessage,
} from "./message-delivery.ts";
import {
	sameAgentMessageInput,
	validateAgentMessageInput,
	type AgentMessageInput,
	type AnswerInput,
	type CancellationInput,
	type MessageDeliveryMode,
	type MessageSendInput,
	type RequestSendInput,
} from "./agent-message-input.ts";

export type { DeliveryInspection, EntryPointer } from "./message-delivery.ts";
export { sameAgentMessageInput, validateAgentMessageInput } from "./agent-message-input.ts";
export type {
	AgentMessageInput,
	AnswerInput,
	CancellationInput,
	MessageDeliveryMode,
	MessagePollInput,
	MessageRetryInput,
	MessageSendInput,
	RequestSendInput,
} from "./agent-message-input.ts";

export type CanonicalMessageInspection =
	| Readonly<{ state: "canonical"; message: Message }>
	| Readonly<{ state: "indeterminate"; message: Message }>
	| Readonly<{ state: "not_created"; message: Message }>;

type MessageSource = Readonly<{
	messageId: string;
	workflowId: string;
	fromAgentId: string;
	targetAgentId: string;
	deliveryMode: MessageDeliveryMode;
	source: ToolCallPointer;
}>;

export type Message =
	| (MessageSource & Readonly<{
		kind: "message";
		origin: "agent_message" | "agent_control";
		content: string;
	}>)
	| (MessageSource & Readonly<{
		kind: "request";
		origin: "agent_message" | "agent_spawn";
		question: string;
	}>)
	| (MessageSource & Readonly<{
		kind: "answer";
		requestId: string;
		answer: string;
	}>)
	| (MessageSource & Readonly<{
		kind: "request_cancellation";
		requestId: string;
		reason: string;
	}>);

export function resolveCommittedMessage(options: {
	fromAgentId: string;
	workflowId: string;
	sessionManager: SessionManager;
	toolCallId: string;
	providedInput: MessageSendInput | RequestSendInput;
}): Message {
	const { fromAgentId, workflowId, sessionManager, toolCallId, providedInput } = options;
	const { source, input } = resolveCommittedToolCall({
		agentId: fromAgentId,
		sessionManager,
		toolCallId,
		toolName: "agent_message",
	});
	const committedInput = validateAgentMessageInput(input);
	if (committedInput.operation !== "send" && committedInput.operation !== "request") {
		throw new Error("invalid_input: Agent Message operation does not author a Message");
	}
	if (!sameAgentMessageInput(committedInput, providedInput)) {
		throw new Error("invariant_violation: executed Agent Message input differs from its source");
	}
	const common = {
		messageId: deriveMessageIdentity(source),
		workflowId,
		fromAgentId,
		targetAgentId: committedInput.targetAgentId,
		deliveryMode: committedInput.deliveryMode ?? "deferred",
		source,
	};
	return committedInput.operation === "send"
		? {
			...common,
			kind: "message",
			origin: "agent_message",
			content: committedInput.content,
		}
		: {
			...common,
			kind: "request",
			origin: "agent_message",
			question: committedInput.question,
		};
}

export function resolveCommittedAnswer(options: {
	responderAgentId: string;
	sessionManager: SessionManager;
	toolCallId: string;
	providedInput: AnswerInput;
	request: Extract<Message, { kind: "request" }>;
}): Extract<Message, { kind: "answer" }> {
	const {
		responderAgentId,
		sessionManager,
		toolCallId,
		providedInput,
		request,
	} = options;
	const { source, input } = resolveCommittedToolCall({
		agentId: responderAgentId,
		sessionManager,
		toolCallId,
		toolName: "agent_message",
	});
	const committedInput = validateAgentMessageInput(input);
	if (committedInput.operation !== "answer") {
		throw new Error("invalid_input: Agent Message operation does not author an Answer");
	}
	if (!sameAgentMessageInput(committedInput, providedInput)) {
		throw new Error("invariant_violation: executed Agent Answer input differs from its source");
	}
	return {
		kind: "answer",
		messageId: deriveMessageIdentity(source),
		workflowId: request.workflowId,
		fromAgentId: responderAgentId,
		targetAgentId: request.fromAgentId,
		deliveryMode: "steer",
		source,
		requestId: request.messageId,
		answer: committedInput.answer,
	};
}

export function resolveCommittedCancellation(options: {
	requesterAgentId: string;
	sessionManager: SessionManager;
	toolCallId: string;
	providedInput: CancellationInput;
	request: Extract<Message, { kind: "request" }>;
}): Extract<Message, { kind: "request_cancellation" }> {
	const {
		requesterAgentId,
		sessionManager,
		toolCallId,
		providedInput,
		request,
	} = options;
	const { source, input } = resolveCommittedToolCall({
		agentId: requesterAgentId,
		sessionManager,
		toolCallId,
		toolName: "agent_message",
	});
	const committedInput = validateAgentMessageInput(input);
	if (committedInput.operation !== "cancel") {
		throw new Error("invalid_input: Agent Message operation does not author a Cancellation");
	}
	if (!sameAgentMessageInput(committedInput, providedInput)) {
		throw new Error(
			"invariant_violation: executed Request Cancellation input differs from its source",
		);
	}
	return {
		kind: "request_cancellation",
		messageId: deriveMessageIdentity(source),
		workflowId: request.workflowId,
		fromAgentId: requesterAgentId,
		targetAgentId: request.targetAgentId,
		deliveryMode: "steer",
		source,
		requestId: request.messageId,
		reason: committedInput.reason,
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

export function inspectCanonicalMessage(options: {
	message: Message;
	authorSessionManager: SessionManager;
	deliveryEvidence?: EntryPointer;
}): CanonicalMessageInspection {
	const { message, authorSessionManager, deliveryEvidence } = options;
	if (message.kind === "request" && message.origin === "agent_spawn") {
		return { state: "canonical", message };
	}
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
		if (isNonAuthoringRequestResult(result.message.details, message)) {
			return { state: "not_created", message };
		}
		validateMessageAuthorResult(result.message.details, message);
		return { state: "canonical", message };
	}
	return deliveryEvidence
		? { state: "canonical", message }
		: { state: "indeterminate", message };
}

function isNonAuthoringRequestResult(value: unknown, message: Message): boolean {
	if (
		(message.kind !== "answer" && message.kind !== "request_cancellation") ||
		!isRecord(value) ||
		value.requestId !== message.requestId
	) {
		return false;
	}
	const keys = Object.keys(value).sort();
	if (value.disposition === "already_answered") {
		return sameStringList(
			keys,
			["answerId", "disposition", "messageId", "requestId"],
		) &&
			typeof value.answerId === "string" &&
			value.answerId.length > 0 &&
			value.messageId === value.answerId;
	}
	if (value.disposition === "already_cancelled") {
		return sameStringList(
			keys,
			["cancellationId", "disposition", "messageId", "requestId"],
		) &&
			typeof value.cancellationId === "string" &&
			value.cancellationId.length > 0 &&
			value.messageId === value.cancellationId;
	}
	return false;
}

function validateMessageAuthorResult(value: unknown, message: Message): void {
	const { messageId } = message;
	if (!isRecord(value)) {
		throw new Error(
			`invariant_violation: Message ${messageId} author result has an invalid shape`,
		);
	}
	const keys = Object.keys(value).sort();
	const identityKey = "messageId";
	const correlationKeys = message.kind === "answer"
		? ["requestId"]
		: message.kind === "request_cancellation"
			? ["cancellationId", "requestId"]
			: message.kind === "request"
				? ["requestId"]
			: [];
	if (value.delivery === "pending" || value.delivery === "indeterminate") {
		if (!sameStringList(keys, ["delivery", identityKey, ...correlationKeys].sort())) {
			throw new Error(
				`invariant_violation: Message ${messageId} author result has an invalid shape`,
			);
		}
	} else if (value.delivery === "rejected") {
		if (
			!sameStringList(
				keys,
				["delivery", identityKey, ...correlationKeys, "rejectionReason"].sort(),
			) ||
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
	if (value[identityKey] !== messageId) {
		throw new Error(
			`invariant_violation: Message ${messageId} author result has the wrong identity`,
		);
	}
	if (message.kind === "answer" && value.requestId !== message.requestId) {
		throw new Error(
			`invariant_violation: Answer ${messageId} author result has the wrong Request`,
		);
	}
	if (message.kind === "request" && value.requestId !== message.messageId) {
		throw new Error(
			`invariant_violation: Request ${messageId} author result has the wrong identity`,
		);
	}
	if (
		message.kind === "request_cancellation" &&
		(value.requestId !== message.requestId || value.cancellationId !== message.messageId)
	) {
		throw new Error(
			`invariant_violation: Cancellation ${messageId} author result has invalid correlation`,
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
		expectedProjection: modelVisibleProjection(message),
		subject: `${messageSubject(message)} ${message.messageId}`,
	});
}

export function inspectAnswerDelivery(options: {
	requesterAgentId: string;
	sessionManager: SessionManager;
	answer: Extract<Message, { kind: "answer" }>;
}): DeliveryInspection {
	const { requesterAgentId, sessionManager, answer } = options;
	const customDelivery = inspectMessageDelivery({
		recipientAgentId: requesterAgentId,
		sessionManager,
		message: answer,
	});
	const retrievalEntries: string[] = [];
	for (const entry of currentCoordinationScope(sessionManager, requesterAgentId)) {
		if (
			entry.type !== "message" ||
			entry.message.role !== "toolResult" ||
			entry.message.toolName !== "agent_message" ||
			entry.message.isError ||
			!isRecord(entry.message.details) ||
			entry.message.details.disposition !== "answer_delivered"
		) {
			continue;
		}
		const details = entry.message.details;
		if (!isRecord(details.answerSource)) continue;
		const source = details.answerSource;
		if (
			typeof source.agentId !== "string" ||
			typeof source.entryId !== "string" ||
			typeof source.toolCallId !== "string" ||
			!sameToolCallPointer(source as ToolCallPointer, answer.source)
		) {
			continue;
		}
		const expectedKeys = [
			"answer",
			"answerId",
			"answerSource",
			"disposition",
			"fromAgentId",
			"messageId",
			"requestId",
		];
		if (
			!sameStringList(Object.keys(details).sort(), expectedKeys) ||
			details.messageId !== answer.requestId ||
			details.requestId !== answer.requestId ||
			details.answerId !== answer.messageId ||
			details.fromAgentId !== answer.fromAgentId ||
			details.answer !== answer.answer
		) {
			throw new ProtocolInvariantError(
				`Answer ${answer.messageId} Retrieval differs from its source`,
			);
		}
		retrievalEntries.push(entry.id);
	}
	const matches = [
		...(customDelivery.deliveryEvidence
			? [customDelivery.deliveryEvidence.entryId]
			: []),
		...retrievalEntries,
	];
	if (matches.length > 1) {
		throw new ProtocolInvariantError(`Answer ${answer.messageId} has duplicate Deliveries`);
	}
	return {
		...(matches[0]
			? { deliveryEvidence: { agentId: requesterAgentId, entryId: matches[0] } }
			: {}),
		inspectedThrough: customDelivery.inspectedThrough,
	};
}

export function createMessageDeliveryItem(message: Message): MessageDeliveryItem {
	return {
		source: message.source,
		projection: modelVisibleProjection(message),
	};
}

function modelVisibleProjection(message: Message): ModelVisibleMessage {
	switch (message.kind) {
		case "message":
			return {
				kind: "message",
				messageId: message.messageId,
				fromAgentId: message.fromAgentId,
				content: message.content,
			};
		case "request":
			return {
				kind: "request",
				requestId: message.messageId,
				fromAgentId: message.fromAgentId,
				question: message.question,
			};
		case "answer":
			return {
				kind: "answer",
				answerId: message.messageId,
				requestId: message.requestId,
				fromAgentId: message.fromAgentId,
				answer: message.answer,
			};
		case "request_cancellation":
			return {
				kind: "request_cancellation",
				cancellationId: message.messageId,
				requestId: message.requestId,
				fromAgentId: message.fromAgentId,
				reason: message.reason,
			};
	}
}

function messageSubject(message: Message): string {
	switch (message.kind) {
		case "message":
			return "Message";
		case "request":
			return "Request";
		case "answer":
			return "Answer";
		case "request_cancellation":
			return "Request Cancellation";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
