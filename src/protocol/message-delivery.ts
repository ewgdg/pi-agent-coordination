import { OPERATIONAL_DIAGNOSTIC_CUSTOM_TYPE } from "./custom-entry-types.ts";
import { indexedState, coordinationEntries } from "../transcript/retained-transcript.ts";
import { isDeepStrictEqual } from "node:util";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import {
	CONVERSATION_FORK_CUSTOM_TYPE,
	MODERATOR_ROUTINE_START_CUSTOM_TYPE,
	OBLIGATION_REMINDER_CUSTOM_TYPE,
	RUN_FAILURE_RECOVERY_CUSTOM_TYPE,
} from "./custom-entry-types.ts";
import {
	deriveMessageIdentity,
	ProtocolInvariantError,
	sameToolCallPointer,
	toolCallPointerKey,
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
		requestMessageId: string;
		fromAgentId: string;
		question: string;
	}>
	| Readonly<{
		kind: "answer";
		answerId: string;
		requestMessageId: string;
		fromAgentId: string;
		answer: string;
	}>
	| Readonly<{
		kind: "request_cancellation";
		cancellationId: string;
		requestMessageId: string;
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

export type DeliveredMessageEvidence = Readonly<{
	source: ToolCallPointer;
	projection: ModelVisibleMessage;
	deliveryEvidence: EntryPointer;
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
	transcript: TranscriptInspection;
	source: ToolCallPointer;
	expectedProjection: ModelVisibleMessage;
	subject: string;
}): DeliveryInspection {
	const {
		recipientAgentId,
		transcript,
		source: expectedSource,
		expectedProjection,
		subject,
	} = options;
	const { bySource, inspectedThrough } = readMessageDeliveries({
		recipientAgentId,
		transcript,
	});
	const matches: string[] = [];
	for (const delivery of bySource.get(toolCallPointerKey(expectedSource)) ?? []) {
		if (!isDeepStrictEqual(delivery.projection, expectedProjection)) {
			throw new ProtocolInvariantError(`${subject} Delivery differs from its source`);
		}
		matches.push(delivery.deliveryEvidence.entryId);
	}
	if (matches.length > 1) {
		throw new ProtocolInvariantError(`${subject} has duplicate Deliveries`);
	}
	return {
		...(matches[0]
			? { deliveryEvidence: { agentId: recipientAgentId, entryId: matches[0] } }
			: {}),
		inspectedThrough,
	};
}

export function inspectMessageDeliveries(options: {
	recipientAgentId: string;
	transcript: TranscriptInspection;
}): readonly DeliveredMessageEvidence[] {
	const { deliveries, duplicate } = readMessageDeliveries(options);
	if (duplicate) {
		throw new ProtocolInvariantError(`Message ${projectionIdentity(duplicate.projection)} has duplicate Deliveries`);
	}
	return deliveries;
}

export function validateDeliveredMessageEvidence(
	delivery: DeliveredMessageEvidence,
): void {
	if (
		delivery.projection.fromAgentId !== delivery.source.agentId ||
		projectionIdentity(delivery.projection) !== deriveMessageIdentity(delivery.source)
	) {
		throw new ProtocolInvariantError(
			"Message Delivery projection identity differs from its source",
		);
	}
}

function readMessageDeliveries(options: {
	recipientAgentId: string;
	transcript: TranscriptInspection;
}): Readonly<{
	deliveries: readonly DeliveredMessageEvidence[];
	bySource: ReadonlyMap<string, readonly DeliveredMessageEvidence[]>;
	byRequest: ReadonlyMap<string, readonly DeliveredMessageEvidence[]>;
	duplicate?: DeliveredMessageEvidence;
	inspectedThrough: EntryPointer;
}> {
	const { recipientAgentId, transcript } = options;
	const entries = transcript.entries;
	const tail = entries.at(-1);
	if (!tail) {
		throw new ProtocolInvariantError(`Agent ${recipientAgentId} has no transcript entries`);
	}
	const facts = indexedState(transcript).project(
		readMessageDeliveries,
		recipientAgentId,
		coordinationEntries(transcript, recipientAgentId, "coordination"),
		() => ({
			deliveries: [] as DeliveredMessageEvidence[],
			bySource: new Map<string, DeliveredMessageEvidence[]>(),
			byRequest: new Map<string, DeliveredMessageEvidence[]>(),
			duplicate: undefined as DeliveredMessageEvidence | undefined,
		}),
		(facts, committedEntry) => {
			const deliveries: DeliveredMessageEvidence[] = [];
			for (const entry of [committedEntry]) {
				if (entry.type !== "custom" && entry.type !== "custom_message") continue;
				if (!entry.customType.startsWith("agent-coordination.")) continue;
				// Host-authored reminder, routine, and recovery entries are not Agent Messages.
				if (
					entry.customType === CONVERSATION_FORK_CUSTOM_TYPE ||
					entry.customType === MODERATOR_ROUTINE_START_CUSTOM_TYPE ||
					entry.customType === OBLIGATION_REMINDER_CUSTOM_TYPE ||
					entry.customType === OPERATIONAL_DIAGNOSTIC_CUSTOM_TYPE ||
					entry.customType === RUN_FAILURE_RECOVERY_CUSTOM_TYPE
				)
					continue;
				if (entry.type !== "custom_message" || entry.customType !== MESSAGE_DELIVERY_CUSTOM_TYPE) {
					throw new ProtocolInvariantError(
						`unexpected current-scope coordination entry ${entry.customType}`,
					);
				}
				if (!entry.display) {
					throw new ProtocolInvariantError("Message Delivery must be model-visible");
				}
				const { sources, projections } = parseMessageDelivery(entry.details, entry.content);
				for (let index = 0; index < sources.length; index += 1) {
					const source = sources[index]!;
					const projection = projections[index]!;
					deliveries.push({
						source,
						projection,
						deliveryEvidence: { agentId: recipientAgentId, entryId: entry.id },
					});
				}
			}
			for (const delivery of deliveries) {
				const key = toolCallPointerKey(delivery.source);
				const matches = facts.bySource.get(key) ?? [];
				if (matches.length) facts.duplicate ??= delivery;
				matches.push(delivery);
				facts.bySource.set(key, matches);
				if (delivery.projection.kind !== "message") {
					const requestId = delivery.projection.requestMessageId;
					const related = facts.byRequest.get(requestId) ?? [];
					related.push(delivery);
					facts.byRequest.set(requestId, related);
					indexedState(transcript).observeMessageRequest(key, requestId);
				}
			}
			facts.deliveries.push(...deliveries);
			return facts;
		},
	);
	return {
		...facts,
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
	const projections = parseMessageDeliveryContent(content);
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

export function parseMessageDeliveryContent(value: unknown): readonly ModelVisibleMessage[] {
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
			["kind", "requestMessageId", "fromAgentId", "question"],
			"Message Delivery projection",
		);
		if (
			!isProtocolString(request.requestMessageId) ||
			!isProtocolString(request.fromAgentId) ||
			!isProtocolString(request.question)
		) {
			throw new ProtocolInvariantError("Message Delivery projection is invalid");
		}
		return {
			kind: "request",
			requestMessageId: request.requestMessageId,
			fromAgentId: request.fromAgentId,
			question: request.question,
		};
	}
	if (value.kind === "answer") {
		const answer = requireExactRecord(
			value,
			["kind", "answerId", "requestMessageId", "fromAgentId", "answer"],
			"Message Delivery projection",
		);
		if (
			!isProtocolString(answer.answerId) ||
			!isProtocolString(answer.requestMessageId) ||
			!isProtocolString(answer.fromAgentId) ||
			!isProtocolString(answer.answer)
		) {
			throw new ProtocolInvariantError("Message Delivery projection is invalid");
		}
		return {
			kind: "answer",
			answerId: answer.answerId,
			requestMessageId: answer.requestMessageId,
			fromAgentId: answer.fromAgentId,
			answer: answer.answer,
		};
	}
	if (value.kind === "request_cancellation") {
		const cancellation = requireExactRecord(
			value,
			["kind", "cancellationId", "requestMessageId", "fromAgentId", "reason"],
			"Message Delivery projection",
		);
		if (
			!isProtocolString(cancellation.cancellationId) ||
			!isProtocolString(cancellation.requestMessageId) ||
			!isProtocolString(cancellation.fromAgentId) ||
			!isProtocolString(cancellation.reason)
		) {
			throw new ProtocolInvariantError("Message Delivery projection is invalid");
		}
		return {
			kind: "request_cancellation",
			cancellationId: cancellation.cancellationId,
			requestMessageId: cancellation.requestMessageId,
			fromAgentId: cancellation.fromAgentId,
			reason: cancellation.reason,
		};
	}
	throw new ProtocolInvariantError("Message Delivery projection has an invalid shape");
}

function projectionIdentity(projection: ModelVisibleMessage): string {
	switch (projection.kind) {
		case "message":
			return projection.messageId;
		case "request":
			return projection.requestMessageId;
		case "answer":
			return projection.answerId;
		case "request_cancellation":
			return projection.cancellationId;
	}
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

export function deliveriesBySource(options: {
	recipientAgentId: string;
	transcript: TranscriptInspection;
	source: ToolCallPointer;
}): readonly DeliveredMessageEvidence[] {
	const facts = readMessageDeliveries(options);
	if (facts.duplicate) throw new ProtocolInvariantError("Message has duplicate Deliveries");
	return facts.bySource.get(toolCallPointerKey(options.source)) ?? [];
}

export function deliveriesForRequest(options: {
	recipientAgentId: string;
	transcript: TranscriptInspection;
	requestId: string;
}): readonly DeliveredMessageEvidence[] {
	const facts = readMessageDeliveries(options);
	if (facts.duplicate) throw new ProtocolInvariantError("Message has duplicate Deliveries");
	return facts.byRequest.get(options.requestId) ?? [];
}
