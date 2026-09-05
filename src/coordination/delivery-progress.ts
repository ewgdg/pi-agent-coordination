import type { OperationReviewClock } from "./operation-review.ts";

import type { DeliveryProgressStage, DeliveryBlockageReason } from "../protocol/moderator-input.ts";
export type { DeliveryProgressStage, DeliveryBlockageReason } from "../protocol/moderator-input.ts";

/** Volatile observation only: never dispatches, retries, or establishes Delivery proof. */
export class DeliveryProgress {
	readonly #clock: OperationReviewClock;
	readonly #changed: () => void;
	readonly intervalMs: number;
	#stage: DeliveryProgressStage = "eligible";
	#suspended = true;
	#cancelTimer?: () => void;
	#reason?: DeliveryBlockageReason;

	constructor(clock: OperationReviewClock, intervalMs: number, changed: () => void) {
		this.#clock = clock;
		this.intervalMs = intervalMs;
		this.#changed = changed;
	}

	advance(stage: DeliveryProgressStage): void {
		if (stage === this.#stage && !this.#reason) return;
		this.#stage = stage;
		this.#reason = undefined;
		this.#cancelTimer?.();
		this.#cancelTimer = undefined;
		this.#arm();
		this.#changed();
	}

	fail(error: unknown): void {
		this.#cancelTimer?.();
		this.#cancelTimer = undefined;
		this.#reason = {
			kind: "scheduling_failure",
			diagnostic: error instanceof Error ? error.message : String(error),
		};
		this.#changed();
	}

	observe(suspended: boolean): DeliveryBlockageReason | undefined {
		if (suspended !== this.#suspended) {
			this.#suspended = suspended;
			this.#cancelTimer?.();
			this.#cancelTimer = undefined;
			// A legitimate dependency wait ends this interval, but does not erase
			// a known lost continuation. That failure qualifies again after the wait.
			if (this.#reason?.kind === "progress_deadline") this.#reason = undefined;
			this.#arm();
		}
		return suspended ? undefined : this.#reason;
	}

	dispose(): void {
		this.#cancelTimer?.();
	}

	#arm(): void {
		if (this.#suspended || this.#reason || this.#cancelTimer) return;
		this.#cancelTimer = this.#clock.schedule(this.intervalMs, () => {
			this.#cancelTimer = undefined;
			this.#reason = { kind: "progress_deadline", stage: this.#stage, intervalMs: this.intervalMs };
			this.#changed();
		});
	}
}
