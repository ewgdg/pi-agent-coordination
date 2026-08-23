import type {
	WorkflowPolicySnapshot,
	WorkflowPolicyStore,
} from "../policy/workflow-policy.ts";

export type AgentExecutionRole = "owner" | "child" | "moderator";

export type WorkflowExecutionPermit = Readonly<{
	release(): void;
}>;

const EXEMPT_EXECUTION_PERMIT: WorkflowExecutionPermit = Object.freeze({
	release() {},
});

type ChildExecutionWaiter = {
	policy: WorkflowPolicySnapshot;
	resolve(permit: WorkflowExecutionPermit | undefined): void;
	signal: AbortSignal | undefined;
	onAbort: (() => void) | undefined;
};

export class WorkflowExecutionScheduler {
	readonly #policy: WorkflowPolicyStore;
	readonly #childQueue: ChildExecutionWaiter[] = [];
	#activeChildExecutions = 0;

	constructor(policy: WorkflowPolicyStore) {
		this.#policy = policy;
	}

	admit(
		role: AgentExecutionRole,
		signal?: AbortSignal,
	): Promise<WorkflowExecutionPermit | undefined> {
		if (role === "owner" || role === "moderator") {
			return Promise.resolve(EXEMPT_EXECUTION_PERMIT);
		}
		if (signal?.aborted) return Promise.resolve(undefined);
		// A reload governs later admissions; queued work keeps its admission-time limit.
		const policy = this.#policy.current();

		return new Promise((resolve) => {
			const waiter: ChildExecutionWaiter = {
				policy,
				resolve,
				signal,
				onAbort: undefined,
			};
			if (signal) {
				waiter.onAbort = () => this.#removeAborted(waiter);
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.#childQueue.push(waiter);
			this.#drain();
		});
	}

	#drain(): void {
		while (this.#childQueue.length > 0) {
			const next = this.#childQueue[0];
			if (!next) return;
			if (
				this.#activeChildExecutions >=
				next.policy.maxConcurrentAgentRuns
			) {
				return;
			}
			this.#childQueue.shift();
			this.#removeAbortListener(next);
			this.#activeChildExecutions += 1;
			next.resolve(this.#childPermit());
		}
	}

	#childPermit(): WorkflowExecutionPermit {
		let released = false;
		return Object.freeze({
			release: () => {
				if (released) return;
				released = true;
				this.#activeChildExecutions -= 1;
				this.#drain();
			},
		});
	}

	#removeAborted(waiter: ChildExecutionWaiter): void {
		const index = this.#childQueue.indexOf(waiter);
		if (index < 0) return;
		this.#childQueue.splice(index, 1);
		this.#removeAbortListener(waiter);
		waiter.resolve(undefined);
		if (index === 0) this.#drain();
	}

	#removeAbortListener(waiter: ChildExecutionWaiter): void {
		if (!waiter.signal || !waiter.onAbort) return;
		waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.onAbort = undefined;
	}
}
