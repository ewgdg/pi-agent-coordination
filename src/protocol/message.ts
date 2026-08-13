import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

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

export type MessageAuthorResultState = CanonicalMessageInspection["state"];

export type AnswerRetrievalEvidence = Readonly<{
	answerId: string;
	requestId: string;
	fromAgentId: string;
	answer: string;
	answerSource: ToolCallPointer;
	deliveryEvidence: EntryPointer;
}>;

type MessageResultIdentity =
	| Readonly<{ kind: "message"; messageId: string }>
	| Readonly<{ kind: "request"; messageId: string }>
	| Readonly<{ kind: "answer"; messageId: string; requestId: string }>
	| Readonly<{
		kind: "request_cancellation";
		messageId: string;
		requestId: string;
	}>;

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
	transcript: TranscriptInspection;
	toolCallId: string;
	providedInput: MessageSendInput | RequestSendInput;
}): Message {
	const { fromAgentId, workflowId, transcript, toolCallId, providedInput } = options;
	const { source, input } = resolveCommittedToolCall({
		agentId: fromAgentId,
		transcript,
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
	transcript: TranscriptInspection;
	toolCallId: string;
	providedInput: AnswerInput;
	request: Extract<Message, { kind: "request" }>;
}): Extract<Message, { kind: "answer" }> {
	const {
		responderAgentId,
		transcript,
		toolCallId,
		providedInput,
		request,
	} = options;
	const { source, input } = resolveCommittedToolCall({
		agentId: responderAgentId,
		transcript,
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
	transcript: TranscriptInspection;
	toolCallId: string;
	providedInput: CancellationInput;
	request: Extract<Message, { kind: "request" }>;
}): Extract<Message, { kind: "request_cancellation" }> {
	const {
		requesterAgentId,
		transcript,
		toolCallId,
		providedInput,
		request,
	} = options;
	const { source, input } = resolveCommittedToolCall({
		agentId: requesterAgentId,
		transcript,
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
	transcript: TranscriptInspection;
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
	authorTranscript: TranscriptInspection;
	deliveryEvidence?: EntryPointer;
}): CanonicalMessageInspection {
	const { message, authorTranscript, deliveryEvidence } = options;
	if (message.kind === "request" && message.origin === "agent_spawn") {
		return { state: "canonical", message };
	}
	return {
		state: inspectMessageAuthorResult({
			authorAgentId: message.fromAgentId,
			transcript: authorTranscript,
			toolCallId: message.source.toolCallId,
			identity: message,
			deliveryEvidence,
		}),
		message,
	};
}

export function inspectAgentMessageAuthorResult(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
	source: ToolCallPointer;
	input: Exclude<AgentMessageInput, { operation: "poll" | "retry" }>;
}): MessageAuthorResultState {
	const { authorAgentId, transcript, source, input } = options;
	if (source.agentId !== authorAgentId) {
		throw new ProtocolInvariantError("Agent Message source names another author");
	}
	const messageId = deriveMessageIdentity(source);
	const identity: MessageResultIdentity = input.operation === "send"
		? { kind: "message", messageId }
		: input.operation === "request"
			? { kind: "request", messageId }
			: input.operation === "answer"
				? { kind: "answer", messageId, requestId: input.requestId }
				: {
					kind: "request_cancellation",
					messageId,
					requestId: input.requestMessageId,
				};
	return inspectMessageAuthorResult({
		authorAgentId,
		transcript,
		toolCallId: source.toolCallId,
		identity,
	});
}

function inspectMessageAuthorResult(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	identity: MessageResultIdentity;
	deliveryEvidence?: EntryPointer;
}): MessageAuthorResultState {
	const { authorAgentId, transcript, toolCallId, identity, deliveryEvidence } = options;
	const results = currentCoordinationScope(transcript, authorAgentId).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "agent_message" &&
			entry.message.toolCallId === toolCallId,
	);
	if (results.length > 1) {
		throw new Error(
			`invariant_violation: Message ${identity.messageId} has multiple author results`,
		);
	}
	const result = results[0];
	if (result && result.type === "message" && result.message.role === "toolResult") {
		if (result.message.isError) {
			if (deliveryEvidence) {
				throw new Error(
					`invariant_violation: Message ${identity.messageId} has an error result and Delivery`,
				);
			}
			return "not_created";
		}
		if (isNonAuthoringRequestResult(result.message.details, identity)) {
			return "not_created";
		}
		validateMessageAuthorResult(result.message.details, identity);
		return "canonical";
	}
	return deliveryEvidence ? "canonical" : "indeterminate";
}

function isNonAuthoringRequestResult(
	value: unknown,
	message: MessageResultIdentity,
): boolean {
	if (
		(message.kind !== "answer" && message.kind !== "request_cancellation") ||
		!isRecord(value) ||
		(message.kind === "answer" && value.requestId !== message.requestId)
	) {
		return false;
	}
	const keys = Object.keys(value).sort();
	if (message.kind === "request_cancellation") {
		if (value.disposition === "already_answered") {
			return sameStringList(keys, ["answerMessageId", "disposition"]) &&
				typeof value.answerMessageId === "string" &&
				value.answerMessageId.length > 0;
		}
		if (value.disposition === "already_cancelled") {
			return sameStringList(keys, ["cancellationMessageId", "disposition"]) &&
				typeof value.cancellationMessageId === "string" &&
				value.cancellationMessageId.length > 0;
		}
		return false;
	}
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

function validateMessageAuthorResult(
	value: unknown,
	message: MessageResultIdentity,
): void {
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
}

export function inspectMessageDelivery(options: {
	recipientAgentId: string;
	transcript: TranscriptInspection;
	message: Message;
}): DeliveryInspection {
	const { recipientAgentId, transcript, message } = options;
	return inspectStandaloneMessageDelivery({
		recipientAgentId,
		transcript,
		source: message.source,
		expectedProjection: modelVisibleProjection(message),
		subject: `${messageSubject(message)} ${message.messageId}`,
	});
}

export function inspectAnswerDelivery(options: {
	requesterAgentId: string;
	transcript: TranscriptInspection;
	answer: Extract<Message, { kind: "answer" }>;
}): DeliveryInspection {
	const { requesterAgentId, transcript, answer } = options;
	const customDelivery = inspectMessageDelivery({
		recipientAgentId: requesterAgentId,
		transcript,
		message: answer,
	});
	const retrievalEntries = inspectAnswerRetrievals({
		requesterAgentId,
		transcript,
	}).filter((retrieval) => {
		if (!sameToolCallPointer(retrieval.answerSource, answer.source)) return false;
		if (
			retrieval.requestId !== answer.requestId ||
			retrieval.answerId !== answer.messageId ||
			retrieval.fromAgentId !== answer.fromAgentId ||
			retrieval.answer !== answer.answer
		) {
			throw new ProtocolInvariantError(
				`Answer ${answer.messageId} Retrieval differs from its source`,
			);
		}
		return true;
	});
	const matches = [
		...(customDelivery.deliveryEvidence
			? [customDelivery.deliveryEvidence.entryId]
			: []),
		...retrievalEntries.map(({ deliveryEvidence }) => deliveryEvidence.entryId),
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

export function inspectAnswerRetrievals(options: {
	requesterAgentId: string;
	transcript: TranscriptInspection;
}): readonly AnswerRetrievalEvidence[] {
	const { requesterAgentId, transcript } = options;
	const retrievals: AnswerRetrievalEvidence[] = [];
	for (const entry of currentCoordinationScope(transcript, requesterAgentId)) {
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
			!isToolCallPointer(details.answerSource) ||
			typeof details.answerId !== "string" ||
			typeof details.requestId !== "string" ||
			typeof details.fromAgentId !== "string" ||
			typeof details.answer !== "string" ||
			details.messageId !== details.requestId ||
			details.answerId !== deriveMessageIdentity(details.answerSource) ||
			details.fromAgentId !== details.answerSource.agentId
		) {
			throw new ProtocolInvariantError("Answer Retrieval evidence is invalid");
		}
		retrievals.push({
			answerId: details.answerId,
			requestId: details.requestId,
			fromAgentId: details.fromAgentId,
			answer: details.answer,
			answerSource: details.answerSource,
			deliveryEvidence: { agentId: requesterAgentId, entryId: entry.id },
		});
	}
	return retrievals;
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

function isToolCallPointer(value: unknown): value is ToolCallPointer {
	return isRecord(value) &&
		typeof value.agentId === "string" &&
		value.agentId.length > 0 &&
		typeof value.entryId === "string" &&
		value.entryId.length > 0 &&
		typeof value.toolCallId === "string" &&
		value.toolCallId.length > 0;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
