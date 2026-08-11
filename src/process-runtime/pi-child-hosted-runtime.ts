import type {
	AgentRuntimeDelivery,
	AgentRuntimeDeliveryDispatch,
	AgentRuntimeWorkState,
	EffectiveRuntimeSnapshot,
	ToolBatchClassification,
	TranscriptCommitConfirmation,
} from "../runtime/agent-runtime-host.ts";
import type {
	HostedAgentRuntime,
	HostedRuntimeEvent,
} from "../runtime/hosted-agent-runtime.ts";
import type { HostedAgentProjection } from "../runtime/hosted-agent-projection.ts";
import { createPiChildProcessProjection } from "./pi-child-process-projection.ts";
import {
	type PiChildProcessLaunch,
	type PiChildProcessRuntime,
	type PiChildRuntimeEvent,
} from "./pi-child-process-runtime.ts";

type SettlementWaiter = {
	started: boolean;
	settled: boolean;
	readonly result: Promise<void>;
	resolve(): void;
	reject(error: unknown): void;
};

/** Adapt one pending/admitted real Pi child to the common Runtime supervisor. */
export class PiChildHostedRuntime implements HostedAgentRuntime {
	readonly projection: HostedAgentProjection;
	readonly ready: Promise<void>;
	readonly #launch: PiChildProcessLaunch;
	readonly #admitted: Promise<PiChildProcessRuntime>;
	readonly #handlers = new Set<(event: HostedRuntimeEvent) => void>();
	readonly #settlementWaiters = new Set<SettlementWaiter>();
	readonly #removeEventHandler: () => void;
	#removeChannelCloseHandler: () => void = () => undefined;
	#snapshot: EffectiveRuntimeSnapshot | undefined;
	#toolExecutionModes = new Map<string, "sequential" | "parallel">();
	#workState: AgentRuntimeWorkState = "settled";
	#queuedInputCount = 0;
	#currentRunId: string | undefined;
	#latestRunId: string | undefined;
	#runSequence = 0;
	#runObserved = false;
	#cancellation = new AbortController();
	#unavailable: unknown;
	#shutdownExpected = false;
	#disposePromise: Promise<void> | undefined;

	constructor(launch: PiChildProcessLaunch) {
		this.#launch = launch;
		const projection = createPiChildProcessProjection(launch);
		this.projection = Object.freeze({
			...projection,
			dispose: () => {
				this.#shutdownExpected = true;
				return projection.dispose();
			},
		});
		this.#removeEventHandler = launch.onEvent((event) => this.#handleEvent(event));
		this.#admitted = launch.ready();
		this.ready = this.#admitted.then((runtime) => {
			this.#toolExecutionModes = new Map(
				runtime.snapshot.toolExecutionModes.map(({ name, executionMode }) => [
					name,
					executionMode,
				]),
			);
			this.#snapshot = {
				cwd: runtime.snapshot.cwd,
				model: runtime.snapshot.model,
				thinking: runtime.snapshot.thinking,
				tools: [...runtime.snapshot.tools],
				skills: [...runtime.snapshot.skills],
				fileExtensionPaths: [...runtime.snapshot.extensions],
				projectTrusted: runtime.snapshot.projectTrusted,
				sessionId: runtime.snapshot.sessionId,
			};
			this.#removeChannelCloseHandler = runtime.channel.onClose((cause) => {
				if (this.#shutdownExpected) return;
				this.#fail(cause ?? new Error("child_runtime_channel_closed"));
			});
		});
		void this.ready.catch((error: unknown) => this.#fail(error));
		void launch.exited.then(
			(exit) => {
				if (this.#shutdownExpected) return;
				this.#fail(new Error(
					`child_runtime_unexpected_exit: code ${exit.exitCode} signal ${exit.signal}`,
				));
			},
			(error: unknown) => this.#fail(error),
		);
	}

	snapshot(): EffectiveRuntimeSnapshot {
		if (!this.#snapshot) {
			throw new Error("child_runtime_not_admitted: effective snapshot is unavailable");
		}
		return this.#snapshot;
	}

	workState(): AgentRuntimeWorkState {
		return this.#workState;
	}

	queuedInputCount(): number {
		return this.#queuedInputCount;
	}

	classifyToolBatch(toolNames: readonly string[]): ToolBatchClassification {
		for (const toolName of toolNames) {
			const executionMode = this.#toolExecutionModes.get(toolName);
			if (!executionMode) {
				throw new Error(`invariant_violation: tool definition ${toolName} is unavailable`);
			}
			if (executionMode === "sequential") return "blocking";
		}
		return "asynchronous";
	}

	cancellationSignal(): AbortSignal {
		return this.#cancellation.signal;
	}

	deliver(
		delivery: AgentRuntimeDelivery,
		confirmation?: TranscriptCommitConfirmation,
	): AgentRuntimeDeliveryDispatch {
		const runId = this.#requireOrCreateRunId();
		const settlement = this.#waitForSettlement();
		const response = this.#admitted.then((runtime) =>
			runtime.channel.request("message.deliver", {
				runId,
				delivery: serializeDelivery(delivery),
			})
		).then((result) => {
			this.#updateQueuedInputCount(result.queuedInputCount);
			if (!result.modelCycleStarted) {
				if (this.#currentRunId === runId) this.#currentRunId = undefined;
				settlement.resolve();
			}
			return result;
		});
		const completion = Promise.all([
			response.then(({ accepted }) => {
				if (!accepted) throw new Error("child_runtime_delivery_rejected");
			}),
			settlement.result,
		]).then(() => undefined);
		void completion.catch((error: unknown) => settlement.reject(error));
		if (!confirmation) return { completion };
		const transcriptCommit = response.then((result) =>
			result.transcriptCommitted && confirmation.inspectCommit()
		);
		return { completion, transcriptCommit };
	}

	continueFromCommittedInput(): Promise<void> {
		const runId = this.#requireOrCreateRunId();
		const settlement = this.#waitForSettlement();
		const request = this.#admitted.then((runtime) =>
			runtime.channel.request("run.continue", { runId })
		).then(({ accepted }) => {
			if (!accepted) throw new Error("child_runtime_continuation_rejected");
		});
		void request.catch((error: unknown) => settlement.reject(error));
		return Promise.all([request, settlement.result]).then(() => undefined);
	}

	subscribe(handler: (event: HostedRuntimeEvent) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	async clearQueue(): Promise<Readonly<{ steering: string[]; followUp: string[] }>> {
		const runId = this.#requireLatestRunId();
		const result = await this.#admitted.then((runtime) =>
			runtime.channel.request("queue.clear", { runId })
		);
		this.#updateQueuedInputCount(result.queuedInputCount);
		return { steering: result.steering, followUp: result.followUp };
	}

	async abort(): Promise<void> {
		const runId = this.#requireLatestRunId();
		await this.#admitted.then((runtime) =>
			runtime.channel.request("run.interrupt", { runId })
		);
	}

	waitForIdle(): Promise<void> {
		if (this.#workState === "settled") return Promise.resolve();
		return this.#waitForSettlement().result;
	}

	dispose(): Promise<void> {
		this.#disposePromise ??= (async () => {
			this.#shutdownExpected = true;
			try {
				await this.#launch.dispose();
			} finally {
				this.#removeChannelCloseHandler();
				this.#removeEventHandler();
				this.#handlers.clear();
			}
		})();
		return this.#disposePromise;
	}

	#handleEvent(event: PiChildRuntimeEvent): void {
		if (event.event === "runtime.fault") {
			this.#fail(new Error(
				`child_runtime_fault: ${event.payload.code}: ${event.payload.message}`,
			));
			return;
		}
		if (
			event.event !== "agent.start" &&
			event.event !== "agent.end" &&
			event.event !== "agent.settled"
		) return;
		if (!this.#acceptsLifecycleEvent(event)) return;
		this.#updateQueuedInputCount(event.payload.queuedInputCount);
		if (event.event === "agent.start") {
			if (this.#cancellation.signal.aborted) this.#cancellation = new AbortController();
			this.#workState = "active";
			for (const waiter of this.#settlementWaiters) waiter.started = true;
			this.#emit({ type: "state_changed" });
			return;
		}
		if (event.event === "agent.end") {
			if (event.payload.outcome === "interrupted") this.#cancellation.abort();
			this.#emit({
				type: "agent_end",
				outcome: event.payload.outcome === "completed"
					? "completed"
					: event.payload.outcome === "interrupted"
						? "aborted"
						: "error",
				willRetry: event.payload.willRetry,
			});
			return;
		}
		this.#workState = "settled";
		this.#currentRunId = undefined;
		for (const waiter of [...this.#settlementWaiters]) {
			if (waiter.started) waiter.resolve();
		}
		this.#emit({ type: "state_changed" });
		this.#emit({ type: "agent_settled" });
	}

	#acceptsLifecycleEvent(
		event: Extract<PiChildRuntimeEvent, { event: "agent.start" | "agent.end" | "agent.settled" }>,
	): boolean {
		const runId = event.payload.runId;
		if (this.#currentRunId === runId) return true;
		if (event.event === "agent.start" && this.#currentRunId === undefined) {
			// An authenticated child may begin a native interactive or extension-local
			// model cycle only after its awaited executionBegin request admitted the
			// Owner-side Run. Adopt that child-generated transport identity here.
			this.#currentRunId = runId;
			this.#latestRunId = runId;
			this.#runObserved = true;
			return true;
		}
		this.#fail(new Error(
			`stale_run: child lifecycle ${runId} does not match ${String(this.#currentRunId)}`,
		));
		return false;
	}

	#requireOrCreateRunId(): string {
		if (this.#unavailable) throw this.#unavailable;
		if (this.#currentRunId) return this.#currentRunId;
		this.#runSequence += 1;
		this.#runObserved = true;
		this.#currentRunId = `hosted-run-${this.#runSequence}`;
		this.#latestRunId = this.#currentRunId;
		return this.#currentRunId;
	}

	#requireLatestRunId(): string {
		if (this.#unavailable) throw this.#unavailable;
		if (!this.#latestRunId) {
			throw new Error("child_runtime_run_unavailable: no Run has been admitted");
		}
		return this.#latestRunId;
	}

	#waitForSettlement(): SettlementWaiter {
		let settle!: () => void;
		let fail!: (error: unknown) => void;
		const waiter: SettlementWaiter = {
			started: this.#workState === "active",
			settled: false,
			result: new Promise<void>((resolve, reject) => {
				settle = resolve;
				fail = reject;
			}),
			resolve: () => {
				if (waiter.settled) return;
				waiter.settled = true;
				this.#settlementWaiters.delete(waiter);
				settle();
			},
			reject: (error) => {
				if (waiter.settled) return;
				waiter.settled = true;
				this.#settlementWaiters.delete(waiter);
				fail(error);
			},
		};
		this.#settlementWaiters.add(waiter);
		if (this.#unavailable) waiter.reject(this.#unavailable);
		return waiter;
	}

	#updateQueuedInputCount(count: number): void {
		if (this.#queuedInputCount === count) return;
		this.#queuedInputCount = count;
		this.#emit({ type: "state_changed" });
	}

	#fail(error: unknown): void {
		if (this.#unavailable) return;
		const terminalRun = this.#runObserved;
		this.#unavailable = error;
		this.#cancellation.abort();
		this.#workState = "unavailable";
		this.#currentRunId = undefined;
		for (const waiter of [...this.#settlementWaiters]) waiter.reject(error);
		if (terminalRun) {
			this.#emit({ type: "agent_end", outcome: "error", willRetry: false });
		}
		this.#emit({ type: "state_changed" });
		if (terminalRun) this.#emit({ type: "agent_settled" });
	}

	#emit(event: HostedRuntimeEvent): void {
		for (const handler of this.#handlers) handler(event);
	}
}

function serializeDelivery(delivery: AgentRuntimeDelivery) {
	if (delivery.kind === "user") {
		return {
			kind: delivery.kind,
			content: typeof delivery.content === "string"
				? delivery.content
				: delivery.content.map((part) => ({ ...part })),
			...(delivery.deliverAs === undefined ? {} : { deliverAs: delivery.deliverAs }),
		};
	}
	return {
		kind: delivery.kind,
		message: {
			...delivery.message,
			details: {
				messages: delivery.message.details.messages.map((pointer) => ({ ...pointer })),
			},
		},
		triggerTurn: delivery.triggerTurn,
		...(delivery.deliverAs === undefined ? {} : { deliverAs: delivery.deliverAs }),
	};
}
