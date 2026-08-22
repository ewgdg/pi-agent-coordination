import {
	EvidenceUnavailableError,
	type AgentRecord,
} from "./agent-record.ts";
import { ProtocolInvariantError } from "../protocol/identities.ts";
import {
	createMessageDelivery,
	type EntryPointer,
	type MessageDeliveryItem,
} from "../protocol/message-delivery.ts";
import type { MessageDeliveryMode } from "../protocol/message.ts";
import type { ContextPreparation } from "../policy/working-zone-preparation.ts";
import type {
	AgentRunHandle,
	AgentRunSettlement,
	AgentRuntimeDelivery,
	InterruptionHoldHandle,
} from "../runtime/agent-runtime-host.ts";
import type { WorkflowPolicyStore } from "../policy/workflow-policy.ts";

type ScheduledDeliveryBase = Readonly<{
	messageId: string;
	deliveryMode: MessageDeliveryMode;
	inspectProof(): EntryPointer | undefined;
	isSuppressed?(): boolean;
	afterCommit?(): void;
	isIncomingRequest?: boolean;
	isIncomingRequestActive?(): boolean;
	suppressesAfterCommitMessageId?: string;
}>;

export type ScheduledMessageDelivery = ScheduledDeliveryBase & Readonly<{
	deliveryItem: MessageDeliveryItem;
	contextPreparation?: ContextPreparation;
}>;

export type ScheduledCustomDelivery = ScheduledDeliveryBase & Readonly<{
	deliveryMode: "deferred";
	customMessage: Extract<AgentRuntimeDelivery, { kind: "custom" }>["message"];
}>;

type ScheduledDelivery = ScheduledMessageDelivery | ScheduledCustomDelivery;

export type ScheduleReleaseEvaluation = (
	context: Readonly<{ agentId: string; runSequence: number }>,
	evaluate: () => void,
) => void;

export type SteerFreezeHandler = (
	context: Readonly<{
		recipientAgentId: string;
		messageIds: readonly string[];
		release(): Promise<void>;
	}>,
) => void | "defer";

export type ResumeReservationHandler = (
	context: Readonly<{
		recipientAgentId: string;
		messageId: string;
		release(): Promise<void>;
	}>,
) => void | "defer";

export type ScheduledDeliveryKind =
	| "message"
	| "request"
	| "answer"
	| "request_cancellation"
	| "custom";

export type ScheduleDeliveryDispatch = (
	context: Readonly<{
		recipientAgentId: string;
		messageId: string;
		kind: ScheduledDeliveryKind;
	}>,
	dispatch: () => void,
) => void;

export type MessageDeliveryAdmission =
	| "pending"
	| "target_unavailable"
	| "capacity_exhausted";

export type IncomingRequestWaitPreemptor = (
	record: AgentRecord,
	reserveDelivery: () => boolean,
) => Promise<void>;

type ActiveDeferredDelivery = {
	delivery: ScheduledDelivery;
	completion: Promise<void>;
	deliveryCommitted: boolean;
};

type ActiveWaitPreemption = ActiveDeferredDelivery;

type FrozenSteerBatch = {
	deliveries: readonly ScheduledMessageDelivery[];
	dispatched: boolean;
};

type ReservedResume = Readonly<{
	delivery: ScheduledMessageDelivery;
	hold: InterruptionHoldHandle;
}>;

type ActiveResume = ReservedResume & {
	completion: Promise<void>;
};

export class MessageDeliveryScheduler {
	readonly #pendingByAgent = new Map<string, Map<string, ScheduledDelivery>>();
	readonly #activeDeferredByAgent = new Map<string, ActiveDeferredDelivery>();
	readonly #activeWaitPreemptionByAgent = new Map<string, ActiveWaitPreemption>();
	readonly #frozenSteerByAgent = new Map<string, FrozenSteerBatch>();
	readonly #reservedResumeByAgent = new Map<string, ReservedResume>();
	readonly #activeResumeByAgent = new Map<string, ActiveResume>();
	readonly #deferredResumeByAgent = new Set<string>();
	readonly #integratedAgentIds = new Set<string>();
	readonly #scheduleReleaseEvaluationHook: ScheduleReleaseEvaluation | undefined;
	readonly #scheduleDeliveryDispatchHook: ScheduleDeliveryDispatch | undefined;
	readonly #afterSteerFreeze: SteerFreezeHandler | undefined;
	readonly #afterResumeReservation: ResumeReservationHandler | undefined;
	readonly #preemptAgentWait: IncomingRequestWaitPreemptor | undefined;
	readonly #workflowPolicy: WorkflowPolicyStore;

	constructor(options: {
		scheduleReleaseEvaluation?: ScheduleReleaseEvaluation;
		scheduleDeliveryDispatch?: ScheduleDeliveryDispatch;
		afterSteerFreeze?: SteerFreezeHandler;
		afterResumeReservation?: ResumeReservationHandler;
		preemptAgentWait?: IncomingRequestWaitPreemptor;
		workflowPolicy: WorkflowPolicyStore;
	}) {
		this.#scheduleReleaseEvaluationHook = options.scheduleReleaseEvaluation;
		this.#scheduleDeliveryDispatchHook = options.scheduleDeliveryDispatch;
		this.#afterSteerFreeze = options.afterSteerFreeze;
		this.#afterResumeReservation = options.afterResumeReservation;
		this.#preemptAgentWait = options.preemptAgentWait;
		this.#workflowPolicy = options.workflowPolicy;
	}

	integrate(record: AgentRecord): void {
		this.#ensureSettlementHandler(record);
	}

	admit(
		record: AgentRecord,
		delivery: ScheduledMessageDelivery,
	): Promise<MessageDeliveryAdmission> {
		return record.host.lane.run(() => this.admitInLane(record, delivery));
	}

	admitCustom(
		record: AgentRecord,
		delivery: ScheduledCustomDelivery,
	): Promise<MessageDeliveryAdmission> {
		return record.host.lane.run(() => this.#admitInLane(record, delivery));
	}

	admitInLane(
		record: AgentRecord,
		delivery: ScheduledMessageDelivery,
	): Promise<MessageDeliveryAdmission> {
		return this.#admitInLane(record, delivery);
	}

	async #admitInLane(
		record: AgentRecord,
		delivery: ScheduledDelivery,
	): Promise<MessageDeliveryAdmission> {
		this.#ensureSettlementHandler(record);
		let pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending) {
			pending = new Map();
			this.#pendingByAgent.set(record.identity.agentId, pending);
		}
		if (pending.has(delivery.messageId)) return "pending";
		const policy = this.#workflowPolicy.current();
		if (
			"deliveryItem" in delivery &&
			this.#countPendingIdentities(pending) >=
			policy.maxPendingDeliveriesPerAgent
		) {
			return "capacity_exhausted";
		}
		if (!record.host.currentHandle()) {
			try {
				await record.host.startInLane(["pending_delivery"]);
			} catch (error) {
				if (pending.size === 0) this.#pendingByAgent.delete(record.identity.agentId);
				if (
					error instanceof ProtocolInvariantError ||
					error instanceof EvidenceUnavailableError
				) throw error;
				return "target_unavailable";
			}
		}
		pending.set(delivery.messageId, delivery);
		this.#addPendingDeliveryReason(record);
		await this.#drainInLane(record);
		return "pending";
	}

	async admitResumeInLane(
		record: AgentRecord,
		delivery: ScheduledMessageDelivery,
		hold: InterruptionHoldHandle,
	): Promise<MessageDeliveryAdmission> {
		this.#ensureSettlementHandler(record);
		const agentId = record.identity.agentId;
		if (
			this.#reservedResumeByAgent.has(agentId) ||
			this.#activeResumeByAgent.has(agentId)
		) return "capacity_exhausted";
		if (!record.host.isCurrentInterruptionHold(hold)) return "target_unavailable";
		this.#reservedResumeByAgent.set(agentId, { delivery, hold });
		this.#addPendingDeliveryReason(record);
		const release = () => record.host.lane.run(async () => {
			const current = this.#reservedResumeByAgent.get(agentId);
			if (current?.delivery.messageId !== delivery.messageId) return;
			this.#deferredResumeByAgent.delete(agentId);
			await this.#drainInLane(record);
		});
		if (
			this.#afterResumeReservation?.({
				recipientAgentId: agentId,
				messageId: delivery.messageId,
				release,
			}) === "defer"
		) {
			this.#deferredResumeByAgent.add(agentId);
			return "pending";
		}
		await this.#drainInLane(record);
		return "pending";
	}

	reachSafeBoundary(record: AgentRecord): Promise<void> {
		return record.host.lane.run(() => {
			if (!record.host.currentHandle()) return;
			this.#removeProvenDeliveriesInLane(record);
			if (record.host.blocksOrdinaryDelivery()) return;
			this.#freezeSteerInLane(record);
		});
	}

	requestQueueAdvanced(record: AgentRecord): Promise<void> {
		return record.host.lane.run(() => this.#drainInLane(record));
	}

	requestQueueAdvancedInLane(record: AgentRecord): Promise<void> {
		return this.#drainInLane(record);
	}

	hasDispatchReservation(recipientAgentId: string, messageId: string): boolean {
		return this.#activeDeferredByAgent.get(recipientAgentId)?.delivery.messageId ===
			messageId ||
			this.#activeWaitPreemptionByAgent.get(recipientAgentId)?.delivery.messageId ===
				messageId ||
			this.#frozenSteerByAgent.get(recipientAgentId)?.deliveries.some(
				(delivery) => delivery.messageId === messageId,
			) === true ||
			this.#activeResumeByAgent.get(recipientAgentId)?.delivery.messageId === messageId;
	}

	prepareInterruptionInLane(record: AgentRecord): void {
		this.#frozenSteerByAgent.delete(record.identity.agentId);
	}

	requestRelease(record: AgentRecord): Promise<"released" | "retained" | "stale"> {
		return record.host.lane.run(() => {
			const handle = record.host.currentHandle();
			return handle
				? record.host.releaseIfEligibleInLane(handle)
				: record.host.releasePreparedRuntimeInLane();
		});
	}

	discardInLane(record: AgentRecord): void {
		this.#activeDeferredByAgent.delete(record.identity.agentId);
		this.#activeWaitPreemptionByAgent.delete(record.identity.agentId);
		this.#frozenSteerByAgent.delete(record.identity.agentId);
		this.#reservedResumeByAgent.delete(record.identity.agentId);
		this.#activeResumeByAgent.delete(record.identity.agentId);
		this.#deferredResumeByAgent.delete(record.identity.agentId);
		this.#pendingByAgent.delete(record.identity.agentId);
		record.host.removeRetentionReason("pending_delivery");
	}

	#countPendingIdentities(
		pending: ReadonlyMap<string, ScheduledDelivery>,
	): number {
		let count = 0;
		for (const delivery of pending.values()) {
			if (
				"deliveryItem" in delivery &&
				!delivery.inspectProof() &&
				!delivery.isSuppressed?.()
			) count += 1;
		}
		return count;
	}

	#ensureSettlementHandler(record: AgentRecord): void {
		if (this.#integratedAgentIds.has(record.identity.agentId)) return;
		record.host.addSettledHandler((handle, settlement) => {
			void record.host.lane.run(() => this.#settledInLane(record, handle, settlement));
		});
		this.#integratedAgentIds.add(record.identity.agentId);
	}

	#settledInLane(
		record: AgentRecord,
		handle: AgentRunHandle,
		settlement: AgentRunSettlement,
	): Promise<void> | void {
		if (!record.host.isCurrent(handle)) return;
		return this.#finishSettledInLane(record, handle, settlement);
	}

	async #finishSettledInLane(
		record: AgentRecord,
		handle: AgentRunHandle,
		settlement: AgentRunSettlement,
	): Promise<void> {
		const activeResume = this.#activeResumeByAgent.get(record.identity.agentId);
		if (activeResume) {
			let failed = false;
			try {
				await activeResume.completion;
			} catch {
				failed = true;
			}
			if (!record.host.isCurrent(handle)) return;
			const proof = activeResume.delivery.inspectProof();
			this.#activeResumeByAgent.delete(record.identity.agentId);
			record.host.finishIsolatedResumptionInLane(handle);
			if (failed || !proof) {
				this.discardInLane(record);
				await record.host.discardAndEndInLane("failure");
				return;
			}
		}
		for (const [activeByAgent, active] of [
			[this.#activeDeferredByAgent, this.#activeDeferredByAgent.get(record.identity.agentId)],
			[
				this.#activeWaitPreemptionByAgent,
				this.#activeWaitPreemptionByAgent.get(record.identity.agentId),
			],
		] as const) {
			if (!active) continue;
			let failed = false;
			try {
				await active.completion;
			} catch {
				failed = true;
			}
			if (!record.host.isCurrent(handle)) return;
			const proof = active.delivery.inspectProof();
			activeByAgent.delete(record.identity.agentId);
			this.#pendingByAgent
				.get(record.identity.agentId)
				?.delete(active.delivery.messageId);
			if (proof && !active.deliveryCommitted) active.delivery.afterCommit?.();
			if (failed || !proof) {
				this.discardInLane(record);
				await record.host.discardAndEndInLane("failure");
				return;
			}
		}

		this.#removeProvenDeliveriesInLane(record);
		if (settlement === "failed" || this.#hasUnprovenFrozenBatch(record)) {
			this.discardInLane(record);
			await record.host.discardAndEndInLane("failure");
			return;
		}

		record.host.finishIsolatedResumptionInLane(handle);
		await this.#drainInLane(record);
		if (!this.#hasPendingScheduling(record)) {
			this.#removePendingDeliveryReason(record);
			this.#scheduleReleaseEvaluation(record, handle);
		}
	}

	#scheduleReleaseEvaluation(record: AgentRecord, handle: AgentRunHandle): void {
		const evaluate = () => {
			void record.host.lane.run(() => record.host.releaseIfEligibleInLane(handle));
		};
		if (this.#scheduleReleaseEvaluationHook) {
			this.#scheduleReleaseEvaluationHook(
				{ agentId: record.identity.agentId, runSequence: handle.sequence },
				evaluate,
			);
			return;
		}
		evaluate();
	}

	async #drainInLane(
		record: AgentRecord,
		bypassDeliveryDispatchHook = false,
	): Promise<void> {
		this.#removeProvenDeliveriesInLane(record);
		if (this.#activeResumeByAgent.has(record.identity.agentId)) return;
		const reservedResume = this.#reservedResumeByAgent.get(record.identity.agentId);
		if (reservedResume) {
			if (this.#deferredResumeByAgent.has(record.identity.agentId)) return;
			if (record.host.isCurrentInterruptionHold(reservedResume.hold)) {
				if (record.host.currentWorkState() === "settled") {
					await this.#startResumeInLane(record, reservedResume);
				}
				return;
			}
			this.#reservedResumeByAgent.delete(record.identity.agentId);
			let pending = this.#pendingByAgent.get(record.identity.agentId);
			if (!pending) {
				pending = new Map();
				this.#pendingByAgent.set(record.identity.agentId, pending);
			}
			pending.set(reservedResume.delivery.messageId, reservedResume.delivery);
		}
		if (record.host.blocksOrdinaryDelivery()) return;
		if (this.#activeWaitPreemptionByAgent.has(record.identity.agentId)) return;
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending || pending.size === 0) return;
		const eligible = this.#eligibleDeliveries(pending);
		const incomingRequest = eligible.find(
			(delivery) => delivery.isIncomingRequest,
		);
		const run = record.host.observe();
		if ("attention" in run && run.attention === "agent_wait") {
			if (incomingRequest && this.#preemptAgentWait) {
				void this.#preemptAgentWait(record, () =>
					this.#reservePreemptingRequestInLane(record, incomingRequest)
				);
			}
			// Only an eligible inbound Request may acquire a parked Wait. Ordinary
			// Deferred and Steer Messages remain queued regardless of host work-state
			// projection; Steer Message preemption is a separate protocol decision.
			return;
		}
		if (
			this.#activeDeferredByAgent.has(record.identity.agentId) ||
			this.#hasUnprovenFrozenBatch(record)
		) return;
		if (record.host.currentWorkState() !== "settled") return;
		const steer = this.#eligibleSteerDeliveries(eligible);
		const selected = steer.length > 0 ? steer : eligible.slice(0, 1);
		const delivery = selected[0];
		if (!delivery) return;
		if (!bypassDeliveryDispatchHook && this.#scheduleDeliveryDispatchHook) {
			this.#scheduleDeliveryDispatchHook(
				{
					recipientAgentId: record.identity.agentId,
					messageId: delivery.messageId,
					kind: scheduledDeliveryKind(delivery),
				},
				() => {
					void record.host.lane.run(() =>
						this.#continueDeliveryDispatchInLane(record, selected)
					);
				},
			);
			return;
		}
		if (steer.length > 0) {
			this.#freezeSteerInLane(record, steer);
			return;
		}
		// A settled Run may become active before Pi processes admission. followUp
		// preserves Deferred ordering, while triggerTurn starts a standalone Idle turn.
		const { completion } = record.host.deliverInLane(
			"customMessage" in delivery
				? {
					kind: "custom",
					message: delivery.customMessage,
					triggerTurn: true,
					deliverAs: "followUp",
				}
				: createRuntimeMessageDelivery([delivery], "followUp"),
		);
		this.#activeDeferredByAgent.set(record.identity.agentId, {
			delivery,
			completion,
			deliveryCommitted: false,
		});
	}

	#reservePreemptingRequestInLane(
		record: AgentRecord,
		delivery: ScheduledDelivery,
	): boolean {
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (
			!pending ||
			pending.get(delivery.messageId) !== delivery ||
			!this.#eligibleDeliveries(pending).includes(delivery) ||
			this.#activeWaitPreemptionByAgent.has(record.identity.agentId)
		) return false;
		const { completion } = record.host.deliverInLane(
			"customMessage" in delivery
				? {
					kind: "custom",
					message: delivery.customMessage,
					triggerTurn: true,
					deliverAs: "steer",
				}
				: createRuntimeMessageDelivery([delivery], "steer"),
		);
		this.#activeWaitPreemptionByAgent.set(record.identity.agentId, {
			delivery,
			completion,
			deliveryCommitted: false,
		});
		return true;
	}

	#continueDeliveryDispatchInLane(
		record: AgentRecord,
		selected: readonly ScheduledDelivery[],
	): Promise<void> {
		this.#removeProvenDeliveriesInLane(record);
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending) return this.#drainInLane(record);
		const eligible = this.#eligibleDeliveries(pending);
		const steer = this.#eligibleSteerDeliveries(eligible);
		const current = steer.length > 0 ? steer : eligible.slice(0, 1);
		const stillSelected = current.length === selected.length &&
			current.every((delivery, index) => delivery === selected[index]);
		return this.#drainInLane(record, stillSelected);
	}

	async #startResumeInLane(record: AgentRecord, reserved: ReservedResume): Promise<void> {
		if (!record.host.beginIsolatedResumptionInLane(reserved.hold)) return;
		try {
			const delivery = record.host.deliverInLane(
				createRuntimeMessageDelivery([reserved.delivery]),
				{ inspectCommit: () => reserved.delivery.inspectProof() !== undefined },
			);
			this.#activeResumeByAgent.set(record.identity.agentId, {
				...reserved,
				completion: delivery.completion,
			});
			const committed = await delivery.transcriptCommit;
			if (!committed) {
				throw new Error("Supervisory Resume Delivery did not commit");
			}
			if (!record.host.commitIsolatedResumptionInLane(reserved.hold)) {
				throw new Error("invariant_violation: committed resume Delivery lost its exact Hold");
			}
			this.#reservedResumeByAgent.delete(record.identity.agentId);
			reserved.delivery.afterCommit?.();
		} catch (error) {
			this.#cancelResumeAttemptInLane(record, reserved);
			throw error;
		}
	}

	#cancelResumeAttemptInLane(record: AgentRecord, reserved: ReservedResume): void {
		record.host.cancelIsolatedResumptionInLane(reserved.hold);
		this.#activeResumeByAgent.delete(record.identity.agentId);
		this.#reservedResumeByAgent.delete(record.identity.agentId);
		this.#deferredResumeByAgent.delete(record.identity.agentId);
		this.#removePendingDeliveryReason(record);
	}

	#freezeSteerInLane(
		record: AgentRecord,
		steer: readonly ScheduledMessageDelivery[] = [],
	): void {
		if (this.#hasUnprovenFrozenBatch(record)) return;
		if (steer.length === 0) {
			const pending = this.#pendingByAgent.get(record.identity.agentId);
			if (!pending) return;
			steer = this.#eligibleSteerDeliveries(this.#eligibleDeliveries(pending));
		}
		if (steer.length === 0) return;
		const frozen: FrozenSteerBatch = { deliveries: steer, dispatched: false };
		this.#frozenSteerByAgent.set(record.identity.agentId, frozen);
		const release = () => record.host.lane.run(() =>
			this.#dispatchFrozenSteerInLane(record, frozen)
		);
		if (
			this.#afterSteerFreeze?.({
				recipientAgentId: record.identity.agentId,
				messageIds: steer.map(({ messageId }) => messageId),
				release,
			}) === "defer"
		) return;
		this.#dispatchFrozenSteerInLane(record, frozen);
	}

	#dispatchFrozenSteerInLane(
		record: AgentRecord,
		frozen: FrozenSteerBatch,
	): void {
		if (
			this.#frozenSteerByAgent.get(record.identity.agentId) !== frozen ||
			frozen.dispatched
		) return;
		// Retrieval can commit at the freeze boundary. Revalidate before handing the
		// immutable batch to Pi, where an individual queued Delivery cannot be recalled.
		this.#removeProvenDeliveriesInLane(record);
		if (this.#frozenSteerByAgent.get(record.identity.agentId) !== frozen) return;
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		const unprovenSteer = frozen.deliveries.filter(
			(delivery) => pending?.get(delivery.messageId) === delivery,
		);
		if (unprovenSteer.length === 0) return;
		frozen.dispatched = true;
		record.host.deliverInLane(
			createRuntimeMessageDelivery(unprovenSteer, "steer"),
		);
	}

	#removeProvenDeliveriesInLane(record: AgentRecord): void {
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending) return;
		const active = this.#activeDeferredByAgent.get(record.identity.agentId);
		const preemption = this.#activeWaitPreemptionByAgent.get(
			record.identity.agentId,
		);
		for (const [messageId, delivery] of pending) {
			const proof = delivery.inspectProof();
			const activeDelivery = active?.delivery.messageId === messageId;
			const preemptingDelivery = preemption?.delivery.messageId === messageId;
			const suppressed =
				!proof && !activeDelivery && !preemptingDelivery && delivery.isSuppressed?.();
			if (!proof && !suppressed) continue;
			pending.delete(messageId);
			if (activeDelivery) active.deliveryCommitted = true;
			if (preemptingDelivery) preemption.deliveryCommitted = true;
			if (proof) delivery.afterCommit?.();
		}
		if (pending.size === 0) this.#pendingByAgent.delete(record.identity.agentId);
		const frozen = this.#frozenSteerByAgent.get(record.identity.agentId);
		if (
			frozen &&
			frozen.deliveries.every(({ messageId }) => !pending.has(messageId))
		) this.#frozenSteerByAgent.delete(record.identity.agentId);
		this.#removePendingDeliveryReason(record);
	}

	#eligibleDeliveries(
		pending: ReadonlyMap<string, ScheduledDelivery>,
	): ScheduledDelivery[] {
		const deliveries = [...pending.values()];
		// Only the oldest waiting Request may compete for Delivery. Other Message
		// kinds remain eligible so one unresolved Request cannot block coordination.
		const frontRequest = deliveries.find(
			({ isIncomingRequest }) => isIncomingRequest,
		);
		const requestIsActive = frontRequest?.isIncomingRequestActive?.() ?? false;
		return deliveries.filter((delivery) =>
			!delivery.isIncomingRequest ||
			(!requestIsActive && delivery === frontRequest)
		);
	}

	#eligibleSteerDeliveries(
		eligible: readonly ScheduledDelivery[],
	): ScheduledMessageDelivery[] {
		const steer = eligible.filter(
			(delivery): delivery is ScheduledMessageDelivery =>
				delivery.deliveryMode === "steer" && "deliveryItem" in delivery,
		);
		const suppressedAfterBatch = new Set(
			steer.flatMap(({ suppressesAfterCommitMessageId }) =>
				suppressesAfterCommitMessageId
					? [suppressesAfterCommitMessageId]
					: []
			),
		);
		// Deliver a Cancellation before its still-waiting Request. Batching both
		// would wake the responder with work that the same batch withdraws.
		return steer.filter(({ messageId }) => !suppressedAfterBatch.has(messageId));
	}

	#hasUnprovenFrozenBatch(record: AgentRecord): boolean {
		const frozen = this.#frozenSteerByAgent.get(record.identity.agentId);
		if (!frozen) return false;
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		return frozen.deliveries.some(({ messageId }) => pending?.has(messageId));
	}

	#hasPendingScheduling(record: AgentRecord): boolean {
		return this.#activeDeferredByAgent.has(record.identity.agentId) ||
			this.#activeWaitPreemptionByAgent.has(record.identity.agentId) ||
			this.#reservedResumeByAgent.has(record.identity.agentId) ||
			this.#activeResumeByAgent.has(record.identity.agentId) ||
			this.#hasUnprovenFrozenBatch(record) ||
			(this.#pendingByAgent.get(record.identity.agentId)?.size ?? 0) > 0;
	}

	#addPendingDeliveryReason(record: AgentRecord): void {
		record.host.addRetentionReason("pending_delivery");
	}

	#removePendingDeliveryReason(record: AgentRecord): void {
		if (this.#hasPendingScheduling(record)) return;
		record.host.removeRetentionReason("pending_delivery");
	}
}

function createRuntimeMessageDelivery(
	deliveries: readonly ScheduledMessageDelivery[],
	deliverAs?: "steer" | "followUp",
): Extract<AgentRuntimeDelivery, { kind: "custom" }> {
	const preparedRequest = deliveries.find((delivery) =>
		delivery.contextPreparation !== undefined &&
		delivery.deliveryItem.projection.kind === "request"
	);
	return {
		kind: "custom",
		message: createMessageDelivery(deliveries.map(({ deliveryItem }) => deliveryItem)),
		triggerTurn: true,
		...(deliverAs === undefined ? {} : { deliverAs }),
		...(preparedRequest?.contextPreparation !== undefined &&
			preparedRequest.deliveryItem.projection.kind === "request"
			? {
				workingZonePreparation: {
					intent: preparedRequest.contextPreparation,
					prospectiveRequest: preparedRequest.deliveryItem.projection,
				},
			}
			: {}),
	};
}

function scheduledDeliveryKind(delivery: ScheduledDelivery): ScheduledDeliveryKind {
	return "deliveryItem" in delivery
		? delivery.deliveryItem.projection.kind
		: "custom";
}
