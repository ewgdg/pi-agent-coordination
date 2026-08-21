import {
	shouldCompact,
	type AgentSession,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

/** Owns turn preparation policy beside one exact child AgentSession generation. */
export class ChildTurnCompactionGateway {
	#disposed = false;
	#activeAdmissions = 0;
	#admissionTail: Promise<void> = Promise.resolve();
	#activeOwnerRunId: string | undefined;
	readonly #generationAbort = new AbortController();
	readonly #knownOwnerRunIds = new Set<string>();
	readonly #cancelledOwnerRunIds = new Set<string>();
	readonly #nativeAdmissions = new Map<number, () => void>();

	constructor(private readonly session: AgentSession) {}

	get signal(): AbortSignal {
		return this.#generationAbort.signal;
	}

	beforeCompaction(
		event: SessionBeforeCompactEvent,
	): { cancel: true } | undefined {
		if (this.#disposed || event.reason !== "threshold") return undefined;
		if (this.#activeAdmissions > 0 || this.session.agent.hasQueuedMessages()) {
			return undefined;
		}
		return { cancel: true };
	}

	admit<T>(operation: () => T | Promise<T>): Promise<T> {
		const result = this.#admissionTail.then(async () => {
			this.#assertCurrentGeneration();
			this.#activeAdmissions += 1;
			try {
				return await operation();
			} finally {
				this.#activeAdmissions -= 1;
			}
		});
		this.#admissionTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	admitOwnerTurn<T>(
		runId: string,
		operation: (checkpoint: () => void) => T | Promise<T>,
	): Promise<T> {
		this.#knownOwnerRunIds.add(runId);
		return this.admit(async () => {
			this.#assertOwnerRunCurrent(runId);
			this.#activeOwnerRunId = runId;
			try {
				const result = await operation(() => this.#assertOwnerRunCurrent(runId));
				this.#assertOwnerRunCurrent(runId);
				return result;
			} catch (error) {
				this.#assertOwnerRunCurrent(runId);
				throw error;
			} finally {
				if (this.#activeOwnerRunId === runId) this.#activeOwnerRunId = undefined;
			}
		});
	}

	cancelOwnerRun(runId: string): void {
		this.#cancelledOwnerRunIds.add(runId);
		if (this.#activeOwnerRunId === runId && this.session.isCompacting) {
			this.session.abortCompaction();
		}
	}

	hasOwnerRun(runId: string): boolean {
		return this.#knownOwnerRunIds.has(runId);
	}

	isOwnerRunCancelled(runId: string): boolean {
		return this.#cancelledOwnerRunIds.has(runId);
	}

	shouldDiscardActiveOwnerInput(): boolean {
		return this.#disposed ||
			(this.#activeOwnerRunId !== undefined &&
				this.#cancelledOwnerRunIds.has(this.#activeOwnerRunId));
	}

	completeOwnerRun(runId: string): void {
		this.#knownOwnerRunIds.delete(runId);
		this.#cancelledOwnerRunIds.delete(runId);
	}

	async reserveNativeTurn(submissionSequence: number): Promise<void> {
		if (this.#nativeAdmissions.has(submissionSequence)) {
			throw new Error(`child_native_turn_already_admitted: ${submissionSequence}`);
		}
		const release = await this.#reserveAdmission();
		this.#nativeAdmissions.set(submissionSequence, release);
	}

	completeNativeTurn(submissionSequence: number): void {
		const release = this.#nativeAdmissions.get(submissionSequence);
		if (!release) return;
		this.#nativeAdmissions.delete(submissionSequence);
		release();
	}

	async waitForCompaction(): Promise<void> {
		this.#assertCurrentGeneration();
		if (!this.session.isCompacting) return;
		await new Promise<void>((resolve, reject) => {
			let unsubscribe: () => void = () => undefined;
			const finish = (settlement: () => void) => {
				unsubscribe();
				this.#generationAbort.signal.removeEventListener("abort", abort);
				settlement();
			};
			const abort = () => finish(() => reject(
				new Error("child_turn_compaction_gateway_disposed"),
			));
			unsubscribe = this.session.subscribe((event) => {
				if (event.type === "compaction_end") finish(resolve);
			});
			this.#generationAbort.signal.addEventListener("abort", abort, { once: true });
			if (!this.session.isCompacting) finish(resolve);
		});
		this.#assertCurrentGeneration();
	}

	async prepareIdleCustomTurn(): Promise<void> {
		this.#assertCurrentGeneration();
		await this.waitForCompaction();
		if (!this.session.isIdle) return;
		const usage = this.session.getContextUsage();
		if (!usage || usage.tokens === null) return;
		const settings = this.session.settingsManager.getCompactionSettings();
		if (!shouldCompact(usage.tokens, usage.contextWindow, settings)) return;
		try {
			await this.session.compact();
		} catch (error) {
			// Threshold usage can be dominated by unsummarizable system/recent context.
			// Pi's native auto path treats the same public preparation result as no work.
			if (
				error instanceof Error &&
				(error.message === "Nothing to compact (session too small)" ||
					error.message === "Already compacted")
			) return;
			throw error;
		}
		this.#assertCurrentGeneration();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#generationAbort.abort();
		if (this.#activeAdmissions > 0 && this.session.isCompacting) {
			this.session.abortCompaction();
		}
		for (const release of this.#nativeAdmissions.values()) release();
		this.#nativeAdmissions.clear();
	}

	async #reserveAdmission(): Promise<() => void> {
		let releaseHold!: () => void;
		let resolveAcquired!: () => void;
		let rejectAcquired!: (error: unknown) => void;
		const acquired = new Promise<void>((resolve, reject) => {
			resolveAcquired = resolve;
			rejectAcquired = reject;
		});
		const hold = this.#admissionTail.then(() => {
			this.#assertCurrentGeneration();
			this.#activeAdmissions += 1;
			resolveAcquired();
			return new Promise<void>((resolve) => {
				let released = false;
				releaseHold = () => {
					if (released) return;
					released = true;
					this.#activeAdmissions -= 1;
					resolve();
				};
			});
		}).catch((error: unknown) => {
			rejectAcquired(error);
			throw error;
		});
		this.#admissionTail = hold.then(
			() => undefined,
			() => undefined,
		);
		await acquired;
		return () => releaseHold();
	}

	#assertOwnerRunCurrent(runId: string): void {
		this.#assertCurrentGeneration();
		if (this.#cancelledOwnerRunIds.has(runId)) {
			throw new Error(`child_turn_admission_cancelled: ${runId}`);
		}
	}

	#assertCurrentGeneration(): void {
		if (this.#disposed) {
			throw new Error("child_turn_compaction_gateway_disposed");
		}
	}
}
