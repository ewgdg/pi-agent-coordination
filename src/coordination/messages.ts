import type { SessionManager } from "@earendil-works/pi-coding-agent";

import { requireLiveSession, type AgentRecord } from "./agent-record.ts";
import {
	MessageDeliveryScheduler,
	type ScheduledMessageDelivery,
	type ScheduleReleaseEvaluation,
	type SteerFreezeHandler,
} from "./message-delivery-scheduler.ts";
import {
	createMessageDeliveryItem,
	findAuthoredMessage,
	inspectCanonicalMessage,
	inspectMessageDelivery,
	resolveCommittedMessage,
	resolveCommittedAgentMessageInput,
	sameAgentMessageInput,
	type AgentMessageInput,
	type Message,
	type MessagePollInput,
	type MessageRetryInput,
} from "../protocol/message.ts";
import {
	createCreationRequestDeliveryItem,
	inspectCreationRequestDelivery,
} from "../protocol/creation-request.ts";
import type { ToolCallPointer } from "../protocol/identities.ts";

export type { AgentMessageInput } from "../protocol/message.ts";

export type AgentMessageSendReceipt =
	| Readonly<{
		messageId: string;
		delivery: "pending";
	}>
	| Readonly<{
		messageId: string;
		delivery: "indeterminate";
	}>
	| Readonly<{
		messageId: string;
		delivery: "rejected";
		rejectionReason:
			| "target_unavailable"
			| "host_shutting_down"
			| "capacity_exhausted";
	}>;

export type AgentMessagePollReceipt =
	| Readonly<{
		disposition: "delivered";
		messageId: string;
		deliveryEvidence: Readonly<{ agentId: string; entryId: string }>;
	}>
	| Readonly<{
		disposition: "not_observed";
		messageId: string;
		inspectedThrough: Readonly<{ agentId: string; entryId: string }>;
	}>
	| Readonly<{
		disposition: "indeterminate";
		messageId: string;
		reason: "inspection_incomplete";
	}>;

export type AgentMessageRetryReceipt =
	| Readonly<{
		disposition: "delivered";
		messageId: string;
		deliveryEvidence: Readonly<{ agentId: string; entryId: string }>;
	}>
	| Readonly<{
		disposition: "pending";
		messageId: string;
	}>
	| Readonly<{
		disposition: "rejected";
		messageId: string;
		rejectionReason:
			| "target_unavailable"
			| "host_shutting_down"
			| "evidence_unavailable"
			| "capacity_exhausted";
	}>
	| Readonly<{
		disposition: "indeterminate";
		messageId: string;
		reason: "confirmation_lost" | "inspection_incomplete";
	}>;

export type AgentMessageReceipt =
	| AgentMessageSendReceipt
	| AgentMessagePollReceipt
	| AgentMessageRetryReceipt;

export type MessageBoundaryHooks = Readonly<{
	beforeRecipientInspection?(context: Readonly<{
		recipientAgentId: string;
		messageId: string;
		operation: "poll" | "retry";
		sessionManager: SessionManager;
	}>): void | "inspection_incomplete";
	afterDeliveryAdmission?(context: Readonly<{
		recipientAgentId: string;
		messageId: string;
		operation: "send" | "retry";
	}>): void | "confirmation_lost";
	afterSteerFreeze?: SteerFreezeHandler;
	scheduleReleaseEvaluation?: ScheduleReleaseEvaluation;
}>;

export class MessageCoordinator {
	readonly #agents: Map<string, AgentRecord>;
	readonly #isShuttingDown: () => boolean;
	readonly #boundaryHooks: MessageBoundaryHooks;
	readonly #deliveryScheduler: MessageDeliveryScheduler;

	constructor(options: {
		agents: Map<string, AgentRecord>;
		isShuttingDown(): boolean;
		boundaryHooks?: MessageBoundaryHooks;
		pendingMessageLimit?: number;
	}) {
		this.#agents = options.agents;
		this.#isShuttingDown = options.isShuttingDown;
		this.#boundaryHooks = options.boundaryHooks ?? {};
		this.#deliveryScheduler = new MessageDeliveryScheduler({
			scheduleReleaseEvaluation: this.#boundaryHooks.scheduleReleaseEvaluation,
			afterSteerFreeze: this.#boundaryHooks.afterSteerFreeze,
			pendingMessageLimit: options.pendingMessageLimit,
		});
	}

	async send(
		callerAgentId: string,
		toolCallId: string,
		input: Extract<AgentMessageInput, { operation: "send" }>,
	): Promise<AgentMessageSendReceipt> {
		const sender = this.#requireAgent(callerAgentId);
		const senderSession = requireLiveSession(sender);
		const message = resolveCommittedMessage({
			fromAgentId: callerAgentId,
			workflowId: sender.identity.workflowId,
			sessionManager: senderSession.sessionManager,
			toolCallId,
			providedInput: input,
		});
		const recipient = this.#requireAgent(message.targetAgentId);
		if (recipient.identity.workflowId !== message.workflowId) {
			throw new Error("wrong_workflow: Message recipient is outside the sender Workflow");
		}
		if (this.#isShuttingDown()) {
			return {
				messageId: message.messageId,
				delivery: "rejected",
				rejectionReason: "host_shutting_down",
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
				? { messageId: message.messageId, delivery: "indeterminate" }
				: { messageId: message.messageId, delivery: "pending" };
		}
		return {
			messageId: message.messageId,
			delivery: "rejected",
			rejectionReason: admission,
		};
	}

	async admitCreationRequest(options: {
		recipient: AgentRecord;
		requestId: string;
		fromAgentId: string;
		question: string;
		source: ToolCallPointer;
	}): Promise<"pending" | "rejected"> {
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
					sessionManager: recipient.host.sessionManager,
					requestId,
					fromAgentId,
					question,
					source,
				}).deliveryEvidence,
			afterCommit: () => recipient.host.addRetentionReason("answer_owed"),
		};
		return (await this.#deliveryScheduler.admit(recipient, delivery)) === "pending"
			? "pending"
			: "rejected";
	}

	requestRelease(record: AgentRecord): Promise<"released" | "retained" | "stale"> {
		return this.#deliveryScheduler.requestRelease(record);
	}

	reachSafeBoundary(agentId: string): Promise<void> {
		if (this.#isShuttingDown()) return Promise.resolve();
		return this.#deliveryScheduler.reachSafeBoundary(this.#requireAgent(agentId));
	}

	discardSchedulingInLane(record: AgentRecord): void {
		this.#deliveryScheduler.discardInLane(record);
	}

	execute(
		callerAgentId: string,
		toolCallId: string,
		providedInput: AgentMessageInput,
	): Promise<AgentMessageReceipt> {
		const caller = this.#requireAgent(callerAgentId);
		const committedInput = resolveCommittedAgentMessageInput({
			agentId: callerAgentId,
			sessionManager: requireLiveSession(caller).sessionManager,
			toolCallId,
		});
		if (!sameAgentMessageInput(committedInput, providedInput)) {
			throw new Error("invariant_violation: executed Agent Message input differs from its source");
		}
		if (committedInput.operation === "send") {
			return this.send(callerAgentId, toolCallId, committedInput);
		}
		return committedInput.operation === "poll"
			? this.#poll(caller, committedInput)
			: this.#retry(caller, committedInput);
	}

	async #retry(
		caller: AgentRecord,
		input: MessageRetryInput,
	): Promise<AgentMessageRetryReceipt> {
		const authorSessionManager = requireLiveSession(caller).sessionManager;
		const message = this.#requireCallerAuthoredMessage(caller, input.messageId);
		const recipient = this.#requireAgent(message.targetAgentId);
		return recipient.host.lane.run(async () => {
			if (
				this.#boundaryHooks.beforeRecipientInspection?.({
					recipientAgentId: recipient.identity.agentId,
					messageId: message.messageId,
					operation: "retry",
					sessionManager: recipient.host.sessionManager,
				}) === "inspection_incomplete"
			) {
				return {
					disposition: "rejected",
					messageId: message.messageId,
					rejectionReason: "evidence_unavailable",
				};
			}
			const delivery = inspectMessageDelivery({
				recipientAgentId: recipient.identity.agentId,
				sessionManager: recipient.host.sessionManager,
				message,
			});
			const canonical = inspectCanonicalMessage({
				message,
				authorSessionManager,
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
			if (delivery.deliveryEvidence) {
				return {
					disposition: "delivered",
					messageId: message.messageId,
					deliveryEvidence: delivery.deliveryEvidence,
				};
			}
			if (this.#isShuttingDown()) {
				return {
					disposition: "rejected",
					messageId: message.messageId,
					rejectionReason: "host_shutting_down",
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
						disposition: "indeterminate",
						messageId: message.messageId,
						reason: "confirmation_lost",
					}
					: { disposition: "pending", messageId: message.messageId };
			}
			return {
				disposition: "rejected",
				messageId: message.messageId,
				rejectionReason: admission,
			};
		});
	}

	async #poll(
		caller: AgentRecord,
		input: MessagePollInput,
	): Promise<AgentMessagePollReceipt> {
		const authorSessionManager = requireLiveSession(caller).sessionManager;
		const message = this.#requireCallerAuthoredMessage(caller, input.messageId);
		const recipient = this.#requireAgent(message.targetAgentId);
		return recipient.host.lane.run(() => {
			if (
				this.#boundaryHooks.beforeRecipientInspection?.({
					recipientAgentId: recipient.identity.agentId,
					messageId: message.messageId,
					operation: "poll",
					sessionManager: recipient.host.sessionManager,
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
				sessionManager: recipient.host.sessionManager,
				message,
			});
			const canonical = inspectCanonicalMessage({
				message,
				authorSessionManager,
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
			inspectProof: () =>
				inspectMessageDelivery({
					recipientAgentId: recipient.identity.agentId,
					sessionManager: recipient.host.sessionManager,
					message,
				}).deliveryEvidence,
		};
	}

	#requireAgent(agentId: string): AgentRecord {
		const record = this.#agents.get(agentId);
		if (!record) throw new Error(`unknown_identity: ${agentId}`);
		return record;
	}

	#requireCallerAuthoredMessage(caller: AgentRecord, messageId: string): Message {
		const ownMessage = findAuthoredMessage({
			fromAgentId: caller.identity.agentId,
			workflowId: caller.identity.workflowId,
			sessionManager: caller.host.sessionManager,
			messageId,
		});
		if (ownMessage) return ownMessage;
		for (const candidateAuthor of this.#agents.values()) {
			if (candidateAuthor.identity.agentId === caller.identity.agentId) continue;
			const otherMessage = findAuthoredMessage({
				fromAgentId: candidateAuthor.identity.agentId,
				workflowId: candidateAuthor.identity.workflowId,
				sessionManager: candidateAuthor.host.sessionManager,
				messageId,
			});
			if (otherMessage) {
				throw new Error(
					`wrong_participant: Agent ${caller.identity.agentId} did not author Message ${messageId}`,
				);
			}
		}
		throw new Error(`unknown_identity: Message ${messageId}`);
	}
}
