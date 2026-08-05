import type { OperationReviewClock } from "../../src/coordination/operation-review.ts";

export class ControllableOperationReviewClock implements OperationReviewClock {
	#now = 0;
	#sequence = 0;
	readonly #scheduled = new Map<number, Readonly<{
		at: number;
		callback(): void;
	}>>();

	schedule(delayMs: number, callback: () => void): () => void {
		const sequence = ++this.#sequence;
		this.#scheduled.set(sequence, {
			at: this.#now + delayMs,
			callback,
		});
		return () => {
			this.#scheduled.delete(sequence);
		};
	}

	advanceBy(durationMs: number): void {
		this.#now += durationMs;
		for (;;) {
			const next = [...this.#scheduled]
				.filter(([, scheduled]) => scheduled.at <= this.#now)
				.sort(
					([leftSequence, left], [rightSequence, right]) =>
						left.at - right.at || leftSequence - rightSequence,
				)[0];
			if (!next) return;
			this.#scheduled.delete(next[0]);
			next[1].callback();
		}
	}
}
