import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";

import {
	requireAgentRecord,
	type AgentRecord,
} from "./agent-record.ts";
import {
	MessageDeliveryScheduler,
	type IncomingRequestWaitPreemptor,
	type ScheduledCustomDelivery,
	type ScheduledMessageDelivery,
	type ResumeReservationHandler,
	type ScheduleDeliveryDispatch,
	type ScheduleReleaseEvaluation,
	type SteerFreezeHandler,
} from "./message-delivery-scheduler.ts";
import type {
	AgentAnswerReceipt,
	AgentMessagePollReceipt,
	AgentMessageReceipt,
	AgentMessageRetryReceipt,
	AgentMessageSendReceipt,
	AgentRequestReceipt,
	AgentRequestRetryReceipt,
	RequestCancellationReceipt,
} from "./message-receipts.ts";
import { RequestEvidence } from "./request-evidence.ts";
import {
	createMessageDeliveryItem,
	inspectAnswerDelivery,
	inspectCanonicalMessage,
	inspectMessageDelivery,
	resolveCommittedAnswer,
	resolveCommittedCancellation,
	resolveCommittedMessage,
	resolveCommittedAgentMessageInput,
	sameAgentMessageInput,
	type AgentMessageInput,
	type AnswerInput,
	type CancellationInput,
	type Message,
	type MessagePollInput,
	type MessageRetryInput,
} from "../protocol/message.ts";
import {
	createCreationRequestDeliveryItem,
	inspectCreationRequestDelivery,
} from "../protocol/creation-request.ts";
import type { AgentWaitResult } from "../protocol/agent-wait.ts";
import type { ToolCallPointer } from "../protocol/identities.ts";
import type { InterruptionHoldHandle } from "../runtime/agent-runtime-host.ts";
import type { WorkflowPolicyStore } from "../policy/workflow-policy.ts";
import type { UnresolvedAgentRequest } from "./dependency-deadlock.ts";

export type { AgentMessageInput } from "../protocol/message.ts";
export type {
	AgentAnswerReceipt,
	AgentMessagePollReceipt,
	AgentMessageReceipt,
	AgentMessageRetryReceipt,
	AgentMessageSendReceipt,
	AgentRequestReceipt,
	AgentRequestRetryReceipt,
	RequestCancellationReceipt,
} from "./message-receipts.ts";

export type MessageBoundaryHooks = Readonly<{
	scheduleDeliveryDispatch?: ScheduleDeliveryDispatch;
	beforeDeliveryAdmission?(context: Readonly<{
		recipientAgentId: string;
		messageId: string;
		operation: "send" | "retry" | "answer" | "cancel";
	}>): void | "confirmed_failure";
	beforeRecipientInspection?(context: Readonly<{
		recipientAgentId: string;
		messageId: string;
		operation: "poll" | "retry";
	}>): void | "inspection_incomplete";
	afterDeliveryAdmission?(context: Readonly<{
		recipientAgentId: string;
		messageId: string;
		operation: "send" | "retry" | "answer" | "cancel";
	}>): void | "confirmation_lost";
	afterSteerFreeze?: SteerFreezeHandler;
	afterResumeReservation?: ResumeReservationHandler;
	scheduleReleaseEvaluation?: ScheduleReleaseEvaluation;
}>;

export class MessageCoordinator {
	readonly #agents: Map<string, AgentRecord>;
	readonly #isShuttingDown: () => boolean;
	readonly #boundaryHooks: MessageBoundaryHooks;
	readonly #deliveryScheduler: MessageDeliveryScheduler;
	readonly #requestEvidence: RequestEvidence;
	readonly #quarantinedAgentIds: ReadonlySet<string>;

	constructor(options: {
		agents: Map<string, AgentRecord>;
		quarantinedAgentIds?: ReadonlySet<string>;
		isShuttingDown(): boolean;
		boundaryHooks?: MessageBoundaryHooks;
		preemptAgentWait?: IncomingRequestWaitPreemptor;
		workflowPolicy: WorkflowPolicyStore;
	}) {
		this.#agents = options.agents;
		this.#quarantinedAgentIds = options.quarantinedAgentIds ?? new Set();
		this.#isShuttingDown = options.isShuttingDown;
		this.#boundaryHooks = options.boundaryHooks ?? {};
		this.#requestEvidence = new RequestEvidence(
			this.#agents,
			this.#quarantinedAgentIds,
		);
		this.#deliveryScheduler = new MessageDeliveryScheduler({
			scheduleReleaseEvaluation: this.#boundaryHooks.scheduleReleaseEvaluation,
			scheduleDeliveryDispatch: this.#boundaryHooks.scheduleDeliveryDispatch,
			afterSteerFreeze: this.#boundaryHooks.afterSteerFreeze,
			afterResumeReservation: this.#boundaryHooks.afterResumeReservation,
			preemptAgentWait: options.preemptAgentWait,
			workflowPolicy: options.workflowPolicy,
		});
	}

	integrate(record: AgentRecord): void {
		record.host.setRunStartInitializer(
			() => this.#requestEvidence.residualRelationshipsFor(record),
		);
		record.host.addSettledHandler((_handle, settlement) => {
			if (settlement === "failed") {
				this.#requestEvidence.discardAdmittedAuthorshipBy(record);
			}
		});
		this.#deliveryScheduler.integrate(record);
		if (record.host.currentHandle()) {
			record.host.initializeCurrentRunRelationships();
		}
	}

	requestSources(requestIds: readonly string[]): readonly ToolCallPointer[] {
		return requestIds.map(
			(requestId) => this.#requestEvidence.requireRequest(requestId).source,
		);
	}

	requestQuestion(requestId: string): string {
		return this.#requestEvidence.requireRequest(requestId).question;
	}

	// Re-arbitrate retrieval at the native commit edge so a direct Delivery that
	// won after tool execution cannot leave a second requester-side proof.
	guardResultCommit(
		callerAgentId: string,
		message: MessageEndEvent["message"],
	): Readonly<{ message: MessageEndEvent["message"] }> | undefined {
		if (
			message.role !== "toolResult" ||
			message.toolName !== "agent_message" ||
			message.isError ||
			typeof message.details !== "object" ||
			message.details === null ||
			!("disposition" in message.details) ||
			message.details.disposition !== "answer_delivered"
		) return undefined;
		const caller = this.#requireAgent(callerAgentId);
		const input = resolveCommittedAgentMessageInput({
			agentId: callerAgentId,
			transcript: caller.transcript.inspect(),
			toolCallId: message.toolCallId,
		});
		if (input.operation !== "retry") return undefined;
		const request = this.#requestEvidence.requireCallerAuthoredMessage(
			caller,
			input.messageId,
		);
		if (request.kind !== "request") return undefined;
		const answer = this.#requestEvidence.findAnswer(request);
		if (!answer) return undefined;
		const expected = {
			disposition: "answer_delivered" as const,
			requestMessageId: request.messageId,
			answerId: answer.messageId,
			fromAgentId: answer.fromAgentId,
			answer: answer.answer,
			answerSource: answer.source,
		};
		if (!isDeepStrictEqual(message.details, expected)) return undefined;
		const deliveryEvidence = inspectAnswerDelivery({
			requesterAgentId: callerAgentId,
			transcript: caller.transcript.inspect(),
			answer,
		}).deliveryEvidence;
		const result = deliveryEvidence
			? {
				disposition: "answer_already_delivered" as const,
				requestMessageId: request.messageId,
				answerId: answer.messageId,
				deliveryEvidence,
			}
			: this.#deliveryScheduler.hasDispatchReservation(
				callerAgentId,
				answer.messageId,
			)
				? {
					requestMessageId: request.messageId,
					messageStatus: "unknown" as const,
					reason: "inspection_incomplete" as const,
				}
				: undefined;
		if (!result) return undefined;
		return {
			message: {
				...message,
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			},
		};
	}

	outstandingRequestIds(
		callerAgentId: string,
		waitSource: ToolCallPointer,
	): readonly string[] {
		const caller = this.#requireAgent(callerAgentId);
		const requestMessageIds = this.#requestEvidence.outstandingRequestIdsAt(
			caller,
			waitSource,
		);
		if (requestMessageIds.length === 0) {
			throw new Error(
				"invalid_input: Agent Wait requires at least one outstanding outbound Agent Request",
			);
		}
		return requestMessageIds;
	}

	waitAnswers(
		callerAgentId: string,
		requestMessageIds: readonly string[],
	): AgentWaitResult | undefined {
		const caller = this.#requireAgent(callerAgentId);
		const answers = requestMessageIds.map((requestId) => {
			const answer = this.#requestEvidence.callerWaitAnswer(caller, requestId);
			return answer?.disposition === "answer_delivered" &&
				this.#deliveryScheduler.hasDispatchReservation(
					callerAgentId,
					answer.answerId,
				)
				? undefined
				: answer;
		});
		return answers.every((answer) => answer !== undefined)
			? { answers }
			: undefined;
	}

	requestTargetAgentIds(requestIds: readonly string[]): readonly string[] {
		return requestIds.map(
			(requestId) => this.#requestEvidence.requireRequest(requestId).targetAgentId,
		);
	}

	requestRelationships(requestIds: readonly string[]): readonly UnresolvedAgentRequest[] {
		return requestIds.map((requestId) => {
			const request = this.#requestEvidence.requireRequest(requestId);
			return {
				requestId,
				fromAgentId: request.fromAgentId,
				targetAgentId: request.targetAgentId,
			};
		});
	}

	answerObligationRequestIds(responder: AgentRecord): readonly string[] {
		return this.#requestEvidence.residualRelationshipsFor(responder)
			.answerOwedRequestIds;
	}

	hasUnsettledAnswerObligation(
		responder: AgentRecord,
		requestIds: readonly string[],
	): boolean {
		const remaining = new Set(this.answerObligationRequestIds(responder));
		return requestIds.some((requestId) => remaining.has(requestId));
	}

	async send(
		callerAgentId: string,
		toolCallId: string,
		input: Extract<AgentMessageInput, { operation: "send" | "request" }>,
	): Promise<AgentMessageSendReceipt | AgentRequestReceipt> {
		const sender = this.#requireAgent(callerAgentId);
		const message = resolveCommittedMessage({
			fromAgentId: callerAgentId,
			workflowId: sender.identity.workflowId,
			transcript: sender.transcript.inspect(),
			toolCallId,
			providedInput: input,
		});
		const recipient = this.#requireAgent(message.targetAgentId);
		if (recipient.identity.workflowId !== message.workflowId) {
			throw new Error("wrong_workflow: Message recipient is outside the sender Workflow");
		}
		if (message.kind === "message") {
			const activeRequestId = await sender.host.lane.run(
				() => this.answerObligationRequestIds(sender)[0],
			);
			if (activeRequestId !== undefined) {
				const activeRequest = this.#requestEvidence.requireRequest(activeRequestId);
				if (activeRequest.fromAgentId === message.targetAgentId) {
					return {
						disposition: "rejected",
						reason: "answer_required",
						requestMessageId: activeRequest.messageId,
					};
				}
			}
		}
		const identity = message.kind === "request"
			? { requestMessageId: message.messageId }
			: { messageId: message.messageId };
		if (this.#isShuttingDown()) {
			return {
				...identity,
				messageStatus: "not_sent",
				reason: "host_shutting_down",
			};
		}
		if (message.kind === "request") {
			sender.host.addRetentionReason("awaiting_answer", message.messageId);
		}
		if (
			this.#boundaryHooks.beforeDeliveryAdmission?.({
				recipientAgentId: recipient.identity.agentId,
				messageId: message.messageId,
				operation: "send",
			}) === "confirmed_failure"
		) {
			return {
				...identity,
				messageStatus: "not_sent",
				reason: "target_unavailable",
			};
		}
		const delivery = this.#scheduleGeneralMessage(recipient, message);
		const admission = await this.#deliveryScheduler.admit(recipient, delivery);
		if (admission === "pending") {
			return this.#boundaryHooks.afterDeliveryAdmission?.({
				recipientAgentId: recipient.identity.agentId,
				messageId: message.messageId,
				operation: "send",
			}) === "confirmation_lost"
				? { ...identity, messageStatus: "unknown", reason: "confirmation_lost" }
				: { ...identity, messageStatus: "sent" };
		}
		return {
			...identity,
			messageStatus: "not_sent",
			reason: admission,
		};
	}

	async admitCreationRequest(options: {
		recipient: AgentRecord;
		requestId: string;
		fromAgentId: string;
		question: string;
		source: ToolCallPointer;
	}): Promise<"pending" | "target_unavailable" | "capacity_exhausted"> {
		const { recipient, requestId, fromAgentId, question, source } = options;
		const delivery: ScheduledMessageDelivery = {
			messageId: requestId,
			deliveryMode: "deferred",
			deliveryItem: createCreationRequestDeliveryItem({
				requestId,
				fromAgentId,
				question,
				source,
			}),
			inspectProof: () =>
				inspectCreationRequestDelivery({
					recipientAgentId: recipient.identity.agentId,
					transcript: recipient.transcript.inspect(),
					requestId,
					fromAgentId,
					question,
					source,
				}).deliveryEvidence,
			isSuppressed: () => this.#isCancellationDelivered(requestId, recipient),
			isIncomingRequest: true,
			isIncomingRequestActive: () =>
				this.#requestEvidence.hasActiveRequest(recipient),
			afterCommit: () => {
				const request = this.#requestEvidence.requireRequest(requestId);
				if (
					this.#requestEvidence.findAnswer(request) === undefined &&
					!this.#isCancellationDelivered(requestId, recipient)
				) {
					recipient.host.addRetentionReason("answer_owed", requestId);
				}
			},
		};
		return this.#deliveryScheduler.admit(recipient, delivery);
	}

	admitCustomDelivery(
		recipient: AgentRecord,
		delivery: ScheduledCustomDelivery,
	): Promise<"pending" | "target_unavailable" | "capacity_exhausted"> {
		return this.#deliveryScheduler.admitCustom(recipient, delivery);
	}

	requestRelease(record: AgentRecord): Promise<"released" | "retained" | "stale"> {
		return this.#deliveryScheduler.requestRelease(record);
	}

	agentWaitStarted(record: AgentRecord): Promise<void> {
		return this.#deliveryScheduler.requestQueueAdvanced(record);
	}

	async reachSafeBoundary(agentId: string): Promise<void> {
		if (this.#isShuttingDown()) return Promise.resolve();
		const record = this.#requireAgent(agentId);
		// Confirmed Run disposal already owns this Agent lane and fences its volatile
		// scheduling. Re-entering the lane from Pi's awaited turn_end would deadlock
		// disposal while it waits for the same turn to settle.
		if (record.host.observe().phase === "ending" || record.host.isInterrupting()) {
			return Promise.resolve();
		}
		await record.host.lane.run(async () => {
			this.#reconcileAnswerDeliveries(record);
			if (this.#reconcileCommittedAnswerAuthorship(record)) {
				await this.#deliveryScheduler.requestQueueAdvancedInLane(record);
			}
		});
		return this.#deliveryScheduler.reachSafeBoundary(record);
	}

	discardSchedulingInLane(record: AgentRecord): void {
		this.#requestEvidence.discardAdmittedAuthorshipBy(record);
		this.#deliveryScheduler.discardInLane(record);
	}

	prepareInterruptionInLane(record: AgentRecord): void {
		this.#deliveryScheduler.prepareInterruptionInLane(record);
	}

	admitResumeInLane(
		record: AgentRecord,
		message: Extract<Message, { kind: "message" }>,
		hold: InterruptionHoldHandle,
	) {
		return this.#deliveryScheduler.admitResumeInLane(
			record,
			this.#scheduleGeneralMessage(record, message),
			hold,
		);
	}

	execute(
		callerAgentId: string,
		toolCallId: string,
		providedInput: AgentMessageInput,
	): Promise<AgentMessageReceipt> {
		const caller = this.#requireAgent(callerAgentId);
		const committedInput = resolveCommittedAgentMessageInput({
			agentId: callerAgentId,
			transcript: caller.transcript.inspect(),
			toolCallId,
		});
		if (!sameAgentMessageInput(committedInput, providedInput)) {
			throw new Error("invariant_violation: executed Agent Message input differs from its source");
		}
		if (committedInput.operation === "send" || committedInput.operation === "request") {
			return this.send(callerAgentId, toolCallId, committedInput);
		}
		if (committedInput.operation === "answer") {
			return this.#answer(caller, toolCallId, committedInput);
		}
		if (committedInput.operation === "cancel") {
			return this.#cancel(caller, toolCallId, committedInput);
		}
		return committedInput.operation === "poll"
			? this.#poll(caller, committedInput)
			: this.#retry(caller, committedInput);
	}

	async #answer(
		caller: AgentRecord,
		toolCallId: string,
		input: AnswerInput,
	): Promise<AgentAnswerReceipt> {
		const admitted = await caller.host.lane.run(async () => {
			const repeatedAnswer = this.#requestEvidence.findAnswerBySource(
				caller,
				toolCallId,
			);
			const request = repeatedAnswer
				? this.#requestEvidence.requireRequest(repeatedAnswer.requestId)
				: this.#requestEvidence.activeRequestFor(caller);
			const requester = this.#requireAgent(request.fromAgentId);
			const delivery = inspectMessageDelivery({
				recipientAgentId: caller.identity.agentId,
				transcript: caller.transcript.inspect(),
				message: request,
			});
			const canonical = inspectCanonicalMessage({
				message: request,
				authorTranscript: requester.transcript.inspect(),
				deliveryEvidence: delivery.deliveryEvidence,
			});
			if (canonical.state !== "canonical" || !delivery.deliveryEvidence) {
				throw new Error(
					`invalid_input: Request ${request.messageId} has not been delivered to its responder`,
				);
			}
			const existing = this.#requestEvidence.findAnswer(request);
			if (existing) {
				return { disposition: "existing", request, requester, answer: existing } as const;
			}
			const cancellation = this.#requestEvidence.findCancellation(request);
			if (
				cancellation &&
				inspectMessageDelivery({
					recipientAgentId: caller.identity.agentId,
					transcript: caller.transcript.inspect(),
					message: cancellation,
				}).deliveryEvidence
			) {
				return {
					disposition: "cancelled",
					request,
					requester,
					cancellation,
				} as const;
			}
			const answer = resolveCommittedAnswer({
				responderAgentId: caller.identity.agentId,
				transcript: caller.transcript.inspect(),
				toolCallId,
				providedInput: input,
				request,
			});
			this.#requestEvidence.rememberAdmittedAnswer(answer);
			return { disposition: "admitted", request, requester, answer } as const;
		});
		if (admitted.disposition === "existing") {
			return {
				messageId: admitted.answer.messageId,
				requestMessageId: admitted.request.messageId,
				answerId: admitted.answer.messageId,
				disposition: "already_answered",
			};
		}
		if (admitted.disposition === "cancelled") {
			return {
				messageId: admitted.cancellation.messageId,
				requestMessageId: admitted.request.messageId,
				cancellationId: admitted.cancellation.messageId,
				disposition: "already_cancelled",
			};
		}
		const { answer, request, requester } = admitted;
		if (this.#isShuttingDown()) {
			return {
				messageId: answer.messageId,
				requestMessageId: request.messageId,
				messageStatus: "not_sent",
				reason: "host_shutting_down",
			};
		}
		if (
			this.#boundaryHooks.beforeDeliveryAdmission?.({
				recipientAgentId: requester.identity.agentId,
				messageId: answer.messageId,
				operation: "answer",
			}) === "confirmed_failure"
		) {
			return {
				messageId: answer.messageId,
				requestMessageId: request.messageId,
				messageStatus: "not_sent",
				reason: "target_unavailable",
			};
		}
		const admission = await this.#deliveryScheduler.admit(
			requester,
			this.#scheduleGeneralMessage(requester, answer),
		);
		if (admission === "pending") {
			return this.#boundaryHooks.afterDeliveryAdmission?.({
				recipientAgentId: requester.identity.agentId,
				messageId: answer.messageId,
				operation: "answer",
			}) === "confirmation_lost"
				? {
					messageId: answer.messageId,
					requestMessageId: request.messageId,
					messageStatus: "unknown",
					reason: "confirmation_lost",
				}
				: {
					messageId: answer.messageId,
					requestMessageId: request.messageId,
					messageStatus: "sent",
				};
		}
		return {
			messageId: answer.messageId,
			requestMessageId: request.messageId,
			messageStatus: "not_sent",
			reason: admission,
		};
	}

	async #cancel(
		caller: AgentRecord,
		toolCallId: string,
		input: CancellationInput,
	): Promise<RequestCancellationReceipt> {
		const admitted = await caller.host.lane.run(() => {
			const request = this.#requestEvidence.requireRequest(input.requestMessageId);
			if (request.fromAgentId !== caller.identity.agentId) {
				throw new Error(
					`wrong_participant: Agent ${caller.identity.agentId} is not the requester for Request ${request.messageId}`,
				);
			}
			const responder = this.#requireAgent(request.targetAgentId);
			const answer = this.#requestEvidence.findAnswer(request);
			if (answer) {
				const delivery = inspectAnswerDelivery({
					requesterAgentId: caller.identity.agentId,
					transcript: caller.transcript.inspect(),
					answer,
				});
				if (delivery.deliveryEvidence) {
					return { disposition: "answered", request, responder, answer } as const;
				}
			}
			const existing = this.#requestEvidence.findCancellation(request);
			if (existing) {
				return { disposition: "existing", request, responder, cancellation: existing } as const;
			}
			const cancellation = resolveCommittedCancellation({
				requesterAgentId: caller.identity.agentId,
				transcript: caller.transcript.inspect(),
				toolCallId,
				providedInput: input,
				request,
			});
			this.#requestEvidence.rememberAdmittedCancellation(cancellation);
			caller.host.removeRetentionReason("awaiting_answer", request.messageId);
			return { disposition: "admitted", request, responder, cancellation } as const;
		});
		if (admitted.disposition === "answered") {
			return {
				disposition: "already_answered",
				answerMessageId: admitted.answer.messageId,
			};
		}
		if (admitted.disposition === "existing") {
			return {
				disposition: "already_cancelled",
				cancellationMessageId: admitted.cancellation.messageId,
			};
		}
		const { cancellation, responder } = admitted;
		const identity = { messageId: cancellation.messageId };
		if (this.#isShuttingDown()) {
			return {
				...identity,
				messageStatus: "not_sent",
				reason: "host_shutting_down",
			};
		}
		if (
			this.#boundaryHooks.beforeDeliveryAdmission?.({
				recipientAgentId: responder.identity.agentId,
				messageId: cancellation.messageId,
				operation: "cancel",
			}) === "confirmed_failure"
		) {
			return {
				...identity,
				messageStatus: "not_sent",
				reason: "target_unavailable",
			};
		}
		const admission = await this.#deliveryScheduler.admit(
			responder,
			this.#scheduleGeneralMessage(responder, cancellation),
		);
		if (admission === "pending") {
			return this.#boundaryHooks.afterDeliveryAdmission?.({
				recipientAgentId: responder.identity.agentId,
				messageId: cancellation.messageId,
				operation: "cancel",
			}) === "confirmation_lost"
				? { ...identity, messageStatus: "unknown", reason: "confirmation_lost" }
				: { ...identity, messageStatus: "sent" };
		}
		return { ...identity, messageStatus: "not_sent", reason: admission };
	}

	async #retry(
		caller: AgentRecord,
		input: MessageRetryInput,
	): Promise<AgentMessageRetryReceipt | AgentRequestRetryReceipt> {
		const authorTranscript = caller.transcript.inspect();
		const message = this.#requestEvidence.requireCallerAuthoredMessage(
			caller,
			input.messageId,
		);
		if (message.kind === "request") {
			return this.#retryRequest(caller, message);
		}
		const recipient = this.#requireAgent(message.targetAgentId);
		return recipient.host.lane.run(async () => {
			if (
				this.#boundaryHooks.beforeRecipientInspection?.({
					recipientAgentId: recipient.identity.agentId,
					messageId: message.messageId,
					operation: "retry",
				}) === "inspection_incomplete"
			) {
				return {
					messageId: message.messageId,
					messageStatus: "not_sent",
					reason: "evidence_unavailable",
				};
			}
			const delivery = inspectMessageDelivery({
				recipientAgentId: recipient.identity.agentId,
				transcript: recipient.transcript.inspect(),
				message,
			});
			const canonical = inspectCanonicalMessage({
				message,
				authorTranscript,
				deliveryEvidence: delivery.deliveryEvidence,
			});
			if (canonical.state === "not_created") {
				throw new Error(`unknown_identity: Message ${input.messageId} was not created`);
			}
			if (canonical.state === "indeterminate") {
				return {
					messageId: message.messageId,
					messageStatus: "unknown",
					reason: "inspection_incomplete",
				};
			}
			if (delivery.deliveryEvidence) {
				return {
					disposition: "delivered",
					messageId: message.messageId,
					deliveryEvidence: delivery.deliveryEvidence,
				};
			}
			if (this.#isShuttingDown()) {
				return {
					messageId: message.messageId,
					messageStatus: "not_sent",
					reason: "host_shutting_down",
				};
			}
			const admission = await this.#deliveryScheduler.admitInLane(
				recipient,
				this.#scheduleGeneralMessage(recipient, message),
			);
			if (admission === "pending") {
				return this.#boundaryHooks.afterDeliveryAdmission?.({
					recipientAgentId: recipient.identity.agentId,
					messageId: message.messageId,
					operation: "retry",
				}) === "confirmation_lost"
					? {
						messageId: message.messageId,
						messageStatus: "unknown",
						reason: "confirmation_lost",
					}
					: { messageId: message.messageId, messageStatus: "sent" };
			}
			return {
				messageId: message.messageId,
				messageStatus: "not_sent",
				reason: admission,
			};
		});
	}

	async #retryRequest(
		requester: AgentRecord,
		request: Extract<Message, { kind: "request" }>,
	): Promise<AgentRequestRetryReceipt> {
		const responder = this.#requireAgent(request.targetAgentId);
		if (this.#requestEvidence.findCancellation(request)) {
			return {
				requestMessageId: request.messageId,
				messageStatus: "not_sent",
				reason: "policy_rejected",
			};
		}
		return responder.host.lane.run(async () => {
			if (
				this.#boundaryHooks.beforeRecipientInspection?.({
					recipientAgentId: responder.identity.agentId,
					messageId: request.messageId,
					operation: "retry",
				}) === "inspection_incomplete"
			) {
				return {
					requestMessageId: request.messageId,
					messageStatus: "not_sent",
					reason: "evidence_unavailable",
				};
			}
			const requestDelivery = inspectMessageDelivery({
				recipientAgentId: responder.identity.agentId,
				transcript: responder.transcript.inspect(),
				message: request,
			});
			const canonicalRequest = inspectCanonicalMessage({
				message: request,
				authorTranscript: requester.transcript.inspect(),
				deliveryEvidence: requestDelivery.deliveryEvidence,
			});
			if (canonicalRequest.state === "not_created") {
				throw new Error(`unknown_identity: Request ${request.messageId} was not created`);
			}
			if (canonicalRequest.state === "indeterminate") {
				return {
					requestMessageId: request.messageId,
					messageStatus: "unknown",
					reason: "inspection_incomplete",
				};
			}
			const answer = this.#requestEvidence.findAnswer(request);
			if (answer) {
				const answerDelivery = inspectAnswerDelivery({
					requesterAgentId: requester.identity.agentId,
					transcript: requester.transcript.inspect(),
					answer,
				});
				const canonicalAnswer = inspectCanonicalMessage({
					message: answer,
					authorTranscript: responder.transcript.inspect(),
					deliveryEvidence: answerDelivery.deliveryEvidence,
				});
				if (canonicalAnswer.state !== "canonical") {
					return {
						requestMessageId: request.messageId,
						messageStatus: "unknown",
						reason: "inspection_incomplete",
					};
				}
				if (
					!answerDelivery.deliveryEvidence &&
					this.#deliveryScheduler.hasDispatchReservation(
						requester.identity.agentId,
						answer.messageId,
					)
				) {
					return {
						requestMessageId: request.messageId,
						messageStatus: "unknown",
						reason: "inspection_incomplete",
					};
				}
				return answerDelivery.deliveryEvidence
					? {
						disposition: "answer_already_delivered",
						requestMessageId: request.messageId,
						answerId: answer.messageId,
						deliveryEvidence: answerDelivery.deliveryEvidence,
					}
					: {
						disposition: "answer_delivered",
						requestMessageId: request.messageId,
						answerId: answer.messageId,
						fromAgentId: answer.fromAgentId,
						answer: answer.answer,
						answerSource: answer.source,
					};
			}
			if (requestDelivery.deliveryEvidence) {
				return {
					disposition: "request_delivered",
					requestMessageId: request.messageId,
					deliveryEvidence: requestDelivery.deliveryEvidence,
				};
			}
			if (this.#isShuttingDown()) {
				return {
					requestMessageId: request.messageId,
					messageStatus: "not_sent",
					reason: "host_shutting_down",
				};
			}
			const admission = await this.#deliveryScheduler.admitInLane(
				responder,
				this.#scheduleGeneralMessage(responder, request),
			);
			if (admission === "pending") {
				return this.#boundaryHooks.afterDeliveryAdmission?.({
					recipientAgentId: responder.identity.agentId,
					messageId: request.messageId,
					operation: "retry",
				}) === "confirmation_lost"
					? {
						requestMessageId: request.messageId,
						messageStatus: "unknown",
						reason: "confirmation_lost",
					}
					: {
						requestMessageId: request.messageId,
						messageStatus: "sent",
					};
			}
			return {
				requestMessageId: request.messageId,
				messageStatus: "not_sent",
				reason: admission,
			};
		});
	}

	async #poll(
		caller: AgentRecord,
		input: MessagePollInput,
	): Promise<AgentMessagePollReceipt> {
		const authorTranscript = caller.transcript.inspect();
		const message = this.#requestEvidence.requireCallerAuthoredMessage(
			caller,
			input.messageId,
		);
		const recipient = this.#requireAgent(message.targetAgentId);
		return recipient.host.lane.run(() => {
			if (
				this.#boundaryHooks.beforeRecipientInspection?.({
					recipientAgentId: recipient.identity.agentId,
					messageId: message.messageId,
					operation: "poll",
				}) === "inspection_incomplete"
			) {
				return {
					disposition: "indeterminate",
					messageId: message.messageId,
					reason: "inspection_incomplete",
				};
			}
			const delivery = inspectMessageDelivery({
				recipientAgentId: recipient.identity.agentId,
				transcript: recipient.transcript.inspect(),
				message,
			});
			const canonical = inspectCanonicalMessage({
				message,
				authorTranscript,
				deliveryEvidence: delivery.deliveryEvidence,
			});
			if (canonical.state === "not_created") {
				throw new Error(`unknown_identity: Message ${input.messageId} was not created`);
			}
			if (canonical.state === "indeterminate") {
				return {
					disposition: "indeterminate",
					messageId: message.messageId,
					reason: "inspection_incomplete",
				};
			}
			return delivery.deliveryEvidence
				? {
					disposition: "delivered",
					messageId: message.messageId,
					deliveryEvidence: delivery.deliveryEvidence,
				}
				: {
					disposition: "not_observed",
					messageId: message.messageId,
					inspectedThrough: delivery.inspectedThrough,
				};
		});
	}

	#scheduleGeneralMessage(
		recipient: AgentRecord,
		message: Message,
	): ScheduledMessageDelivery {
		return {
			messageId: message.messageId,
			deliveryMode: message.deliveryMode,
			deliveryItem: createMessageDeliveryItem(message),
			inspectProof: () => message.kind === "answer"
				? inspectAnswerDelivery({
					requesterAgentId: recipient.identity.agentId,
					transcript: recipient.transcript.inspect(),
					answer: message,
				}).deliveryEvidence
				: inspectMessageDelivery({
					recipientAgentId: recipient.identity.agentId,
					transcript: recipient.transcript.inspect(),
					message,
				}).deliveryEvidence,
			isSuppressed: message.kind === "request"
				? () => this.#isCancellationDelivered(message.messageId, recipient)
				: undefined,
			isIncomingRequest: message.kind === "request"
				? true
				: undefined,
			isIncomingRequestActive: message.kind === "request"
				? () => this.#requestEvidence.hasActiveRequest(recipient)
				: undefined,
			suppressesAfterCommitMessageId: message.kind === "request_cancellation"
				? message.requestId
				: undefined,
			afterCommit: message.kind === "request"
				? () => {
					if (
						this.#requestEvidence.findAnswer(message) === undefined &&
						!this.#isCancellationDelivered(message.messageId, recipient)
					) {
						recipient.host.addRetentionReason("answer_owed", message.messageId);
					}
				}
					: message.kind === "answer"
					? () => {
						recipient.host.removeRetentionReason(
							"awaiting_answer",
							message.requestId,
						);
						if (!this.#requestEvidence.isAnswerAwaitingAuthorResult(message)) {
							const responder = this.#requireAgent(message.fromAgentId);
							void responder.host.lane.run(async () => {
								responder.host.removeRetentionReason(
									"answer_owed",
									message.requestId,
								);
								await this.#deliveryScheduler.requestQueueAdvancedInLane(responder);
							});
						}
					}
					: message.kind === "request_cancellation"
						? () => {
							recipient.host.removeRetentionReason(
								"answer_owed",
								message.requestId,
							);
							const requester = this.#requireAgent(message.fromAgentId);
							void requester.host.lane.run(() =>
								requester.host.removeRetentionReason(
									"awaiting_answer",
									message.requestId,
								)
							);
						}
						: undefined,
		};
	}

	#reconcileCommittedAnswerAuthorship(responder: AgentRecord): boolean {
		const unresolved = new Set(this.answerObligationRequestIds(responder));
		let changed = false;
		for (const requestId of responder.host.requestRelationshipIds("answer_owed")) {
			if (unresolved.has(requestId)) continue;
			responder.host.removeRetentionReason("answer_owed", requestId);
			changed = true;
		}
		return changed;
	}

	#reconcileAnswerDeliveries(requester: AgentRecord): void {
		for (const request of this.#requestEvidence.findRequestsAuthoredBy(requester)) {
			const answer = this.#requestEvidence.findAnswer(request);
			if (!answer) continue;
			if (answer.targetAgentId !== requester.identity.agentId) continue;
			const delivery = inspectAnswerDelivery({
				requesterAgentId: requester.identity.agentId,
				transcript: requester.transcript.inspect(),
				answer,
			});
			if (delivery.deliveryEvidence) {
				requester.host.removeRetentionReason(
					"awaiting_answer",
					answer.requestId,
				);
			}
		}
	}

	#isCancellationDelivered(requestId: string, responder: AgentRecord): boolean {
		const request = this.#requestEvidence.requireRequest(requestId);
		const cancellation = this.#requestEvidence.findCancellation(request);
		return cancellation !== undefined &&
			inspectMessageDelivery({
				recipientAgentId: responder.identity.agentId,
				transcript: responder.transcript.inspect(),
				message: cancellation,
			}).deliveryEvidence !== undefined;
	}

	#requireAgent(agentId: string): AgentRecord {
		return requireAgentRecord(
			this.#agents,
			this.#quarantinedAgentIds,
			agentId,
		);
	}
}
