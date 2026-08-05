import type {
	WorkflowPolicySnapshot,
	WorkflowPolicyStore,
} from "../policy/workflow-policy.ts";

export type AgentExecutionRole = "ordinary" | "moderator";

export type WorkflowExecutionPermit = Readonly<{
	release(): void;
}>;

type OrdinaryExecutionWaiter = {
	policy: WorkflowPolicySnapshot;
	resolve(permit: WorkflowExecutionPermit | undefined): void;
	signal: AbortSignal | undefined;
	onAbort: (() => void) | undefined;
};

export class WorkflowExecutionScheduler {
	readonly #policy: WorkflowPolicyStore;
	readonly #ordinaryQueue: OrdinaryExecutionWaiter[] = [];
	#activeOrdinaryExecutions = 0;

	constructor(policy: WorkflowPolicyStore) {
		this.#policy = policy;
	}

	admit(
		role: AgentExecutionRole,
		signal?: AbortSignal,
	): Promise<WorkflowExecutionPermit | undefined> {
		if (role === "moderator") {
			return Promise.resolve(Object.freeze({ release() {} }));
		}
		if (signal?.aborted) return Promise.resolve(undefined);
		// A reload governs later admissions; queued work keeps its admission-time limit.
		const policy = this.#policy.current();

		return new Promise((resolve) => {
			const waiter: OrdinaryExecutionWaiter = {
				policy,
				resolve,
				signal,
				onAbort: undefined,
			};
			if (signal) {
				waiter.onAbort = () => this.#removeAborted(waiter);
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.#ordinaryQueue.push(waiter);
			this.#drain();
		});
	}

	#drain(): void {
		while (this.#ordinaryQueue.length > 0) {
			const next = this.#ordinaryQueue[0];
			if (!next) return;
			if (
				this.#activeOrdinaryExecutions >=
				next.policy.maxConcurrentAgentRuns
			) {
				return;
			}
			this.#ordinaryQueue.shift();
			this.#removeAbortListener(next);
			this.#activeOrdinaryExecutions += 1;
			next.resolve(this.#ordinaryPermit());
		}
	}

	#ordinaryPermit(): WorkflowExecutionPermit {
		let released = false;
		return Object.freeze({
			release: () => {
				if (released) return;
				released = true;
				this.#activeOrdinaryExecutions -= 1;
				this.#drain();
			},
		});
	}

	#removeAborted(waiter: OrdinaryExecutionWaiter): void {
		const index = this.#ordinaryQueue.indexOf(waiter);
		if (index < 0) return;
		this.#ordinaryQueue.splice(index, 1);
		this.#removeAbortListener(waiter);
		waiter.resolve(undefined);
		if (index === 0) this.#drain();
	}

	#removeAbortListener(waiter: OrdinaryExecutionWaiter): void {
		if (!waiter.signal || !waiter.onAbort) return;
		waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.onAbort = undefined;
	}
}
