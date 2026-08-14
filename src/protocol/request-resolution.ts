import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

import {
	currentCoordinationScope,
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
	const matches = findAuthoredAgentMessageSources(options).filter(
		({ source }) => deriveMessageIdentity(source) === options.messageId,
	);
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
	return findAuthoredAgentMessageSources(options).filter(
		(source): source is AuthoredRequestSource => source.input.operation === "request",
	);
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

export function answerSourceResultRequestId(options: {
	transcript: TranscriptInspection;
	source: ToolCallPointer;
}): string | undefined {
	const results = currentCoordinationScope(
		options.transcript,
		options.source.agentId,
	).filter(
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
	const sources: AuthoredAgentMessageSource[] = [];
	const entries = currentCoordinationScope(
		options.transcript,
		options.authorAgentId,
	);
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content) {
			if (part.type !== "toolCall" || part.name !== "agent_message") continue;
			let input: AgentMessageInput;
			try {
				input = validateAgentMessageInput(part.arguments);
			} catch {
				// Pi durably records model-emitted tool calls even when native schema
				// validation rejects them before this extension executes.
				const results = entries.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "agent_message" &&
						entry.message.toolCallId === part.id,
				);
				if (
					results.length === 1 &&
					results[0]?.type === "message" &&
					results[0].message.role === "toolResult" &&
					results[0].message.isError
				) continue;
				throw new ProtocolInvariantError(
					`committed agent_message source ${part.id} is invalid`,
				);
			}
			if (input.operation === "poll" || input.operation === "retry") continue;
			sources.push({
				source: {
					agentId: options.authorAgentId,
					entryId: entry.id,
					toolCallId: part.id,
				},
				input,
			});
		}
	}
	return sources;
}
