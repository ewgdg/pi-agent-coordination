import { isDeepStrictEqual } from "node:util";

import type { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	currentCoordinationScope,
	ProtocolInvariantError,
	sameToolCallPointer,
	type ToolCallPointer,
} from "./identities.ts";

export type EntryPointer = Readonly<{
	agentId: string;
	entryId: string;
}>;

export const MESSAGE_DELIVERY_CUSTOM_TYPE = "agent-coordination.message-delivery";

export type ModelVisibleMessage =
	| Readonly<{
		kind: "message";
		messageId: string;
		fromAgentId: string;
		content: string;
	}>
	| Readonly<{
		kind: "request";
		requestId: string;
		fromAgentId: string;
		question: string;
	}>
	| Readonly<{
		kind: "answer";
		answerId: string;
		requestId: string;
		fromAgentId: string;
		answer: string;
	}>
	| Readonly<{
		kind: "request_cancellation";
		cancellationId: string;
		requestId: string;
		fromAgentId: string;
		reason: string;
	}>;

export type MessageDeliveryItem = Readonly<{
	source: ToolCallPointer;
	projection: ModelVisibleMessage;
}>;

export type ModelVisibleMessageDelivery = Readonly<{
	customType: typeof MESSAGE_DELIVERY_CUSTOM_TYPE;
	content: string;
	display: true;
	details: Readonly<{ messages: readonly ToolCallPointer[] }>;
}>;

export type DeliveryInspection = Readonly<{
	deliveryEvidence?: EntryPointer;
	inspectedThrough: EntryPointer;
}>;

export function createMessageDelivery(
	items: readonly MessageDeliveryItem[],
): ModelVisibleMessageDelivery {
	if (items.length === 0) {
		throw new ProtocolInvariantError("Message Delivery must not be empty");
	}
	return {
		customType: MESSAGE_DELIVERY_CUSTOM_TYPE,
		content: JSON.stringify({
			messages: items.map(({ projection }) => projection),
		}),
		display: true,
		details: { messages: items.map(({ source }) => source) },
	};
}

export function inspectStandaloneMessageDelivery(options: {
	recipientAgentId: string;
	sessionManager: SessionManager;
	source: ToolCallPointer;
	expectedProjection: ModelVisibleMessage;
	subject: string;
}): DeliveryInspection {
	const {
		recipientAgentId,
		sessionManager,
		source: expectedSource,
		expectedProjection,
		subject,
	} = options;
	const entries = sessionManager.getEntries();
	const tail = entries.at(-1);
	if (!tail) {
		throw new ProtocolInvariantError(`Agent ${recipientAgentId} has no transcript entries`);
	}
	const matches: string[] = [];
	for (const entry of currentCoordinationScope(sessionManager, recipientAgentId)) {
		if (entry.type !== "custom" && entry.type !== "custom_message") continue;
		if (!entry.customType.startsWith("agent-coordination.")) continue;
		if (
			entry.type !== "custom_message" ||
			entry.customType !== "agent-coordination.message-delivery"
		) {
			throw new ProtocolInvariantError(
				`unexpected current-scope coordination entry ${entry.customType}`,
			);
		}
		if (!entry.display) {
			throw new ProtocolInvariantError("Message Delivery must be model-visible");
		}
		const { sources, projections } = parseMessageDelivery(entry.details, entry.content);
		const sourceIndex = sources.findIndex((source) =>
			sameToolCallPointer(source, expectedSource));
		if (sourceIndex < 0) continue;
		if (
			!isDeepStrictEqual(projections[sourceIndex], expectedProjection)
		) {
			throw new ProtocolInvariantError(`${subject} Delivery differs from its source`);
		}
		matches.push(entry.id);
	}
	if (matches.length > 1) {
		throw new ProtocolInvariantError(`${subject} has duplicate Deliveries`);
	}
	return {
		...(matches[0]
			? { deliveryEvidence: { agentId: recipientAgentId, entryId: matches[0] } }
			: {}),
		inspectedThrough: { agentId: recipientAgentId, entryId: tail.id },
	};
}

function parseMessageDelivery(
	details: unknown,
	content: unknown,
): Readonly<{
	sources: readonly ToolCallPointer[];
	projections: readonly ModelVisibleMessage[];
}> {
	const sources = parseDeliverySources(details);
	const projections = parseDeliveryContent(content);
	if (sources.length !== projections.length) {
		throw new ProtocolInvariantError(
			"Message Delivery source and projection counts differ",
		);
	}
	return { sources, projections };
}

function parseDeliverySources(value: unknown): ToolCallPointer[] {
	const record = requireExactRecord(value, ["messages"], "Message Delivery details");
	if (!Array.isArray(record.messages) || record.messages.length === 0) {
		throw new ProtocolInvariantError("Message Delivery sources must not be empty");
	}
	const sources = record.messages.map((source) => {
		const pointer = requireExactRecord(
			source,
			["agentId", "entryId", "toolCallId"],
			"Message Delivery source",
		);
		if (
			!isProtocolString(pointer.agentId) ||
			!isProtocolString(pointer.entryId) ||
			!isProtocolString(pointer.toolCallId)
		) {
			throw new ProtocolInvariantError("Message Delivery source is invalid");
		}
		return {
			agentId: pointer.agentId,
			entryId: pointer.entryId,
			toolCallId: pointer.toolCallId,
		};
	});
	for (let index = 0; index < sources.length; index += 1) {
		if (
			sources.slice(index + 1).some((candidate) =>
				sameToolCallPointer(sources[index]!, candidate))
		) {
			throw new ProtocolInvariantError("Message Delivery repeats a source");
		}
	}
	return sources;
}

function parseDeliveryContent(value: unknown): ModelVisibleMessage[] {
	if (typeof value !== "string") {
		throw new ProtocolInvariantError("Message Delivery content must be JSON text");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ProtocolInvariantError("Message Delivery content is not valid JSON");
	}
	const record = requireExactRecord(parsed, ["messages"], "Message Delivery content");
	if (!Array.isArray(record.messages) || record.messages.length === 0) {
		throw new ProtocolInvariantError("Message Delivery projections must not be empty");
	}
	return record.messages.map(parseDeliveryProjection);
}

function parseDeliveryProjection(value: unknown): ModelVisibleMessage {
	if (!isRecord(value)) {
		throw new ProtocolInvariantError("Message Delivery projection has an invalid shape");
	}
	if (value.kind === "message") {
		const message = requireExactRecord(
			value,
			["kind", "messageId", "fromAgentId", "content"],
			"Message Delivery projection",
		);
		if (
			!isProtocolString(message.messageId) ||
			!isProtocolString(message.fromAgentId) ||
			!isProtocolString(message.content)
		) {
			throw new ProtocolInvariantError("Message Delivery projection is invalid");
		}
		return {
			kind: "message",
			messageId: message.messageId,
			fromAgentId: message.fromAgentId,
			content: message.content,
		};
	}
	if (value.kind === "request") {
		const request = requireExactRecord(
			value,
			["kind", "requestId", "fromAgentId", "question"],
			"Message Delivery projection",
		);
		if (
			!isProtocolString(request.requestId) ||
			!isProtocolString(request.fromAgentId) ||
			!isProtocolString(request.question)
		) {
			throw new ProtocolInvariantError("Message Delivery projection is invalid");
		}
		return {
			kind: "request",
			requestId: request.requestId,
			fromAgentId: request.fromAgentId,
			question: request.question,
		};
	}
	if (value.kind === "answer") {
		const answer = requireExactRecord(
			value,
			["kind", "answerId", "requestId", "fromAgentId", "answer"],
			"Message Delivery projection",
		);
		if (
			!isProtocolString(answer.answerId) ||
			!isProtocolString(answer.requestId) ||
			!isProtocolString(answer.fromAgentId) ||
			!isProtocolString(answer.answer)
		) {
			throw new ProtocolInvariantError("Message Delivery projection is invalid");
		}
		return {
			kind: "answer",
			answerId: answer.answerId,
			requestId: answer.requestId,
			fromAgentId: answer.fromAgentId,
			answer: answer.answer,
		};
	}
	if (value.kind === "request_cancellation") {
		const cancellation = requireExactRecord(
			value,
			["kind", "cancellationId", "requestId", "fromAgentId", "reason"],
			"Message Delivery projection",
		);
		if (
			!isProtocolString(cancellation.cancellationId) ||
			!isProtocolString(cancellation.requestId) ||
			!isProtocolString(cancellation.fromAgentId) ||
			!isProtocolString(cancellation.reason)
		) {
			throw new ProtocolInvariantError("Message Delivery projection is invalid");
		}
		return {
			kind: "request_cancellation",
			cancellationId: cancellation.cancellationId,
			requestId: cancellation.requestId,
			fromAgentId: cancellation.fromAgentId,
			reason: cancellation.reason,
		};
	}
	throw new ProtocolInvariantError("Message Delivery projection has an invalid shape");
}

function requireExactRecord(
	value: unknown,
	expectedKeys: readonly string[],
	subject: string,
): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new ProtocolInvariantError(`${subject} has an invalid shape`);
	}
	const actualKeys = Object.keys(value).sort();
	const sortedExpectedKeys = [...expectedKeys].sort();
	if (
		actualKeys.length !== sortedExpectedKeys.length ||
		actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
	) {
		throw new ProtocolInvariantError(`${subject} has an invalid shape`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProtocolString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
