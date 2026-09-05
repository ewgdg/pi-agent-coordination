import { indexedState, coordinationEntries, projectEntries } from "../transcript/retained-transcript.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

import {
	deriveMessageIdentity,
	ProtocolInvariantError,
	sameToolCallPointer,
	type ToolCallPointer,
} from "./identities.ts";
import {
	inspectAnswerDelivery,
	inspectAnswerRetrievals,
	inspectCanonicalMessage,
	inspectMessageDelivery,
	resolveCommittedAnswer,
	resolveCommittedCancellation,
	type AgentMessageInput,
	type Message,
	type RequestSendInput,
	validateAgentMessageInput,
} from "./message.ts";
import {
	inspectMessageDeliveries,
	type DeliveredMessageEvidence,
	validateDeliveredMessageEvidence,
} from "./message-delivery.ts";

type Request = Extract<Message, { kind: "request" }>;
type Answer = Extract<Message, { kind: "answer" }>;
type Cancellation = Extract<Message, { kind: "request_cancellation" }>;

export type AuthoredAgentMessageSource = Readonly<{
	source: ToolCallPointer;
	input: Exclude<AgentMessageInput, { operation: "poll" | "retry" }>;
}>;

export type AuthoredRequestSource = Readonly<{
	source: ToolCallPointer;
	input: RequestSendInput;
}>;

export type CanonicalRequestResolution = Readonly<{
	answer?: Answer;
	cancellation?: Cancellation;
}>;

export function findAuthoredAgentMessageSource(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
	messageId: string;
}): AuthoredAgentMessageSource | undefined {
	const matches = authoredFacts(options).byMessage.get(options.messageId) ?? [];
	if (matches.length > 1) {
		throw new ProtocolInvariantError(
			`Message ${options.messageId} has multiple author sources`,
		);
	}
	return matches[0];
}

export function findAuthoredRequestSources(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
}): readonly AuthoredRequestSource[] {
	return authoredFacts(options).requests;
}

export function inspectCanonicalRequestResolution(options: {
	request: Request;
	requesterTranscript: TranscriptInspection;
	responderTranscript: TranscriptInspection;
}): CanonicalRequestResolution {
	const { request, requesterTranscript, responderTranscript } = options;
	const answers = findAuthoredAgentMessageSources({
		authorAgentId: request.targetAgentId,
		transcript: responderTranscript,
	}).flatMap(({ source, input }) => {
		if (input.operation !== "answer") return [];
		const resultRequestId = answerSourceResultRequestId({
			transcript: responderTranscript,
			source,
		});
		const deliveryRequestId = answerSourceDeliveryRequestId({
			requesterAgentId: request.fromAgentId,
			transcript: requesterTranscript,
			source,
		});
		if (
			resultRequestId !== undefined &&
			deliveryRequestId !== undefined &&
			resultRequestId !== deliveryRequestId
		) {
			throw new ProtocolInvariantError(
				`Agent Answer ${deriveMessageIdentity(source)} result and Delivery name different Requests`,
			);
		}
		const correlatedRequestId = resultRequestId ?? deliveryRequestId;
		if (correlatedRequestId !== request.messageId) return [];
		const answer = resolveCommittedAnswer({
			responderAgentId: request.targetAgentId,
			transcript: responderTranscript,
			toolCallId: source.toolCallId,
			providedInput: input,
			request,
		});
		const delivery = inspectAnswerDelivery({
			requesterAgentId: request.fromAgentId,
			transcript: requesterTranscript,
			answer,
		});
		return inspectCanonicalMessage({
			message: answer,
			authorTranscript: responderTranscript,
			deliveryEvidence: delivery.deliveryEvidence,
		}).state === "canonical" ? [answer] : [];
	});
	const cancellations = findAuthoredAgentMessageSources({
		authorAgentId: request.fromAgentId,
		transcript: requesterTranscript,
	})
		.filter((source): source is AuthoredAgentMessageSource & {
			input: Extract<AgentMessageInput, { operation: "cancel" }>;
		} =>
			source.input.operation === "cancel" &&
			source.input.requestMessageId === request.messageId
		)
		.map(({ source, input }) => resolveCommittedCancellation({
			requesterAgentId: request.fromAgentId,
			transcript: requesterTranscript,
			toolCallId: source.toolCallId,
			providedInput: input,
			request,
		}))
		.filter((cancellation) => {
			const delivery = inspectMessageDelivery({
				recipientAgentId: request.targetAgentId,
				transcript: responderTranscript,
				message: cancellation,
			});
			return inspectCanonicalMessage({
				message: cancellation,
				authorTranscript: requesterTranscript,
				deliveryEvidence: delivery.deliveryEvidence,
			}).state === "canonical";
		});
	if (answers.length > 1) {
		throw new ProtocolInvariantError(
			`Request ${request.messageId} has multiple canonical Answers`,
		);
	}
	if (cancellations.length > 1) {
		throw new ProtocolInvariantError(
			`Request ${request.messageId} has multiple canonical Cancellations`,
		);
	}
	return {
		...(answers[0] === undefined ? {} : { answer: answers[0] }),
		...(cancellations[0] === undefined
			? {}
			: { cancellation: cancellations[0] }),
	};
}

export function answerCallTargetAgentId(options: {
	responderAgentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): string | undefined {
	const { responderAgentId, transcript, toolCallId } = options;
	const answerSources = findAuthoredAgentMessageSources({
		authorAgentId: responderAgentId,
		transcript,
	}).filter(({ input }) => input.operation === "answer");
	const source = answerSources.find((candidate) =>
		candidate.source.toolCallId === toolCallId
	)?.source;
	const entryIndexes = indexedState(transcript).positions;
	const sourceIndex = source === undefined
		? Number.POSITIVE_INFINITY
		: entryIndexes.get(source.entryId);
	if (sourceIndex === undefined) return undefined;

	const resolvedRequestIds = new Set<string>();
	for (const candidate of answerSources) {
		if (candidate.source.toolCallId === toolCallId) continue;
		const candidateIndex = entryIndexes.get(candidate.source.entryId);
		if (candidateIndex === undefined || candidateIndex >= sourceIndex) continue;
		const requestId = answerSourceResultRequestId({
			transcript,
			source: candidate.source,
		});
		if (requestId !== undefined) resolvedRequestIds.add(requestId);
	}

	const requests: DeliveredMessageEvidence[] = [];
	for (const delivery of inspectMessageDeliveries({
		recipientAgentId: responderAgentId,
		transcript,
	})) {
		validateDeliveredMessageEvidence(delivery);
		const deliveryIndex = entryIndexes.get(delivery.deliveryEvidence.entryId);
		if (deliveryIndex === undefined || deliveryIndex >= sourceIndex) continue;
		if (delivery.projection.kind === "request_cancellation") {
			resolvedRequestIds.add(delivery.projection.requestMessageId);
		} else if (delivery.projection.kind === "request") {
			requests.push(delivery);
		}
	}
	const request = requests.findLast(({ projection }) =>
		projection.kind === "request" &&
		!resolvedRequestIds.has(projection.requestMessageId)
	);
	return request?.projection.fromAgentId;
}

export function answerSourceResultRequestId(options: {
	transcript: TranscriptInspection;
	source: ToolCallPointer;
}): string | undefined {
	const results = coordinationEntries(options.transcript, options.source.agentId, `result:${options.source.toolCallId}`).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "agent_message" &&
			entry.message.toolCallId === options.source.toolCallId,
	);
	if (results.length > 1) {
		throw new ProtocolInvariantError(
			`Agent Answer source ${options.source.toolCallId} has multiple results`,
		);
	}
	const result = results[0];
	if (!result) return undefined;
	if (result.type !== "message" || result.message.role !== "toolResult") {
		return undefined;
	}
	// An error result carries no authoritative correlation. Candidate Delivery
	// inspection still enforces the error-result-plus-Delivery crash invariant.
	if (result.message.isError) return undefined;
	const details = result.message.details;
	if (
		typeof details !== "object" ||
		details === null ||
		!("requestMessageId" in details) ||
		typeof details.requestMessageId !== "string" ||
		details.requestMessageId.length === 0
	) {
		throw new ProtocolInvariantError(
			`Agent Answer source ${options.source.toolCallId} has malformed correlation evidence`,
		);
	}
	return details.requestMessageId;
}

export function answerSourceDeliveryRequestId(options: {
	requesterAgentId: string;
	transcript: TranscriptInspection;
	source: ToolCallPointer;
}): string | undefined {
	const direct = inspectMessageDeliveries({
		recipientAgentId: options.requesterAgentId,
		transcript: options.transcript,
	}).filter(({ source }) => sameToolCallPointer(source, options.source));
	const requestIds: string[] = [];
	for (const delivery of direct) {
		validateDeliveredMessageEvidence(delivery);
		if (delivery.projection.kind !== "answer") {
			throw new ProtocolInvariantError(
				`Agent Answer source ${options.source.toolCallId} has non-Answer Delivery`,
			);
		}
		requestIds.push(delivery.projection.requestMessageId);
	}
	for (const retrieval of inspectAnswerRetrievals({
		requesterAgentId: options.requesterAgentId,
		transcript: options.transcript,
	})) {
		if (sameToolCallPointer(retrieval.answerSource, options.source)) {
			requestIds.push(retrieval.requestId);
		}
	}
	if (requestIds.length > 1) {
		throw new ProtocolInvariantError(
			`Agent Answer source ${options.source.toolCallId} has duplicate Deliveries`,
		);
	}
	return requestIds[0];
}

export function findAuthoredAgentMessageSources(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
}): AuthoredAgentMessageSource[] {
	return authoredFacts(options).sources;
}

function authoredFacts(options: { authorAgentId: string; transcript: TranscriptInspection }) {
	const { transcript, authorAgentId } = options;
	const facts = indexedState(transcript).project(
		authoredFacts,
		authorAgentId,
		coordinationEntries(transcript, authorAgentId, "tool:agent_message"),
		() => ({
			sources: [] as AuthoredAgentMessageSource[],
			requests: [] as AuthoredRequestSource[],
			invalidCalls: [] as string[],
			byMessage: new Map<string, AuthoredAgentMessageSource[]>(),
		}),
		(facts, entry) => {
			if (entry.type !== "message" || entry.message.role !== "assistant") return facts;
			for (const part of entry.message.content) {
				if (part.type !== "toolCall" || part.name !== "agent_message") continue;
				let input: AgentMessageInput;
				try {
					input = validateAgentMessageInput(part.arguments);
				} catch {
					facts.invalidCalls.push(part.id);
					continue;
				}
				if (input.operation === "poll" || input.operation === "retry") continue;
				const source = {
					source: { agentId: authorAgentId, entryId: entry.id, toolCallId: part.id },
					input,
				};
				const messageId = deriveMessageIdentity(source.source);
				const matches = facts.byMessage.get(messageId) ?? [];
				matches.push(source);
				facts.byMessage.set(messageId, matches);
				facts.sources.push(source);
				if (input.operation === "request") facts.requests.push({ source: source.source, input });
			}
			return facts;
		},
	);
	// Invalid calls remain candidates until their native validation result commits.
	// A cached absence cannot hide a later contradictory successful result.
	for (const toolCallId of facts.invalidCalls) {
		const results = coordinationEntries(transcript, authorAgentId, `result:${toolCallId}`).filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "agent_message",
		);
		if (results.length === 0) continue;
		if (
			results.length === 1 &&
			results[0]?.type === "message" &&
			results[0].message.role === "toolResult" &&
			results[0].message.isError
		)
			continue;
		throw new ProtocolInvariantError(`committed agent_message source ${toolCallId} is invalid`);
	}
	return facts;
}
