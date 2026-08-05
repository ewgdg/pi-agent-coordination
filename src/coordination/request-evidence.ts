import type { AgentRecord } from "./agent-record.ts";
import { resolveCreationRequest } from "../protocol/creation-request.ts";
import { deriveMessageIdentity } from "../protocol/identities.ts";
import {
	resolveCommittedAnswer,
	resolveCommittedCancellation,
	resolveCommittedMessage,
	type Message,
} from "../protocol/message.ts";
import {
	findAuthoredAgentMessageSource,
	findAuthoredRequestSources,
	inspectCanonicalRequestResolution,
} from "../protocol/request-resolution.ts";

type Request = Extract<Message, { kind: "request" }>;
type Answer = Extract<Message, { kind: "answer" }>;
type Cancellation = Extract<Message, { kind: "request_cancellation" }>;

export class RequestEvidence {
	readonly #agents: Map<string, AgentRecord>;
	// The transcript is authoritative. These entries only bridge the interval after
	// lane admission and before Pi appends the native tool result.
	readonly #admittedAnswersByRequest = new Map<string, Answer>();
	readonly #admittedCancellationsByRequest = new Map<string, Cancellation>();

	constructor(agents: Map<string, AgentRecord>) {
		this.#agents = agents;
	}

	rememberAdmittedAnswer(answer: Answer): void {
		this.#admittedAnswersByRequest.set(answer.requestId, answer);
	}

	rememberAdmittedCancellation(cancellation: Cancellation): void {
		this.#admittedCancellationsByRequest.set(
			cancellation.requestId,
			cancellation,
		);
	}

	findAnswer(request: Request): Answer | undefined {
		const durable = this.#inspectResolution(request).answer;
		const admitted = this.#admittedAnswersByRequest.get(request.messageId);
		if (durable && admitted && durable.messageId !== admitted.messageId) {
			throw new Error(
				`invariant_violation: Request ${request.messageId} has conflicting admitted and canonical Answers`,
			);
		}
		if (durable) this.#admittedAnswersByRequest.delete(request.messageId);
		return durable ?? admitted;
	}

	findCancellation(request: Request): Cancellation | undefined {
		const durable = this.#inspectResolution(request).cancellation;
		const admitted = this.#admittedCancellationsByRequest.get(request.messageId);
		if (durable && admitted && durable.messageId !== admitted.messageId) {
			throw new Error(
				`invariant_violation: Request ${request.messageId} has conflicting admitted and canonical Cancellations`,
			);
		}
		if (durable) this.#admittedCancellationsByRequest.delete(request.messageId);
		return durable ?? admitted;
	}

	requireRequest(requestId: string): Request {
		for (const author of this.#agents.values()) {
			const authored = findAuthoredAgentMessageSource({
				authorAgentId: author.identity.agentId,
				sessionManager: author.host.sessionManager,
				messageId: requestId,
			});
			if (!authored) continue;
			if (authored.input.operation !== "request") {
				throw new Error(`wrong_message_kind: Message ${requestId} is not a Request`);
			}
			const request = resolveCommittedMessage({
				fromAgentId: author.identity.agentId,
				workflowId: author.identity.workflowId,
				sessionManager: author.host.sessionManager,
				toolCallId: authored.source.toolCallId,
				providedInput: authored.input,
			});
			if (request.kind !== "request") {
				throw new Error(`wrong_message_kind: Message ${requestId} is not a Request`);
			}
			return request;
		}
		const creationRequest = this.#findCreationRequest(requestId);
		if (creationRequest) return creationRequest;
		throw new Error(`unknown_identity: Request ${requestId}`);
	}

	findRequestsAuthoredBy(author: AgentRecord): Request[] {
		const requests = findAuthoredRequestSources({
			authorAgentId: author.identity.agentId,
			sessionManager: author.host.sessionManager,
		}).map(({ source, input }) => {
			const message = resolveCommittedMessage({
				fromAgentId: author.identity.agentId,
				workflowId: author.identity.workflowId,
				sessionManager: author.host.sessionManager,
				toolCallId: source.toolCallId,
				providedInput: input,
			});
			if (message.kind !== "request") {
				throw new Error(
					`invariant_violation: Request source ${source.toolCallId} resolved as another Message kind`,
				);
			}
			return message;
		});
		for (const child of this.#agents.values()) {
			if (
				!("spawnSource" in child.identity) ||
				child.identity.directSpawnerAgentId !== author.identity.agentId
			) {
				continue;
			}
			const request = this.#findCreationRequest(
				deriveMessageIdentity(child.identity.spawnSource),
			);
			if (request) requests.push(request);
		}
		return requests;
	}

	requireCallerAuthoredMessage(caller: AgentRecord, messageId: string): Message {
		const ownMessage = this.#resolveAuthoredMessage(caller, messageId);
		if (ownMessage) return ownMessage;
		const creationRequest = this.#findCreationRequest(messageId);
		if (creationRequest) {
			if (creationRequest.fromAgentId === caller.identity.agentId) {
				return creationRequest;
			}
			throw this.#wrongParticipant(caller, messageId);
		}
		for (const candidateAuthor of this.#agents.values()) {
			if (candidateAuthor.identity.agentId === caller.identity.agentId) continue;
			if (this.#resolveAuthoredMessage(candidateAuthor, messageId)) {
				throw this.#wrongParticipant(caller, messageId);
			}
		}
		throw new Error(`unknown_identity: Message ${messageId}`);
	}

	#inspectResolution(request: Request) {
		return inspectCanonicalRequestResolution({
			request,
			requesterSessionManager: this.#requireAgent(request.fromAgentId).host.sessionManager,
			responderSessionManager: this.#requireAgent(request.targetAgentId).host.sessionManager,
		});
	}

	#findCreationRequest(requestId: string): Request | undefined {
		for (const child of this.#agents.values()) {
			if (!("spawnSource" in child.identity)) continue;
			if (child.identity.spawnSource.toolCallId.length === 0) continue;
			const spawner = this.#agents.get(child.identity.directSpawnerAgentId);
			if (!spawner) {
				throw new Error(
					`invariant_violation: Creation Request ${requestId} has no Direct Spawner`,
				);
			}
			if (deriveMessageIdentity(child.identity.spawnSource) !== requestId) continue;
			return resolveCreationRequest({
				requestId,
				workflowId: child.identity.workflowId,
				spawnerSessionManager: spawner.host.sessionManager,
				childIdentity: child.identity,
			});
		}
		return undefined;
	}

	#resolveAuthoredMessage(
		author: AgentRecord,
		messageId: string,
	): Message | undefined {
		const authored = findAuthoredAgentMessageSource({
			authorAgentId: author.identity.agentId,
			sessionManager: author.host.sessionManager,
			messageId,
		});
		if (!authored) return undefined;
		if (authored.input.operation === "send" || authored.input.operation === "request") {
			return resolveCommittedMessage({
				fromAgentId: author.identity.agentId,
				workflowId: author.identity.workflowId,
				sessionManager: author.host.sessionManager,
				toolCallId: authored.source.toolCallId,
				providedInput: authored.input,
			});
		}
		const request = this.requireRequest(authored.input.requestId);
		return authored.input.operation === "answer"
			? resolveCommittedAnswer({
				responderAgentId: author.identity.agentId,
				sessionManager: author.host.sessionManager,
				toolCallId: authored.source.toolCallId,
				providedInput: authored.input,
				request,
			})
			: resolveCommittedCancellation({
				requesterAgentId: author.identity.agentId,
				sessionManager: author.host.sessionManager,
				toolCallId: authored.source.toolCallId,
				providedInput: authored.input,
				request,
			});
	}

	#requireAgent(agentId: string): AgentRecord {
		const record = this.#agents.get(agentId);
		if (!record) throw new Error(`unknown_identity: ${agentId}`);
		return record;
	}

	#wrongParticipant(caller: AgentRecord, messageId: string): Error {
		return new Error(
			`wrong_participant: Agent ${caller.identity.agentId} did not author Message ${messageId}`,
		);
	}
}
