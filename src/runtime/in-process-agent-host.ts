import type {
	AgentSession,
	AgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import { SerialLane } from "./serial-lane.ts";

export type RunRetentionReason =
	| "owner_host_binding"
	| "pending_delivery"
	| "awaiting_answer"
	| "answer_owed"
	| "interactive_selection"
	| "interruption_hold"
	| "moderator_handling";

export type RunRetention = Readonly<{
	reason: RunRetentionReason;
	count: number;
}>;

type RequestRelationshipReason = "awaiting_answer" | "answer_owed";

export type LiveRunState = Readonly<{
	phase: "starting" | "live" | "ending";
	work?: "active" | "settled";
	attention: "none" | "input_required";
	retentionReasons: readonly RunRetention[];
}>;

export type DormantRunState = Readonly<{
	phase: "dormant";
	retentionReasons: readonly [];
}>;

export type AgentRunState = LiveRunState | DormantRunState;
export type AgentRunHandle = Readonly<{ sequence: number }>;
export type InterruptionHoldHandle = Readonly<{
	run: AgentRunHandle;
	sequence: number;
}>;

type BoundRun = {
	handle: AgentRunHandle;
	session: AgentSession;
	unsubscribe: () => void;
	failed: boolean;
};

type HeldNativeQueue = {
	handle: AgentRunHandle;
	steering: string[];
	followUp: string[];
};

type StartSession = () => Promise<AgentSession>;
export type AgentRunSettlement = "settled" | "failed";
type SettledHandler = (handle: AgentRunHandle, settlement: AgentRunSettlement) => void;
export type AgentRunEndCause = "clean" | "failure" | "termination" | "shutdown";
type EndedHandler = (handle: AgentRunHandle, cause: AgentRunEndCause) => void;
type StateChangeHandler = () => void;
type RunFenceHandler = (handle: AgentRunHandle) => void;
export type ResidualRequestRelationships = Readonly<{
	awaitingAnswerRequestIds: readonly string[];
	answerOwedRequestIds: readonly string[];
}>;
type RunStartInitializer = () => ResidualRequestRelationships;

export class InProcessAgentHost {
	readonly lane = new SerialLane();
	readonly sessionManager: SessionManager;
	readonly #startSession: StartSession | undefined;
	readonly #retentionReasons = new Set<RunRetentionReason>();
	readonly #requestRelationships = new Map<
		RequestRelationshipReason,
		Set<string>
	>();
	readonly #trackedOperations = new Set<Promise<void>>();
	#run: BoundRun | undefined;
	#starting = false;
	#ending = false;
	#interrupting = false;
	#runSequence = 0;
	#holdSequence = 0;
	readonly #settledHandlers = new Set<SettledHandler>();
	readonly #endedHandlers = new Set<EndedHandler>();
	readonly #stateChangeHandlers = new Set<StateChangeHandler>();
	#runFenceHandler: RunFenceHandler | undefined;
	#runStartInitializer: RunStartInitializer | undefined;
	#inputRequired: { handle: AgentRunHandle; requestId: string } | undefined;
	#interruptionHold: InterruptionHoldHandle | undefined;
	#isolatedResumption:
		| Readonly<{ handle: AgentRunHandle; hold: InterruptionHoldHandle }>
		| undefined;
	#heldNativeQueue: HeldNativeQueue | undefined;

	private constructor(options: {
		sessionManager: SessionManager;
		startSession?: StartSession;
		initialSession?: AgentSession;
		initialRetentionReasons?: readonly RunRetentionReason[];
	}) {
		this.sessionManager = options.sessionManager;
		this.#startSession = options.startSession;
		for (const reason of options.initialRetentionReasons ?? []) {
			this.#retentionReasons.add(reason);
		}
		if (options.initialSession) this.#bindRun(options.initialSession);
	}

	static bindOwner(runtime: AgentSessionRuntime): InProcessAgentHost {
		return new InProcessAgentHost({
			sessionManager: runtime.session.sessionManager,
			initialSession: runtime.session,
			initialRetentionReasons: ["owner_host_binding"],
		});
	}

	static createChild(options: {
		sessionManager: SessionManager;
		startSession: StartSession;
	}): InProcessAgentHost {
		return new InProcessAgentHost(options);
	}

	observe(): AgentRunState {
		const retentionReasons = [
			...[...this.#retentionReasons].map((reason) => ({ reason, count: 1 })),
			...[...this.#requestRelationships].map(([reason, requestIds]) => ({
				reason,
				count: requestIds.size,
			})),
			...(this.#interruptionHold ? [{ reason: "interruption_hold" as const, count: 1 }] : []),
		];
		if (this.#starting) {
			return {
				phase: "starting",
				attention: "none",
				retentionReasons,
			};
		}
		const run = this.#run;
		if (!run) return { phase: "dormant", retentionReasons: [] };
		return {
			phase: this.#ending ? "ending" : "live",
			work: run.session.isIdle ? "settled" : "active",
			attention: this.#inputRequired?.handle === run.handle
				? "input_required"
				: "none",
			retentionReasons,
		};
	}

	addSettledHandler(handler: SettledHandler): () => void {
		this.#settledHandlers.add(handler);
		return () => this.#settledHandlers.delete(handler);
	}

	addEndedHandler(handler: EndedHandler): () => void {
		this.#endedHandlers.add(handler);
		return () => this.#endedHandlers.delete(handler);
	}

	addStateChangeHandler(handler: StateChangeHandler): () => void {
		this.#stateChangeHandlers.add(handler);
		return () => this.#stateChangeHandlers.delete(handler);
	}

	setRunFenceHandler(handler: RunFenceHandler): void {
		this.#runFenceHandler = handler;
	}

	setRunStartInitializer(initializer: RunStartInitializer): void {
		this.#runStartInitializer = initializer;
	}

	initializeBoundRunRelationships(): void {
		if (!this.#run || this.#starting || this.#ending) {
			throw new Error("invariant_violation: Request relationships require a bound Agent Run");
		}
		this.#initializeRequestRelationships();
	}

	currentHandle(): AgentRunHandle | undefined {
		return this.#run?.handle;
	}

	latestStartedRunSequence(): number {
		return this.#runSequence;
	}

	currentRunFailed(): boolean {
		return this.#run?.failed ?? false;
	}

	isCurrent(handle: AgentRunHandle): boolean {
		return this.#run?.handle === handle;
	}

	blocksOrdinaryDelivery(): boolean {
		return this.#interruptionHold !== undefined || this.#isolatedResumption !== undefined;
	}

	isInterrupting(): boolean {
		return this.#interrupting;
	}

	currentInterruptionHold(): InterruptionHoldHandle | undefined {
		return this.#interruptionHold;
	}

	isCurrentInterruptionHold(hold: InterruptionHoldHandle): boolean {
		return this.#interruptionHold === hold && this.#run?.handle === hold.run;
	}

	beginIsolatedResumptionInLane(hold: InterruptionHoldHandle): boolean {
		if (!this.isCurrentInterruptionHold(hold) || this.#isolatedResumption) return false;
		this.#isolatedResumption = { handle: hold.run, hold };
		return true;
	}

	commitIsolatedResumptionInLane(hold: InterruptionHoldHandle): boolean {
		if (
			!this.isCurrentInterruptionHold(hold) ||
			this.#isolatedResumption?.hold !== hold
		) return false;
		this.#interruptionHold = undefined;
		this.#notifyStateChanged();
		return true;
	}

	cancelIsolatedResumptionInLane(hold: InterruptionHoldHandle): void {
		if (this.#isolatedResumption?.hold === hold) this.#isolatedResumption = undefined;
	}

	finishIsolatedResumptionInLane(handle: AgentRunHandle): void {
		if (this.#isolatedResumption?.handle === handle) this.#isolatedResumption = undefined;
	}

	async interruptCurrentRunInLane(): Promise<
		"held" | "already_held" | "not_running"
	> {
		const run = this.#run;
		if (!run || this.#starting || this.#ending || run.failed) return "not_running";
		if (this.#interruptionHold?.run === run.handle) return "already_held";
		this.#isolatedResumption = undefined;
		this.#interrupting = true;
		try {
			const cleared = run.session.clearQueue();
			if (
				cleared.steering.length > 0 ||
				cleared.followUp.length > 0 ||
				this.#heldNativeQueue?.handle === run.handle
			) {
				const existing = this.#heldNativeQueue?.handle === run.handle
					? this.#heldNativeQueue
					: { handle: run.handle, steering: [], followUp: [] };
				existing.steering.push(...cleared.steering);
				existing.followUp.push(...cleared.followUp);
				this.#heldNativeQueue = existing;
			}
			await run.session.abort();
			if (this.#run !== run || this.#ending || run.failed || !run.session.isIdle) {
				return "not_running";
			}
			this.#holdSequence += 1;
			this.#interruptionHold = {
				run: run.handle,
				sequence: this.#holdSequence,
			};
			this.#notifyStateChanged();
			return "held";
		} finally {
			this.#interrupting = false;
		}
	}

	beginInputRequired(handle: AgentRunHandle, requestId: string): void {
		const run = this.#run;
		if (
			!run ||
			run.handle !== handle ||
			this.#starting ||
			this.#ending ||
			run.failed
		) {
			throw new Error("stale_run: Human Request does not target the current Agent Run");
		}
		if (requestId.length === 0) {
			throw new Error("invariant_violation: Human Request identity must not be empty");
		}
		if (this.#inputRequired) {
			throw new Error("invalid_input: Agent Run already has an unresolved Human Request");
		}
		this.#inputRequired = { handle, requestId };
		this.#notifyStateChanged();
	}

	acceptsInputRequired(handle: AgentRunHandle, requestId: string): boolean {
		const run = this.#run;
		return run?.handle === handle &&
			!this.#starting &&
			!this.#ending &&
			!run.failed &&
			this.#inputRequired?.handle === handle &&
			this.#inputRequired.requestId === requestId;
	}

	failExactRun(handle: AgentRunHandle): void {
		const run = this.#run;
		if (!run || run.handle !== handle || this.#ending) return;
		this.#markRunFailed(run, handle);
		this.trackOperation(run.session.abort());
	}

	endInputRequired(handle: AgentRunHandle, requestId: string): void {
		const inputRequired = this.#inputRequired;
		if (!inputRequired) return;
		if (inputRequired.handle !== handle || inputRequired.requestId !== requestId) {
			throw new Error("invariant_violation: Human Request does not match input-required attention");
		}
		this.#inputRequired = undefined;
		this.#notifyStateChanged();
	}

	requireLiveSession(): AgentSession {
		const session = this.#run?.session;
		if (!session) throw new Error(`Agent Run is unavailable: ${this.sessionManager.getSessionId()}`);
		return session;
	}

	async startInLane(
		initialRetentionReasons: readonly RunRetentionReason[] = [],
	): Promise<AgentSession> {
		if (this.#run) return this.#run.session;
		if (!this.#startSession) {
			throw new Error(`Agent Run cannot restart: ${this.sessionManager.getSessionId()}`);
		}
		this.#starting = true;
		for (const reason of initialRetentionReasons) this.#retentionReasons.add(reason);
		this.#notifyStateChanged();
		try {
			this.#initializeRequestRelationships();
			const session = await this.#startSession();
			this.#bindRun(session);
			return session;
		} catch (error) {
			this.#clearRunScopedState();
			throw error;
		} finally {
			this.#starting = false;
			this.#notifyStateChanged();
		}
	}

	#initializeRequestRelationships(): void {
		this.#requestRelationships.clear();
		const relationships = this.#runStartInitializer?.();
		if (!relationships) return;
		for (const requestId of relationships.awaitingAnswerRequestIds) {
			this.addRetentionReason("awaiting_answer", requestId);
		}
		for (const requestId of relationships.answerOwedRequestIds) {
			this.addRetentionReason("answer_owed", requestId);
		}
	}

	addRetentionReason(reason: RunRetentionReason, requestId?: string): void {
		if (!this.#run && !this.#starting) return;
		if (isRequestRelationshipReason(reason)) {
			const exactRequestId = requireRequestRelationshipId(reason, requestId);
			let relationships = this.#requestRelationships.get(reason);
			if (!relationships) {
				relationships = new Set();
				this.#requestRelationships.set(reason, relationships);
			}
			if (relationships.has(exactRequestId)) return;
			relationships.add(exactRequestId);
			this.#notifyStateChanged();
			return;
		}
		if (this.#retentionReasons.has(reason)) return;
		this.#retentionReasons.add(reason);
		this.#notifyStateChanged();
	}

	removeRetentionReason(reason: RunRetentionReason, requestId?: string): void {
		if (isRequestRelationshipReason(reason)) {
			const exactRequestId = requireRequestRelationshipId(reason, requestId);
			const relationships = this.#requestRelationships.get(reason);
			if (!relationships?.delete(exactRequestId)) return;
			if (relationships?.size === 0) this.#requestRelationships.delete(reason);
			this.#notifyStateChanged();
			return;
		}
		if (this.#retentionReasons.delete(reason)) this.#notifyStateChanged();
	}

	hasRetentionReason(reason: RunRetentionReason, requestId?: string): boolean {
		if (isRequestRelationshipReason(reason)) {
			const relationships = this.#requestRelationships.get(reason);
			return requestId === undefined
				? (relationships?.size ?? 0) > 0
				: relationships?.has(requestId) ?? false;
		}
		if (reason === "interruption_hold") {
			return this.#interruptionHold !== undefined;
		}
		return this.#retentionReasons.has(reason);
	}

	requestRelationshipIds(
		reason: RequestRelationshipReason,
	): readonly string[] {
		return [...(this.#requestRelationships.get(reason) ?? [])];
	}

	residualRequestCounts(): Readonly<{ incoming: number; outgoing: number }> {
		return {
			incoming: this.#requestRelationships.get("answer_owed")?.size ?? 0,
			outgoing: this.#requestRelationships.get("awaiting_answer")?.size ?? 0,
		};
	}

	trackOperation(operation: Promise<unknown>): void {
		const tracked = operation.then(
			() => undefined,
			() => undefined,
		);
		this.#trackedOperations.add(tracked);
		void tracked.finally(() => this.#trackedOperations.delete(tracked));
	}

	releaseIfEligibleInLane(handle: AgentRunHandle): "released" | "retained" | "stale" {
		const run = this.#run;
		if (!run || run.handle !== handle) return "stale";
		if (this.#starting || this.#ending || !run.session.isIdle) return "retained";
		if (
			this.#retentionReasons.size > 0 ||
			this.#requestRelationships.size > 0 ||
			this.#inputRequired !== undefined ||
			this.#interruptionHold !== undefined
		) {
			return "retained";
		}
		this.#ending = true;
		this.#notifyStateChanged();
		try {
			run.unsubscribe();
			run.session.dispose();
			this.#run = undefined;
			this.#clearRunScopedState();
			this.#notifyStateChanged();
			this.#notifyEnded(run.handle, "clean");
			return "released";
		} finally {
			this.#ending = false;
		}
	}

	async discardAndEndInLane(
		cause: Exclude<AgentRunEndCause, "clean">,
		disposeRun?: (session: AgentSession) => Promise<void>,
	): Promise<void> {
		const run = this.#run;
		if (!run) {
			this.#clearRunScopedState();
			return;
		}
		const cleanupErrors: unknown[] = [];
		const attemptCleanup = async (cleanup: () => unknown | Promise<unknown>) => {
			try {
				await cleanup();
			} catch (error) {
				cleanupErrors.push(error);
			}
		};
		this.#ending = true;
		this.#notifyStateChanged();
		this.#runFenceHandler?.(run.handle);
		try {
			await attemptCleanup(() => run.unsubscribe());
			await attemptCleanup(() => run.session.clearQueue());
			if (disposeRun) {
				await attemptCleanup(() => disposeRun(run.session));
			} else {
				await attemptCleanup(() => run.session.abort());
				await attemptCleanup(() => run.session.waitForIdle());
				await attemptCleanup(() => run.session.dispose());
			}
			await attemptCleanup(() => Promise.all([...this.#trackedOperations]).then(
				() => undefined,
			));
		} finally {
			this.#run = undefined;
			this.#clearRunScopedState();
			this.#ending = false;
			this.#notifyStateChanged();
			this.#notifyEnded(run.handle, cause);
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Agent Run cleanup failed");
		}
	}

	#clearRunScopedState(): void {
		this.#retentionReasons.clear();
		this.#requestRelationships.clear();
		this.#inputRequired = undefined;
		this.#interruptionHold = undefined;
		this.#isolatedResumption = undefined;
		this.#interrupting = false;
		this.#heldNativeQueue = undefined;
	}

	#markRunFailed(run: BoundRun, handle: AgentRunHandle): void {
		if (run.failed) return;
		run.failed = true;
		this.#runFenceHandler?.(handle);
		this.#notifyStateChanged();
	}

	#bindRun(session: AgentSession): void {
		this.#runSequence += 1;
		const handle = Object.freeze({ sequence: this.#runSequence });
		const run: BoundRun = {
			handle,
			session,
			unsubscribe: () => undefined,
			failed: false,
		};
		run.unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_start") this.#notifyStateChanged();
			if (event.type === "agent_end") {
				const assistant = [...event.messages]
					.reverse()
					.find((message) => message.role === "assistant");
				const terminalFailure = assistant?.role === "assistant" &&
					assistant.stopReason === "error" &&
					!event.willRetry;
				if (terminalFailure) this.#markRunFailed(run, handle);
			}
			if (event.type === "agent_settled") {
				for (const handler of this.#settledHandlers) {
					handler(handle, run.failed ? "failed" : "settled");
				}
			}
			if (event.type === "agent_end") {
				this.#restoreHeldNativeQueueAfterIsolatedTurn(run, handle, event);
			}
		});
		this.#run = run;
		this.#ending = false;
		this.#notifyStateChanged();
	}

	#notifyStateChanged(): void {
		for (const handler of this.#stateChangeHandlers) handler();
	}

	#notifyEnded(handle: AgentRunHandle, cause: AgentRunEndCause): void {
		for (const handler of this.#endedHandlers) handler(handle, cause);
	}

	#restoreHeldNativeQueueAfterIsolatedTurn(
		run: BoundRun,
		handle: AgentRunHandle,
		event: Extract<Parameters<Parameters<AgentSession["subscribe"]>[0]>[0], {
			type: "agent_end";
		}>,
	): void {
		const queue = this.#heldNativeQueue;
		if (
			this.#isolatedResumption?.handle !== handle ||
			queue?.handle !== handle
		) return;
		const assistant = [...event.messages]
			.reverse()
			.find((message) => message.role === "assistant");
		if (
			assistant?.role === "assistant" &&
			(assistant.stopReason === "error" || assistant.stopReason === "aborted")
		) return;
		this.#heldNativeQueue = undefined;
		for (const message of queue.steering) {
			this.trackOperation(run.session.sendUserMessage(message, { deliverAs: "steer" }));
		}
		for (const message of queue.followUp) {
			this.trackOperation(run.session.sendUserMessage(message, { deliverAs: "followUp" }));
		}
	}
}

function isRequestRelationshipReason(
	reason: RunRetentionReason,
): reason is RequestRelationshipReason {
	return reason === "awaiting_answer" || reason === "answer_owed";
}

function requireRequestRelationshipId(
	reason: RequestRelationshipReason,
	requestId: string | undefined,
): string {
	if (requestId === undefined || requestId.length === 0) {
		throw new Error(`${reason} requires an exact Request identity`);
	}
	return requestId;
}
