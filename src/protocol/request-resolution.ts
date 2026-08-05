import type { SessionManager } from "@earendil-works/pi-coding-agent";

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
	sessionManager: SessionManager;
	messageId: string;
}): AuthoredAgentMessageSource | undefined {
	const matches = authoredAgentMessageSources(options).filter(
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
	sessionManager: SessionManager;
}): readonly AuthoredRequestSource[] {
	return authoredAgentMessageSources(options).filter(
		(source): source is AuthoredRequestSource => source.input.operation === "request",
	);
}

export function inspectCanonicalRequestResolution(options: {
	request: Request;
	requesterSessionManager: SessionManager;
	responderSessionManager: SessionManager;
}): CanonicalRequestResolution {
	const { request, requesterSessionManager, responderSessionManager } = options;
	const answers = authoredAgentMessageSources({
		authorAgentId: request.targetAgentId,
		sessionManager: responderSessionManager,
	})
		.filter((source): source is AuthoredAgentMessageSource & {
			input: Extract<AgentMessageInput, { operation: "answer" }>;
		} =>
			source.input.operation === "answer" &&
			source.input.requestId === request.messageId
		)
		.map(({ source, input }) => resolveCommittedAnswer({
			responderAgentId: request.targetAgentId,
			sessionManager: responderSessionManager,
			toolCallId: source.toolCallId,
			providedInput: input,
			request,
		}))
		.filter((answer) => {
			const delivery = inspectAnswerDelivery({
				requesterAgentId: request.fromAgentId,
				sessionManager: requesterSessionManager,
				answer,
			});
			return inspectCanonicalMessage({
				message: answer,
				authorSessionManager: responderSessionManager,
				deliveryEvidence: delivery.deliveryEvidence,
			}).state === "canonical";
		});
	const cancellations = authoredAgentMessageSources({
		authorAgentId: request.fromAgentId,
		sessionManager: requesterSessionManager,
	})
		.filter((source): source is AuthoredAgentMessageSource & {
			input: Extract<AgentMessageInput, { operation: "cancel" }>;
		} =>
			source.input.operation === "cancel" &&
			source.input.requestId === request.messageId
		)
		.map(({ source, input }) => resolveCommittedCancellation({
			requesterAgentId: request.fromAgentId,
			sessionManager: requesterSessionManager,
			toolCallId: source.toolCallId,
			providedInput: input,
			request,
		}))
		.filter((cancellation) => {
			const delivery = inspectMessageDelivery({
				recipientAgentId: request.targetAgentId,
				sessionManager: responderSessionManager,
				message: cancellation,
			});
			return inspectCanonicalMessage({
				message: cancellation,
				authorSessionManager: requesterSessionManager,
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

function authoredAgentMessageSources(options: {
	authorAgentId: string;
	sessionManager: SessionManager;
}): AuthoredAgentMessageSource[] {
	const sources: AuthoredAgentMessageSource[] = [];
	for (const entry of currentCoordinationScope(
		options.sessionManager,
		options.authorAgentId,
	)) {
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
