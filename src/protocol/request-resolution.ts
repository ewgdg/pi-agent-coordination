import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

import {
	currentCoordinationScope,
	deriveMessageIdentity,
	ProtocolInvariantError,
	type ToolCallPointer,
} from "./identities.ts";
import {
	inspectAnswerDelivery,
	inspectCanonicalMessage,
	inspectMessageDelivery,
	resolveCommittedAnswer,
	resolveCommittedCancellation,
	type AgentMessageInput,
	type Message,
	type RequestSendInput,
	validateAgentMessageInput,
} from "./message.ts";

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
	})
		.filter((source): source is AuthoredAgentMessageSource & {
			input: Extract<AgentMessageInput, { operation: "answer" }>;
		} =>
			source.input.operation === "answer" &&
			source.input.requestMessageId === request.messageId
		)
		.map(({ source, input }) => resolveCommittedAnswer({
			responderAgentId: request.targetAgentId,
			transcript: responderTranscript,
			toolCallId: source.toolCallId,
			providedInput: input,
			request,
		}))
		.filter((answer) => {
			const delivery = inspectAnswerDelivery({
				requesterAgentId: request.fromAgentId,
				transcript: requesterTranscript,
				answer,
			});
			return inspectCanonicalMessage({
				message: answer,
				authorTranscript: responderTranscript,
				deliveryEvidence: delivery.deliveryEvidence,
			}).state === "canonical";
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
