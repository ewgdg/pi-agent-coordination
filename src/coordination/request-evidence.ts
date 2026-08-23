import {
	EvidenceUnavailableError,
	requireAgentRecord,
	type AgentRecord,
} from "./agent-record.ts";
import {
	inspectCreationRequestDelivery,
	resolveCreationRequest,
} from "../protocol/creation-request.ts";
import {
	compareCommittedToolCallOrder,
	deriveMessageIdentity,
	type ToolCallPointer,
} from "../protocol/identities.ts";
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
	answerSourceDeliveryRequestId,
	answerSourceResultRequestId,
	findAuthoredAgentMessageSource,
	findAuthoredAgentMessageSources,
	findAuthoredRequestSources,
	inspectCanonicalRequestResolution,
} from "../protocol/request-resolution.ts";
import type { AgentWaitAnswer } from "../protocol/agent-wait.ts";
import type { ResidualRequestRelationships } from "../runtime/agent-runtime-host.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { resolveCommittedAgentMessageTargetId } from "./agent-message-target.ts";

type Request = Extract<Message, { kind: "request" }>;
type Answer = Extract<Message, { kind: "answer" }>;
type Cancellation = Extract<Message, { kind: "request_cancellation" }>;

export class RequestEvidence {
	readonly #agents: Map<string, AgentRecord>;
	readonly #quarantinedAgentIds: ReadonlySet<string>;
	readonly #quarantinedWorkflowAgentIds: ReadonlySet<string>;
	// The transcript is authoritative. These entries only bridge the interval after
	// lane admission and before Pi appends the native tool result.
	readonly #admittedAnswersByRequest = new Map<string, Answer>();
	readonly #admittedCancellationsByRequest = new Map<string, Cancellation>();

	constructor(
		agents: Map<string, AgentRecord>,
		quarantinedAgentIds: ReadonlySet<string> = new Set(),
		quarantinedWorkflowAgentIds: ReadonlySet<string> = quarantinedAgentIds,
	) {
		this.#agents = agents;
		this.#quarantinedAgentIds = quarantinedAgentIds;
		this.#quarantinedWorkflowAgentIds = quarantinedWorkflowAgentIds;
	}

	rememberAdmittedAnswer(answer: Answer): void {
		this.#admittedAnswersByRequest.set(answer.requestId, answer);
	}

	isAnswerAwaitingAuthorResult(answer: Answer): boolean {
		const responder = this.#requireAgent(answer.fromAgentId);
		const resultRequestId = answerSourceResultRequestId({
			transcript: responder.transcript.inspect(),
			source: answer.source,
		});
		return resultRequestId === undefined &&
			responder.host.currentHandle() !== undefined &&
			!responder.host.currentRunFailed();
	}

	findAnswerBySource(
		responder: AgentRecord,
		toolCallId: string,
	): Answer | undefined {
		const matches = new Map<string, Answer>();
		for (const answer of this.#admittedAnswersByRequest.values()) {
			if (
				answer.fromAgentId === responder.identity.agentId &&
				answer.source.toolCallId === toolCallId
			) matches.set(answer.messageId, answer);
		}
		for (const request of this.#requestsTargeting(responder)) {
			const answer = this.findAnswer(request);
			if (answer?.source.toolCallId === toolCallId) {
				matches.set(answer.messageId, answer);
			}
		}
		if (matches.size > 1) {
			throw new Error(
				`invariant_violation: Agent Answer source ${toolCallId} resolved multiple Requests`,
			);
		}
		return matches.values().next().value;
	}

	rememberAdmittedCancellation(cancellation: Cancellation): void {
		this.#admittedCancellationsByRequest.set(
			cancellation.requestId,
			cancellation,
		);
	}

	discardAdmittedAuthorshipBy(author: AgentRecord): void {
		for (const [requestId, answer] of this.#admittedAnswersByRequest) {
			if (answer.fromAgentId === author.identity.agentId) {
				this.#admittedAnswersByRequest.delete(requestId);
			}
		}
		for (const [requestId, cancellation] of this.#admittedCancellationsByRequest) {
			if (cancellation.fromAgentId === author.identity.agentId) {
				this.#admittedCancellationsByRequest.delete(requestId);
			}
		}
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
				transcript: author.transcript.inspect(),
				messageId: requestId,
			});
			if (!authored) continue;
			if (authored.input.operation !== "request") {
				throw new Error(`wrong_message_kind: Message ${requestId} is not a Request`);
			}
			const authorTranscript = author.transcript.inspect();
			const resolvedTargetAgentId = this.#resolveMessageTargetId(
				author,
				authorTranscript,
				authored.source.toolCallId,
				authored.input.targetAgent,
			);
			const request = resolveCommittedMessage({
				fromAgentId: author.identity.agentId,
				workflowId: author.identity.workflowId,
				transcript: authorTranscript,
				toolCallId: authored.source.toolCallId,
				providedInput: authored.input,
				resolvedTargetAgentId,
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
				projection.kind === "request" &&
				projection.requestMessageId === requestId,
		);
		throw new Error(`unknown_identity: Request ${requestId}`);
	}

	findRequestsAuthoredBy(author: AgentRecord): Request[] {
		const requests = findAuthoredRequestSources({
			authorAgentId: author.identity.agentId,
			transcript: author.transcript.inspect(),
		}).map(({ source, input }) => {
			const authorTranscript = author.transcript.inspect();
			const resolvedTargetAgentId = this.#resolveMessageTargetId(
				author,
				authorTranscript,
				source.toolCallId,
				input.targetAgent,
			);
			const message = resolveCommittedMessage({
				fromAgentId: author.identity.agentId,
				workflowId: author.identity.workflowId,
				transcript: authorTranscript,
				toolCallId: source.toolCallId,
				providedInput: input,
				resolvedTargetAgentId,
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

	outstandingRequestIdsAt(
		author: AgentRecord,
		waitSource: ToolCallPointer,
	): readonly string[] {
		if (waitSource.agentId !== author.identity.agentId) {
			throw new Error("wrong_participant: Agent Wait source belongs to another Agent");
		}
		const transcript = author.transcript.inspect();
		return this.#canonicalRequestsAuthoredBy(author)
			.filter((request) =>
				compareCommittedToolCallOrder(transcript, request.source, waitSource) < 0
			)
			.sort((left, right) =>
				compareCommittedToolCallOrder(transcript, left.source, right.source)
			)
			.flatMap((request) => {
				const cancellation = this.findCancellation(request);
				if (
					cancellation &&
					compareCommittedToolCallOrder(
						transcript,
						cancellation.source,
						waitSource,
					) < 0
				) return [];

				const answer = this.findAnswer(request);
				if (!answer) return [request.messageId];
				const delivery = inspectAnswerDelivery({
					requesterAgentId: author.identity.agentId,
					transcript,
					answer,
				}).deliveryEvidence;
				if (delivery) return [];
				return [request.messageId];
			});
	}

	activeRequestFor(responder: AgentRecord): Request {
		const requestIds = this.residualRelationshipsFor(responder).answerOwedRequestIds;
		if (requestIds.length === 0) {
			throw new Error("invalid_input: Agent has no active Request to answer");
		}
		if (requestIds.length > 1) {
			throw new Error(
				`invariant_violation: Agent ${responder.identity.agentId} has multiple active Requests`,
			);
		}
		return this.requireRequest(requestIds[0]!);
	}

	hasActiveRequest(responder: AgentRecord): boolean {
		const requestIds = this.residualRelationshipsFor(responder).answerOwedRequestIds;
		if (requestIds.length > 1) {
			throw new Error(
				`invariant_violation: Agent ${responder.identity.agentId} has multiple active Requests`,
			);
		}
		return requestIds.length === 1;
	}

	residualRelationshipsFor(agent: AgentRecord): ResidualRequestRelationships {
		this.#validateAnswerResultReferences(agent);
		const awaitingAnswerRequestIds: string[] = [];
		const answerOwedRequestIds: string[] = [];
		const localDeliveries = inspectMessageDeliveries({
			recipientAgentId: agent.identity.agentId,
			transcript: agent.transcript.inspect(),
		});
		const deliveredAnswerRequestIds = new Set([
			...localDeliveries.flatMap((delivery) => {
				if (
					delivery.projection.kind !== "answer" ||
					this.#agents.has(delivery.source.agentId)
				) return [];
				validateDeliveredMessageEvidence(delivery);
				return [delivery.projection.requestMessageId];
			}),
			...inspectAnswerRetrievals({
				requesterAgentId: agent.identity.agentId,
				transcript: agent.transcript.inspect(),
			}).map(({ requestId }) => requestId),
		]);
		const deliveredCancellationRequestIds = new Set(
			localDeliveries.flatMap((delivery) => {
				if (
					delivery.projection.kind !== "request_cancellation" ||
					this.#agents.has(delivery.source.agentId)
				) return [];
				validateDeliveredMessageEvidence(delivery);
				return [delivery.projection.requestMessageId];
			}),
		);

		for (const request of this.#canonicalRequestsAuthoredBy(agent)) {
			const responder = this.#agents.get(request.targetAgentId);
			if (responder) {
				const resolution = this.#inspectResolution(request);
				const answerDelivered = resolution.answer !== undefined &&
					inspectAnswerDelivery({
						requesterAgentId: agent.identity.agentId,
						transcript: agent.transcript.inspect(),
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
						transcript: agent.transcript.inspect(),
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
		const uniqueAnswerOwedRequestIds = uniqueRequestIds(answerOwedRequestIds);
		if (uniqueAnswerOwedRequestIds.length > 1) {
			throw new Error(
				`invariant_violation: Agent ${agent.identity.agentId} has multiple active Requests`,
			);
		}
		return {
			awaitingAnswerRequestIds: uniqueRequestIds(awaitingAnswerRequestIds),
			answerOwedRequestIds: uniqueAnswerOwedRequestIds,
		};
	}

	callerWaitAnswer(
		caller: AgentRecord,
		requestId: string,
	): AgentWaitAnswer | undefined {
		const message = this.requireCallerAuthoredMessage(caller, requestId);
		if (message.kind !== "request") {
			throw new Error(`wrong_message_kind: Message ${requestId} is not a Request`);
		}
		const resolution = this.#inspectResolution(message);
		if (resolution.cancellation) {
			throw new Error(`invalid_state: Request ${requestId} was cancelled`);
		}
		const answer = resolution.answer;
		if (!answer) return undefined;
		const delivery = inspectAnswerDelivery({
			requesterAgentId: caller.identity.agentId,
			transcript: caller.transcript.inspect(),
			answer,
		});
		return delivery.deliveryEvidence
			? {
				disposition: "answer_already_delivered",
				requestMessageId: requestId,
				answerId: answer.messageId,
				deliveryEvidence: delivery.deliveryEvidence,
			}
			: {
				disposition: "answer_delivered",
				requestMessageId: requestId,
				answerId: answer.messageId,
				fromAgentId: answer.fromAgentId,
				answer: answer.answer,
				answerSource: answer.source,
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
			requesterTranscript: this.#requireAgent(request.fromAgentId).transcript.inspect(),
			responderTranscript: this.#requireAgent(request.targetAgentId).transcript.inspect(),
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
					authorTranscript: author.transcript.inspect(),
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
			transcript: author.transcript.inspect(),
		}).filter(({ source, input }) => {
			if (operation === "answer") {
				if (
					input.operation !== "answer" ||
					(
						answerSourceResultRequestId({
							transcript: author.transcript.inspect(),
							source,
						}) ?? requestId
					) !== requestId
				) return false;
				return inspectAgentMessageAuthorResult({
					authorAgentId: author.identity.agentId,
					transcript: author.transcript.inspect(),
					source,
					input,
					requestId,
				}) === "canonical";
			}
			if (
				input.operation !== "cancel" ||
				input.requestMessageId !== requestId
			) return false;
			return inspectAgentMessageAuthorResult({
				authorAgentId: author.identity.agentId,
				transcript: author.transcript.inspect(),
				source,
				input,
				resolvedTargetAgentId: this.requireRequest(requestId).targetAgentId,
			}) === "canonical";
		});
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
				transcript: recipient.transcript.inspect(),
				requestId: request.messageId,
				fromAgentId: request.fromAgentId,
				question: request.question,
				source: request.source,
			})
			: inspectMessageDelivery({
				recipientAgentId: recipient.identity.agentId,
				transcript: recipient.transcript.inspect(),
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
				spawnerTranscript: spawner.transcript.inspect(),
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
			transcript: author.transcript.inspect(),
			messageId,
		});
		if (!authored) return undefined;
		if (authored.input.operation === "send" || authored.input.operation === "request") {
			const authorTranscript = author.transcript.inspect();
			const resolvedTargetAgentId = this.#resolveMessageTargetId(
				author,
				authorTranscript,
				authored.source.toolCallId,
				authored.input.targetAgent,
			);
			return resolveCommittedMessage({
				fromAgentId: author.identity.agentId,
				workflowId: author.identity.workflowId,
				transcript: authorTranscript,
				toolCallId: authored.source.toolCallId,
				providedInput: authored.input,
				resolvedTargetAgentId,
			});
		}
		if (authored.input.operation === "answer") {
			const answerInput = authored.input;
			const resultRequestId = answerSourceResultRequestId({
				transcript: author.transcript.inspect(),
				source: authored.source,
			});
			if (resultRequestId !== undefined) {
				this.#requireResponderRequest(author, resultRequestId);
			}
			const matches = this.#requestsTargeting(author).flatMap((request) => {
				const requester = this.#agents.get(request.fromAgentId);
				if (!requester) return [];
				const deliveryRequestId = answerSourceDeliveryRequestId({
					requesterAgentId: requester.identity.agentId,
					transcript: requester.transcript.inspect(),
					source: authored.source,
				});
				if (
					resultRequestId !== undefined &&
					deliveryRequestId !== undefined &&
					resultRequestId !== deliveryRequestId
				) {
					throw new Error(
						`invariant_violation: Agent Answer ${messageId} result and Delivery name different Requests`,
					);
				}
				if ((resultRequestId ?? deliveryRequestId) !== request.messageId) return [];
				const answer = resolveCommittedAnswer({
					responderAgentId: author.identity.agentId,
					transcript: author.transcript.inspect(),
					toolCallId: authored.source.toolCallId,
					providedInput: answerInput,
					request,
				});
				const delivery = inspectAnswerDelivery({
					requesterAgentId: requester.identity.agentId,
					transcript: requester.transcript.inspect(),
					answer,
				});
				return inspectCanonicalMessage({
					message: answer,
					authorTranscript: author.transcript.inspect(),
					deliveryEvidence: delivery.deliveryEvidence,
				}).state === "canonical" ? [answer] : [];
			});
			if (matches.length > 1) {
				throw new Error(
					`invariant_violation: Agent Answer ${messageId} correlates multiple Requests`,
				);
			}
			return matches[0];
		}
		const request = this.requireRequest(authored.input.requestMessageId);
		return resolveCommittedCancellation({
			requesterAgentId: author.identity.agentId,
			transcript: author.transcript.inspect(),
			toolCallId: authored.source.toolCallId,
			providedInput: authored.input,
			request,
		});
	}

	#validateAnswerResultReferences(author: AgentRecord): void {
		for (const { source, input } of findAuthoredAgentMessageSources({
			authorAgentId: author.identity.agentId,
			transcript: author.transcript.inspect(),
		})) {
			if (input.operation !== "answer") continue;
			const requestId = answerSourceResultRequestId({
				transcript: author.transcript.inspect(),
				source,
			});
			if (requestId !== undefined) this.#requireResponderRequest(author, requestId);
		}
	}

	#requireResponderRequest(responder: AgentRecord, requestId: string): Request {
		const request = this.requireRequest(requestId);
		if (request.targetAgentId !== responder.identity.agentId) {
			throw new Error(
				`invariant_violation: Agent Answer result names a Request for another responder`,
			);
		}
		return request;
	}

	#requestsTargeting(responder: AgentRecord): Request[] {
		return [...this.#agents.values()].flatMap((requester) =>
			this.findRequestsAuthoredBy(requester).filter(
				(request) => request.targetAgentId === responder.identity.agentId,
			)
		);
	}

	#resolveMessageTargetId(
		author: AgentRecord,
		authorTranscript: TranscriptInspection,
		toolCallId: string,
		targetAgent: string,
	): string {
		return resolveCommittedAgentMessageTargetId({
			agents: this.#agents,
			quarantinedWorkflowAgentIds: this.#quarantinedWorkflowAgentIds,
			authorAgentId: author.identity.agentId,
			authorTranscript,
			toolCallId,
			targetAgent,
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
				transcript: record.transcript.inspect(),
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
