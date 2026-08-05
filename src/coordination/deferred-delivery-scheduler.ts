import { requireLiveSession, type AgentRecord } from "./agent-record.ts";
import type { createDeferredMessageDelivery } from "../protocol/deferred-message.ts";
import type { createCreationRequestDelivery } from "../protocol/creation-request.ts";
import { ProtocolInvariantError } from "../protocol/identities.ts";
import type { EntryPointer } from "../protocol/message-delivery.ts";
import type {
	AgentRunHandle,
	AgentRunSettlement,
} from "../runtime/in-process-agent-host.ts";

export type ScheduledDeferredDelivery = Readonly<{
	messageId: string;
	customMessage:
		| ReturnType<typeof createDeferredMessageDelivery>
		| ReturnType<typeof createCreationRequestDelivery>;
	inspectProof(): EntryPointer | undefined;
	afterCommit?(): void;
}>;

export type ScheduleReleaseEvaluation = (
	context: Readonly<{ agentId: string; runSequence: number }>,
	evaluate: () => void,
) => void;

type ActiveDeferredDelivery = Readonly<{
	delivery: ScheduledDeferredDelivery;
	completion: Promise<void>;
}>;

export class DeferredDeliveryScheduler {
	readonly #pendingByAgent = new Map<string, Map<string, ScheduledDeferredDelivery>>();
	readonly #activeByAgent = new Map<string, ActiveDeferredDelivery>();
	readonly #integratedAgentIds = new Set<string>();
	readonly #scheduleReleaseEvaluationHook: ScheduleReleaseEvaluation | undefined;

	constructor(options: {
		scheduleReleaseEvaluation?: ScheduleReleaseEvaluation;
	}) {
		this.#scheduleReleaseEvaluationHook = options.scheduleReleaseEvaluation;
	}

	admit(
		record: AgentRecord,
		delivery: ScheduledDeferredDelivery,
	): Promise<"pending" | "rejected"> {
		return record.host.lane.run(() => this.admitInLane(record, delivery));
	}

	async admitInLane(
		record: AgentRecord,
		delivery: ScheduledDeferredDelivery,
	): Promise<"pending" | "rejected"> {
		this.#ensureSettlementHandler(record);
		let pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending) {
			pending = new Map();
			this.#pendingByAgent.set(record.identity.agentId, pending);
		}
		if (
			pending.has(delivery.messageId) ||
			this.#activeByAgent.get(record.identity.agentId)?.delivery.messageId ===
				delivery.messageId
		) {
			return "pending";
		}
		if (!record.host.currentHandle()) {
			try {
				await record.host.startInLane(["pending_delivery"]);
			} catch (error) {
				if (pending.size === 0) this.#pendingByAgent.delete(record.identity.agentId);
				if (error instanceof ProtocolInvariantError) throw error;
				return "rejected";
			}
		}
		pending.set(delivery.messageId, delivery);
		this.#addPendingDeliveryReason(record);
		this.#drainInLane(record);
		return "pending";
	}

	requestRelease(record: AgentRecord): Promise<"released" | "retained" | "stale"> {
		const handle = record.host.currentHandle();
		if (!handle) return Promise.resolve("stale");
		return record.host.lane.run(() => record.host.releaseIfEligibleInLane(handle));
	}

	discardInLane(record: AgentRecord): void {
		this.#activeByAgent.delete(record.identity.agentId);
		this.#pendingByAgent.delete(record.identity.agentId);
		record.host.removeRetentionReason("pending_delivery");
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
		const active = this.#activeByAgent.get(record.identity.agentId);
		if (active) {
			let failed = false;
			try {
				await active.completion;
			} catch {
				failed = true;
			}
			if (!record.host.isCurrent(handle)) return;
			const proof = active.delivery.inspectProof();
			this.#activeByAgent.delete(record.identity.agentId);
			this.#pendingByAgent
				.get(record.identity.agentId)
				?.delete(active.delivery.messageId);
			if (proof) active.delivery.afterCommit?.();
			if (failed && !proof) {
				this.discardInLane(record);
				await record.host.discardAndEndInLane();
				return;
			}
			if (!proof) {
				this.discardInLane(record);
				await record.host.discardAndEndInLane();
				return;
			}
		}
		if (settlement === "failed") {
			this.discardInLane(record);
			await record.host.discardAndEndInLane();
			return;
		}
		this.#drainInLane(record);
		if (
			!this.#activeByAgent.has(record.identity.agentId) &&
			(this.#pendingByAgent.get(record.identity.agentId)?.size ?? 0) === 0
		) {
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
		if (this.#activeByAgent.has(record.identity.agentId)) return;
		const pending = this.#pendingByAgent.get(record.identity.agentId);
		if (!pending || pending.size === 0) return;
		const session = requireLiveSession(record);
		if (!session.isIdle) return;
		for (const [messageId, delivery] of pending) {
			const proof = delivery.inspectProof();
			if (proof) {
				pending.delete(messageId);
				delivery.afterCommit?.();
				continue;
			}
			// A settled Run may become active before Pi processes admission. followUp
			// preserves Deferred ordering, while triggerTurn starts a standalone Idle turn.
			const completion = session.sendCustomMessage(delivery.customMessage, {
				triggerTurn: true,
				deliverAs: "followUp",
			});
			this.#activeByAgent.set(record.identity.agentId, { delivery, completion });
			record.host.trackOperation(completion);
			return;
		}
		if (pending.size === 0) this.#pendingByAgent.delete(record.identity.agentId);
		this.#removePendingDeliveryReason(record);
	}

	#addPendingDeliveryReason(record: AgentRecord): void {
		record.host.addRetentionReason("pending_delivery");
	}

	#removePendingDeliveryReason(record: AgentRecord): void {
		if (
			(this.#pendingByAgent.get(record.identity.agentId)?.size ?? 0) > 0 ||
			this.#activeByAgent.has(record.identity.agentId)
		) {
			return;
		}
		record.host.removeRetentionReason("pending_delivery");
	}
}
