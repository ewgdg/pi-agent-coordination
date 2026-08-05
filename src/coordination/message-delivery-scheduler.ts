import { requireLiveSession, type AgentRecord } from "./agent-record.ts";
import { ProtocolInvariantError } from "../protocol/identities.ts";
import {
	createMessageDelivery,
	type EntryPointer,
	type MessageDeliveryItem,
} from "../protocol/message-delivery.ts";
import type { MessageDeliveryMode } from "../protocol/message.ts";
import type {
	AgentRunHandle,
	AgentRunSettlement,
} from "../runtime/in-process-agent-host.ts";

export type ScheduledMessageDelivery = Readonly<{
	messageId: string;
	deliveryMode: MessageDeliveryMode;
	deliveryItem: MessageDeliveryItem;
	inspectProof(): EntryPointer | undefined;
	isSuppressed?(): boolean;
	afterCommit?(): void;
}>;

export type ScheduleReleaseEvaluation = (
	context: Readonly<{ agentId: string; runSequence: number }>,
	evaluate: () => void,
) => void;

export type SteerFreezeHandler = (
	context: Readonly<{
		recipientAgentId: string;
		messageIds: readonly string[];
	}>,
) => void;

export const DEFAULT_PENDING_MESSAGE_LIMIT = 256;

export type MessageDeliveryAdmission =
	| "pending"
	| "target_unavailable"
	| "capacity_exhausted";

type ActiveDeferredDelivery = {
	delivery: ScheduledMessageDelivery;
	completion: Promise<void>;
	deliveryCommitted: boolean;
};

type FrozenSteerBatch = Readonly<{
	messageIds: readonly string[];
}>;

export class MessageDeliveryScheduler {
	readonly #pendingByAgent = new Map<string, Map<string, ScheduledMessageDelivery>>();
	readonly #activeDeferredByAgent = new Map<string, ActiveDeferredDelivery>();
	readonly #frozenSteerByAgent = new Map<string, FrozenSteerBatch>();
	readonly #integratedAgentIds = new Set<string>();
	readonly #scheduleReleaseEvaluationHook: ScheduleReleaseEvaluation | undefined;
	readonly #afterSteerFreeze: SteerFreezeHandler | undefined;
	readonly #pendingMessageLimit: number;

	constructor(options: {
		scheduleReleaseEvaluation?: ScheduleReleaseEvaluation;
		afterSteerFreeze?: SteerFreezeHandler;
		pendingMessageLimit?: number;
	}) {
		this.#scheduleReleaseEvaluationHook = options.scheduleReleaseEvaluation;
		this.#afterSteerFreeze = options.afterSteerFreeze;
		this.#pendingMessageLimit =
			options.pendingMessageLimit ?? DEFAULT_PENDING_MESSAGE_LIMIT;
		if (
			!Number.isSafeInteger(this.#pendingMessageLimit) ||
			this.#pendingMessageLimit <= 0
		) {
			throw new Error("pending Message limit must be a positive safe integer");
		}
	}

	admit(
		record: AgentRecord,
		delivery: ScheduledMessageDelivery,
	): Promise<MessageDeliveryAdmission> {
		return record.host.lane.run(() => this.admitInLane(record, delivery));
	}

	async admitInLane(
		record: AgentRecord,
		delivery: ScheduledMessageDelivery,
	): Promise<MessageDeliveryAdmission> {
		this.#ensureSettlementHandler(record);
		let pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending) {
			pending = new Map();
			this.#pendingByAgent.set(record.identity.agentId, pending);
		}
		if (pending.has(delivery.messageId)) return "pending";
		if (this.#countPendingIdentities(pending) >= this.#pendingMessageLimit) {
			return "capacity_exhausted";
		}
		if (!record.host.currentHandle()) {
			try {
				await record.host.startInLane(["pending_delivery"]);
			} catch (error) {
				if (pending.size === 0) this.#pendingByAgent.delete(record.identity.agentId);
				if (error instanceof ProtocolInvariantError) throw error;
				return "target_unavailable";
			}
		}
		pending.set(delivery.messageId, delivery);
		this.#addPendingDeliveryReason(record);
		this.#drainInLane(record);
		return "pending";
	}

	reachSafeBoundary(record: AgentRecord): Promise<void> {
		return record.host.lane.run(() => {
			if (!record.host.currentHandle()) return;
			this.#removeProvenDeliveriesInLane(record);
			this.#freezeSteerInLane(record);
		});
	}

	requestRelease(record: AgentRecord): Promise<"released" | "retained" | "stale"> {
		const handle = record.host.currentHandle();
		if (!handle) return Promise.resolve("stale");
		return record.host.lane.run(() => record.host.releaseIfEligibleInLane(handle));
	}

	discardInLane(record: AgentRecord): void {
		this.#activeDeferredByAgent.delete(record.identity.agentId);
		this.#frozenSteerByAgent.delete(record.identity.agentId);
		this.#pendingByAgent.delete(record.identity.agentId);
		record.host.removeRetentionReason("pending_delivery");
	}

	#countPendingIdentities(
		pending: ReadonlyMap<string, ScheduledMessageDelivery>,
	): number {
		let count = 0;
		for (const delivery of pending.values()) {
			if (!delivery.inspectProof() && !delivery.isSuppressed?.()) count += 1;
		}
		return count;
	}

	#ensureSettlementHandler(record: AgentRecord): void {
		if (this.#integratedAgentIds.has(record.identity.agentId)) return;
		record.host.setSettledHandler((handle, settlement) => {
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
		const active = this.#activeDeferredByAgent.get(record.identity.agentId);
		if (active) {
			let failed = false;
			try {
				await active.completion;
			} catch {
				failed = true;
			}
			if (!record.host.isCurrent(handle)) return;
			const proof = active.delivery.inspectProof();
			this.#activeDeferredByAgent.delete(record.identity.agentId);
			this.#pendingByAgent
				.get(record.identity.agentId)
				?.delete(active.delivery.messageId);
			if (proof && !active.deliveryCommitted) active.delivery.afterCommit?.();
			if (failed || !proof) {
				this.discardInLane(record);
				await record.host.discardAndEndInLane();
				return;
			}
		}

		this.#removeProvenDeliveriesInLane(record);
		if (settlement === "failed" || this.#hasUnprovenFrozenBatch(record)) {
			this.discardInLane(record);
			await record.host.discardAndEndInLane();
			return;
		}

		this.#drainInLane(record);
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

	#drainInLane(record: AgentRecord): void {
		this.#removeProvenDeliveriesInLane(record);
		if (
			this.#activeDeferredByAgent.has(record.identity.agentId) ||
			this.#hasUnprovenFrozenBatch(record)
		) {
			return;
		}
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending || pending.size === 0) return;
		const session = requireLiveSession(record);
		if (!session.isIdle) return;
		if ([...pending.values()].some(({ deliveryMode }) => deliveryMode === "steer")) {
			this.#freezeSteerInLane(record);
			return;
		}
		const delivery = pending.values().next().value as ScheduledMessageDelivery | undefined;
		if (!delivery) return;
		// A settled Run may become active before Pi processes admission. followUp
		// preserves Deferred ordering, while triggerTurn starts a standalone Idle turn.
		const completion = session.sendCustomMessage(
			createMessageDelivery([delivery.deliveryItem]),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		this.#activeDeferredByAgent.set(record.identity.agentId, {
			delivery,
			completion,
			deliveryCommitted: false,
		});
		record.host.trackOperation(completion);
	}

	#freezeSteerInLane(record: AgentRecord): void {
		if (this.#hasUnprovenFrozenBatch(record)) return;
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending) return;
		const steer = [...pending.values()].filter(
			({ deliveryMode }) => deliveryMode === "steer",
		);
		if (steer.length === 0) return;
		const messageIds = steer.map(({ messageId }) => messageId);
		this.#frozenSteerByAgent.set(record.identity.agentId, { messageIds });
		this.#afterSteerFreeze?.({
			recipientAgentId: record.identity.agentId,
			messageIds,
		});
		const completion = requireLiveSession(record).sendCustomMessage(
			createMessageDelivery(steer.map(({ deliveryItem }) => deliveryItem)),
			{ triggerTurn: true, deliverAs: "steer" },
		);
		record.host.trackOperation(completion);
	}

	#removeProvenDeliveriesInLane(record: AgentRecord): void {
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending) return;
		const active = this.#activeDeferredByAgent.get(record.identity.agentId);
		for (const [messageId, delivery] of pending) {
			const proof = delivery.inspectProof();
			const activeDelivery = active?.delivery.messageId === messageId;
			const suppressed = !proof && !activeDelivery && delivery.isSuppressed?.();
			if (!proof && !suppressed) continue;
			pending.delete(messageId);
			if (activeDelivery) {
				active.deliveryCommitted = true;
			}
			if (proof) delivery.afterCommit?.();
		}
		if (pending.size === 0) this.#pendingByAgent.delete(record.identity.agentId);
		const frozen = this.#frozenSteerByAgent.get(record.identity.agentId);
		if (frozen && frozen.messageIds.every((messageId) => !pending.has(messageId))) {
			this.#frozenSteerByAgent.delete(record.identity.agentId);
		}
		this.#removePendingDeliveryReason(record);
	}

	#hasUnprovenFrozenBatch(record: AgentRecord): boolean {
		const frozen = this.#frozenSteerByAgent.get(record.identity.agentId);
		if (!frozen) return false;
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		return frozen.messageIds.some((messageId) => pending?.has(messageId));
	}

	#hasPendingScheduling(record: AgentRecord): boolean {
		return this.#activeDeferredByAgent.has(record.identity.agentId) ||
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
