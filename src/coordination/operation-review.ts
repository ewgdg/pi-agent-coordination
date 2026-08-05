import {
	toolCallPointerKey,
	type ToolCallPointer,
} from "../protocol/identities.ts";

export type OperationReviewClock = Readonly<{
	schedule(delayMs: number, callback: () => void): () => void;
}>;

export const SYSTEM_OPERATION_REVIEW_CLOCK: OperationReviewClock = {
	schedule(delayMs, callback) {
		const timer = setTimeout(callback, delayMs);
		timer.unref();
		return () => clearTimeout(timer);
	},
};

export type OperationReviewSnapshot = Readonly<{
	toolCall: ToolCallPointer;
	reviewIntervalMs: number;
}>;

export type OperationReviewClassification = "blocking" | "asynchronous";

type ReviewableCall = {
	toolCall: ToolCallPointer;
	classification: OperationReviewClassification;
	policyIntervalMs: number;
	humanWaiting: boolean;
	moderatorInputCommitted: boolean;
	cancelTimer?: () => void;
	expired?: OperationReviewSnapshot;
};

export class OperationReviewWatcher {
	readonly #clock: OperationReviewClock;
	readonly #isUnresolved: (toolCall: ToolCallPointer) => boolean;
	readonly #hasAnswerObligation: (agentId: string) => boolean;
	readonly #onReviewStateChanged: () => void;
	readonly #calls = new Map<string, ReviewableCall>();
	readonly #attendanceByAgentId = new Map<string, "attended" | "idle">();

	constructor(options: {
		clock: OperationReviewClock;
		isUnresolved(toolCall: ToolCallPointer): boolean;
		hasAnswerObligation(agentId: string): boolean;
		onReviewStateChanged?(): void;
	}) {
		this.#clock = options.clock;
		this.#isUnresolved = options.isUnresolved;
		this.#hasAnswerObligation = options.hasAnswerObligation;
		this.#onReviewStateChanged = options.onReviewStateChanged ?? (() => undefined);
	}

	admit(options: {
		toolCall: ToolCallPointer;
		classification: OperationReviewClassification;
		policyIntervalMs: number;
	}): void {
		if (!Number.isSafeInteger(options.policyIntervalMs) || options.policyIntervalMs <= 0) {
			throw new Error("invariant_violation: Operation Review interval must be positive");
		}
		const key = toolCallPointerKey(options.toolCall);
		if (this.#calls.has(key)) {
			throw new Error("invariant_violation: root tool call is already under review");
		}
		const call: ReviewableCall = {
			...options,
			humanWaiting: false,
			moderatorInputCommitted: false,
		};
		this.#calls.set(key, call);
		this.#reconcile(call);
	}

	reconcileAgent(agentId: string): void {
		for (const call of this.#calls.values()) {
			if (call.toolCall.agentId === agentId) this.#reconcile(call);
		}
	}

	endRun(agentId: string): void {
		for (const call of [...this.#calls.values()]) {
			if (call.toolCall.agentId === agentId) this.#remove(call);
		}
		this.#attendanceByAgentId.delete(agentId);
	}

	setAgentAttendance(agentId: string, attendance: "attended" | "idle"): void {
		this.#attendanceByAgentId.set(agentId, attendance);
		for (const call of this.#calls.values()) {
			if (
				call.toolCall.agentId !== agentId ||
				call.classification !== "asynchronous"
			) continue;
			if (attendance === "attended" && call.expired === undefined) {
				this.#cancelInterval(call);
				continue;
			}
			this.#reconcile(call);
		}
	}

	beginHumanWaiting(toolCall: ToolCallPointer): void {
		const call = this.#calls.get(toolCallPointerKey(toolCall));
		if (!call) return;
		call.humanWaiting = true;
		this.#cancelInterval(call);
		if (!call.moderatorInputCommitted) this.#clearExpired(call);
	}

	markModeratorInputCommitted(toolCall: ToolCallPointer): void {
		const call = this.#calls.get(toolCallPointerKey(toolCall));
		if (!call?.expired) {
			throw new Error(
				"invariant_violation: committed Moderator Input requires an expired Operation Review",
			);
		}
		call.moderatorInputCommitted = true;
	}

	beginHumanResultCommit(toolCall: ToolCallPointer): void {
		const call = this.#calls.get(toolCallPointerKey(toolCall));
		if (!call) return;
		call.humanWaiting = false;
		this.#reconcile(call);
	}

	renew(toolCall: ToolCallPointer, nextReviewInMs: number): "renewed" | "stale" {
		if (!Number.isSafeInteger(nextReviewInMs) || nextReviewInMs <= 0) {
			throw new Error("invalid_input: renewal interval must be a positive integer");
		}
		const call = this.#calls.get(toolCallPointerKey(toolCall));
		if (!call) return "stale";
		if (nextReviewInMs > call.policyIntervalMs) {
			throw new Error(
				"invalid_input: renewal interval exceeds the captured Workflow Policy interval",
			);
		}
		if (!this.#isUnresolved(call.toolCall)) {
			this.#remove(call);
			return "stale";
		}
		if (
			!this.#hasAnswerObligation(call.toolCall.agentId)
		) {
			this.#remove(call);
			return "stale";
		}
		if (call.humanWaiting) {
			this.#cancelInterval(call);
			this.#clearExpired(call);
			return "stale";
		}
		this.#cancelInterval(call);
		this.#clearExpired(call);
		this.#startInterval(call, nextReviewInMs, false);
		return "renewed";
	}

	expiredReviews(): readonly OperationReviewSnapshot[] {
		return [...this.#calls.values()].flatMap((call) =>
			call.expired === undefined ? [] : [call.expired]
		);
	}

	hasUnresolvedAsynchronousCall(agentId: string): boolean {
		return [...this.#calls.values()].some(
			(call) =>
				call.toolCall.agentId === agentId &&
				call.classification === "asynchronous" &&
				this.#isUnresolved(call.toolCall),
		);
	}

	shutdown(): void {
		for (const call of this.#calls.values()) this.#cancelInterval(call);
		this.#calls.clear();
		this.#attendanceByAgentId.clear();
	}

	#reconcile(call: ReviewableCall): void {
		if (!this.#isUnresolved(call.toolCall)) {
			this.#remove(call);
			return;
		}
		if (!this.#hasAnswerObligation(call.toolCall.agentId)) {
			this.#remove(call);
			return;
		}
		if (call.humanWaiting) {
			this.#cancelInterval(call);
			this.#clearExpired(call);
			return;
		}
		const intervalApplies = call.classification === "blocking" ||
			this.#attendanceByAgentId.get(call.toolCall.agentId) === "idle";
		if (
			intervalApplies &&
			call.cancelTimer === undefined &&
			call.expired === undefined
		) {
			this.#startInterval(
				call,
				call.policyIntervalMs,
				call.classification === "asynchronous",
			);
		}
	}

	#startInterval(
		call: ReviewableCall,
		reviewIntervalMs: number,
		requiresUnattendedIdle: boolean,
	): void {
		call.moderatorInputCommitted = false;
		call.cancelTimer = this.#clock.schedule(reviewIntervalMs, () => {
			call.cancelTimer = undefined;
			if (!this.#isUnresolved(call.toolCall)) {
				this.#remove(call);
				return;
			}
			if (!this.#hasAnswerObligation(call.toolCall.agentId)) {
				this.#remove(call);
				return;
			}
			if (call.humanWaiting) return;
			if (
				requiresUnattendedIdle &&
				this.#attendanceByAgentId.get(call.toolCall.agentId) !== "idle"
			) return;
			call.expired = {
				toolCall: call.toolCall,
				reviewIntervalMs,
			};
			this.#onReviewStateChanged();
		});
	}

	#cancelInterval(call: ReviewableCall): void {
		call.cancelTimer?.();
		call.cancelTimer = undefined;
	}

	#remove(call: ReviewableCall): void {
		this.#cancelInterval(call);
		this.#calls.delete(toolCallPointerKey(call.toolCall));
		this.#clearExpired(call);
	}

	#clearExpired(call: ReviewableCall): void {
		if (call.expired === undefined) return;
		call.expired = undefined;
		call.moderatorInputCommitted = false;
		this.#onReviewStateChanged();
	}
}
