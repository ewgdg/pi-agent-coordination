import {
	EvidenceUnavailableError,
	requireAgentRecord,
	type AgentRecord,
} from "./agent-record.ts";
import {
	inspectCreationRequestDelivery,
	resolveCreationRequest,
} from "../protocol/creation-request.ts";
import { deriveMessageIdentity } from "../protocol/identities.ts";
import {
	inspectAnswerDelivery,
	inspectAnswerRetrievals,
	inspectAgentMessageAuthorResult,
	inspectCanonicalMessage,
	inspectMessageDelivery,
	resolveCommittedAnswer,
	resolveCommittedCancellation,
	resolveCommittedMessage,
	type Message,
} from "../protocol/message.ts";
import {
	inspectMessageDeliveries,
	type DeliveredMessageEvidence,
	validateDeliveredMessageEvidence,
} from "../protocol/message-delivery.ts";
import {
	findAuthoredAgentMessageSource,
	findAuthoredAgentMessageSources,
	findAuthoredRequestSources,
	inspectCanonicalRequestResolution,
} from "../protocol/request-resolution.ts";
import type { ResidualRequestRelationships } from "../runtime/in-process-agent-host.ts";

type Request = Extract<Message, { kind: "request" }>;
type Answer = Extract<Message, { kind: "answer" }>;
type Cancellation = Extract<Message, { kind: "request_cancellation" }>;

export class RequestEvidence {
	readonly #agents: Map<string, AgentRecord>;
	readonly #quarantinedAgentIds: ReadonlySet<string>;
	// The transcript is authoritative. These entries only bridge the interval after
	// lane admission and before Pi appends the native tool result.
	readonly #admittedAnswersByRequest = new Map<string, Answer>();
	readonly #admittedCancellationsByRequest = new Map<string, Cancellation>();

	constructor(
		agents: Map<string, AgentRecord>,
		quarantinedAgentIds: ReadonlySet<string> = new Set(),
	) {
		this.#agents = agents;
		this.#quarantinedAgentIds = quarantinedAgentIds;
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
		this.#throwIfUnavailableDeliveryEvidence(
			`Request ${requestId} depends on quarantined Agent proof`,
			({ projection }) =>
				projection.kind === "request" && projection.requestId === requestId,
		);
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

	residualRelationshipsFor(agent: AgentRecord): ResidualRequestRelationships {
		const awaitingAnswerRequestIds: string[] = [];
		const answerOwedRequestIds: string[] = [];
		const localDeliveries = inspectMessageDeliveries({
			recipientAgentId: agent.identity.agentId,
			sessionManager: agent.host.sessionManager,
		});
		const deliveredAnswerRequestIds = new Set([
			...localDeliveries.flatMap((delivery) => {
				if (
					delivery.projection.kind !== "answer" ||
					this.#agents.has(delivery.source.agentId)
				) return [];
				validateDeliveredMessageEvidence(delivery);
				return [delivery.projection.requestId];
			}),
			...inspectAnswerRetrievals({
				requesterAgentId: agent.identity.agentId,
				sessionManager: agent.host.sessionManager,
			}).map(({ requestId }) => requestId),
		]);
		const deliveredCancellationRequestIds = new Set(
			localDeliveries.flatMap((delivery) => {
				if (
					delivery.projection.kind !== "request_cancellation" ||
					this.#agents.has(delivery.source.agentId)
				) return [];
				validateDeliveredMessageEvidence(delivery);
				return [delivery.projection.requestId];
			}),
		);

		for (const request of this.#canonicalRequestsAuthoredBy(agent)) {
			const responder = this.#agents.get(request.targetAgentId);
			if (responder) {
				const resolution = this.#inspectResolution(request);
				const answerDelivered = resolution.answer !== undefined &&
					inspectAnswerDelivery({
						requesterAgentId: agent.identity.agentId,
						sessionManager: agent.host.sessionManager,
						answer: resolution.answer,
					}).deliveryEvidence !== undefined;
				if (!resolution.cancellation && !answerDelivered) {
					awaitingAnswerRequestIds.push(request.messageId);
				}
				continue;
			}
			// The peer cannot be inspected, but requester-side Cancellation commits
			// and Answer Deliveries remain exact local proof.
			if (
				!this.#hasCanonicalAuthoredResolution(
					agent,
					request.messageId,
					"cancel",
				) &&
				!deliveredAnswerRequestIds.has(request.messageId)
			) {
				awaitingAnswerRequestIds.push(request.messageId);
			}
		}

		for (const delivery of localDeliveries) {
			if (delivery.projection.kind !== "request") continue;
			const requestId = deriveMessageIdentity(delivery.source);
			const requester = this.#agents.get(delivery.source.agentId);
			if (requester) {
				const request = this.requireRequest(requestId);
				if (!this.#inspectRequestDelivery(request, agent).deliveryEvidence) continue;
				const resolution = this.#inspectResolution(request);
				const cancellationDelivered = resolution.cancellation !== undefined &&
					inspectMessageDelivery({
						recipientAgentId: agent.identity.agentId,
						sessionManager: agent.host.sessionManager,
						message: resolution.cancellation,
					}).deliveryEvidence !== undefined;
				if (!resolution.answer && !cancellationDelivered) {
					answerOwedRequestIds.push(requestId);
				}
				continue;
			}
			validateDeliveredMessageEvidence(delivery);
			// The peer cannot be inspected, but responder-side Answer commits and
			// Cancellation Deliveries remain exact local proof.
			if (
				!this.#hasCanonicalAuthoredResolution(agent, requestId, "answer") &&
				!deliveredCancellationRequestIds.has(requestId)
			) {
				answerOwedRequestIds.push(requestId);
			}
		}
		return {
			awaitingAnswerRequestIds: uniqueRequestIds(awaitingAnswerRequestIds),
			answerOwedRequestIds: uniqueRequestIds(answerOwedRequestIds),
		};
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
		this.#throwIfUnavailableDeliveryEvidence(
			`Message ${messageId} depends on quarantined Agent proof`,
			({ source }) => deriveMessageIdentity(source) === messageId,
		);
		throw new Error(`unknown_identity: Message ${messageId}`);
	}

	#inspectResolution(request: Request) {
		return inspectCanonicalRequestResolution({
			request,
			requesterSessionManager: this.#requireAgent(request.fromAgentId).host.sessionManager,
			responderSessionManager: this.#requireAgent(request.targetAgentId).host.sessionManager,
		});
	}

	#canonicalRequestsAuthoredBy(author: AgentRecord): Request[] {
		const canonical = new Map<string, Request>();
		for (const request of this.findRequestsAuthoredBy(author)) {
			const recipient = this.#agents.get(request.targetAgentId);
			const delivery = recipient === undefined
				? undefined
				: this.#inspectRequestDelivery(request, recipient).deliveryEvidence;
			if (
				inspectCanonicalMessage({
					message: request,
					authorSessionManager: author.host.sessionManager,
					deliveryEvidence: delivery,
				}).state !== "canonical"
			) continue;
			if (canonical.has(request.messageId)) {
				throw new Error(
					`invariant_violation: Request ${request.messageId} has multiple canonical sources`,
				);
			}
			canonical.set(request.messageId, request);
		}
		return [...canonical.values()];
	}

	#hasCanonicalAuthoredResolution(
		author: AgentRecord,
		requestId: string,
		operation: "answer" | "cancel",
	): boolean {
		const canonical = findAuthoredAgentMessageSources({
			authorAgentId: author.identity.agentId,
			sessionManager: author.host.sessionManager,
		}).filter(({ source, input }) =>
			input.operation === operation &&
			input.requestId === requestId &&
			inspectAgentMessageAuthorResult({
				authorAgentId: author.identity.agentId,
				sessionManager: author.host.sessionManager,
				source,
				input,
			}) === "canonical"
		);
		if (canonical.length > 1) {
			throw new Error(
				`invariant_violation: Request ${requestId} has multiple canonical ${operation === "answer" ? "Answers" : "Cancellations"}`,
			);
		}
		return canonical.length === 1;
	}

	#inspectRequestDelivery(request: Request, recipient: AgentRecord) {
		return request.origin === "agent_spawn"
			? inspectCreationRequestDelivery({
				recipientAgentId: recipient.identity.agentId,
				sessionManager: recipient.host.sessionManager,
				requestId: request.messageId,
				fromAgentId: request.fromAgentId,
				question: request.question,
				source: request.source,
			})
			: inspectMessageDelivery({
				recipientAgentId: recipient.identity.agentId,
				sessionManager: recipient.host.sessionManager,
				message: request,
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
		return requireAgentRecord(
			this.#agents,
			this.#quarantinedAgentIds,
			agentId,
		);
	}

	#throwIfUnavailableDeliveryEvidence(
		message: string,
		matches: (delivery: DeliveredMessageEvidence) => boolean,
	): void {
		for (const delivery of this.#allDeliveredMessages()) {
			if (matches(delivery) && this.#quarantinedAgentIds.has(delivery.source.agentId)) {
				validateDeliveredMessageEvidence(delivery);
				throw new EvidenceUnavailableError(message);
			}
		}
	}

	#allDeliveredMessages(): DeliveredMessageEvidence[] {
		return [...this.#agents.values()].flatMap((record) =>
			inspectMessageDeliveries({
				recipientAgentId: record.identity.agentId,
				sessionManager: record.host.sessionManager,
			}));
	}

	#wrongParticipant(caller: AgentRecord, messageId: string): Error {
		return new Error(
			`wrong_participant: Agent ${caller.identity.agentId} did not author Message ${messageId}`,
		);
	}
}

function uniqueRequestIds(requestIds: readonly string[]): string[] {
	return [...new Set(requestIds)];
}
