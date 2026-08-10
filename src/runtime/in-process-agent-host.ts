import type {
	AgentSession,
	AgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { PiNativeAgentProjection } from "../pi-integration/native-agent-projection.ts";
import { SerialLane } from "./serial-lane.ts";

export type RunRetentionReason =
	| "owner_host_binding"
	| "pending_delivery"
	| "awaiting_answer"
	| "answer_owed"
	| "interruption_hold"
	| "moderator_handling";

export type AgentRuntimeRetentionReason = "interactive_selection";
export type AgentRetentionReason = RunRetentionReason | AgentRuntimeRetentionReason;

export type AgentRetention = Readonly<{
	reason: AgentRetentionReason;
	count: number;
}>;

type RequestRelationshipReason = "awaiting_answer" | "answer_owed";

export type LiveRunState = Readonly<{
	phase: "starting" | "live" | "ending";
	work?: "active" | "settled";
	attention: "none" | "input_required";
	retentionReasons: readonly AgentRetention[];
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

export type StartedAgentRuntime = Readonly<{
	session: AgentSession;
	projection: PiNativeAgentProjection;
	ready?: Promise<void>;
}>;

type BoundAgentRuntime = {
	handle: AgentRunHandle;
	session: AgentSession;
	projection: PiNativeAgentProjection | undefined;
	unsubscribe: () => void;
	admitted: boolean;
	failed: boolean;
	expectedInterruption: boolean;
	releaseDeferredUntilInputSettles: boolean;
};

type HeldNativeQueue = {
	handle: AgentRunHandle;
	steering: string[];
	followUp: string[];
};

type StartSession = () => Promise<StartedAgentRuntime>;
export type AgentRunSettlement = "settled" | "failed";
type SettledHandler = (handle: AgentRunHandle, settlement: AgentRunSettlement) => void;
export type AgentRunEndCause = "clean" | "failure" | "termination" | "shutdown";
type EndedHandler = (handle: AgentRunHandle, cause: AgentRunEndCause) => void;
type StateChangeHandler = () => void;
type ProjectionInputSettledHandler = () => void;
type RunFenceHandler = (handle: AgentRunHandle) => void;
export type ResidualRequestRelationships = Readonly<{
	awaitingAnswerRequestIds: readonly string[];
	answerOwedRequestIds: readonly string[];
}>;
type RunStartInitializer = () => ResidualRequestRelationships;
type RunStartedHandler = (
	session: AgentSession,
	handle: AgentRunHandle,
) => void | Promise<void>;
type RunEndingHandler = (
	session: AgentSession,
	handle: AgentRunHandle,
	cause: Exclude<AgentRunEndCause, "clean">,
) => void | Promise<void>;

export class InProcessAgentHost {
	readonly lane = new SerialLane();
	readonly sessionManager: SessionManager;
	readonly #startSession: StartSession | undefined;
	readonly #retentionReasons = new Set<AgentRetentionReason>();
	readonly #requestRelationships = new Map<
		RequestRelationshipReason,
		Set<string>
	>();
	readonly #trackedOperations = new Set<Promise<void>>();
	#runtime: BoundAgentRuntime | undefined;
	#starting = false;
	#passivePreparation = false;
	#startingCancellationRequested = false;
	#runStartsClosed = false;
	#ending = false;
	#interrupting = false;
	#runSequence = 0;
	#holdSequence = 0;
	readonly #settledHandlers = new Set<SettledHandler>();
	readonly #endedHandlers = new Set<EndedHandler>();
	readonly #stateChangeHandlers = new Set<StateChangeHandler>();
	#projectionInputSettledHandler: ProjectionInputSettledHandler | undefined;
	#runFenceHandler: RunFenceHandler | undefined;
	#runStartInitializer: RunStartInitializer | undefined;
	#runStartedHandler: RunStartedHandler | undefined;
	#runEndingHandler: RunEndingHandler | undefined;
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
		initialRetentionReasons?: readonly AgentRetentionReason[];
	}) {
		this.sessionManager = options.sessionManager;
		this.#startSession = options.startSession;
		for (const reason of options.initialRetentionReasons ?? []) {
			this.#retentionReasons.add(reason);
		}
		if (options.initialSession) {
			this.#bindRuntime(
				{ session: options.initialSession, projection: undefined },
				true,
			);
		}
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
		if (this.#starting && !this.#passivePreparation) {
			return {
				phase: "starting",
				attention: "none",
				retentionReasons,
			};
		}
		const run = this.#runtime;
		if (!run?.admitted) return { phase: "dormant", retentionReasons: [] };
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

	setProjectionInputSettledHandler(handler: ProjectionInputSettledHandler): void {
		this.#projectionInputSettledHandler = handler;
	}

	setRunFenceHandler(handler: RunFenceHandler): void {
		this.#runFenceHandler = handler;
	}

	setRunStartInitializer(initializer: RunStartInitializer): void {
		this.#runStartInitializer = initializer;
	}

	setRunStartedHandler(handler: RunStartedHandler): void {
		this.#runStartedHandler = handler;
	}

	setRunEndingHandler(handler: RunEndingHandler): void {
		this.#runEndingHandler = handler;
	}

	initializeCurrentRunRelationships(): void {
		if (!this.#runtime || this.#starting || this.#ending) {
			throw new Error("invariant_violation: Request relationships require a bound Agent Run");
		}
		this.#initializeRequestRelationships();
	}

	currentHandle(): AgentRunHandle | undefined {
		return this.#runtime?.admitted ? this.#runtime.handle : undefined;
	}

	currentProjection(): PiNativeAgentProjection | undefined {
		return this.#runtime?.projection;
	}

	async beginShutdown(): Promise<boolean> {
		this.#runStartsClosed = true;
		const projection = this.#runtime?.projection;
		return projection
			? this.cancelRuntimeInitialization(
				projection,
				new Error("Workflow shutdown during Agent Run initialization"),
			)
			: false;
	}

	async cancelRuntimeInitialization(
		projection: PiNativeAgentProjection,
		error: unknown,
	): Promise<boolean> {
		const run = this.#runtime;
		if (!this.#starting || !run || run.projection !== projection) return false;
		const cancellation = projection.cancelInitialization(error);
		if (!cancellation) return false;
		this.#startingCancellationRequested = true;
		await cancellation;
		return true;
	}

	latestStartedRunSequence(): number {
		return this.#runSequence;
	}

	currentRunFailed(): boolean {
		return this.#runtime?.admitted ? this.#runtime.failed : false;
	}

	isCurrent(handle: AgentRunHandle): boolean {
		return this.#runtime?.admitted === true && this.#runtime.handle === handle;
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
		return this.#interruptionHold === hold && this.#runtime?.handle === hold.run;
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
		const run = this.#runtime;
		if (
			!run?.admitted ||
			this.#starting ||
			this.#ending ||
			run.failed
		) return "not_running";
		if (this.#interruptionHold?.run === run.handle) return "already_held";
		this.#isolatedResumption = undefined;
		run.expectedInterruption = true;
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
			if (this.#runtime !== run || this.#ending || run.failed || !run.session.isIdle) {
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
			run.expectedInterruption = false;
		}
	}

	prepareInterruption(): void {
		const run = this.#runtime;
		if (
			!run?.admitted ||
			this.#starting ||
			this.#ending ||
			run.failed ||
			this.#interruptionHold?.run === run.handle
		) return;
		// Pi 0.84 can emit agent_end(error) from an AbortSignal before the
		// serialized interruption lane reaches interruptCurrentRunInLane(). Arm
		// the exact Run at the human boundary so that event is not Run Failure.
		run.expectedInterruption = true;
	}

	beginInputRequired(handle: AgentRunHandle, requestId: string): void {
		const run = this.#runtime;
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
		const run = this.#runtime;
		return run?.handle === handle &&
			!this.#starting &&
			!this.#ending &&
			!run.failed &&
			this.#inputRequired?.handle === handle &&
			this.#inputRequired.requestId === requestId;
	}

	failExactRun(handle: AgentRunHandle): void {
		const run = this.#runtime;
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
		const session = this.#runtime?.admitted ? this.#runtime.session : undefined;
		if (!session) throw new Error(`Agent Run is unavailable: ${this.sessionManager.getSessionId()}`);
		return session;
	}

	requirePreparedSession(): AgentSession {
		const session = this.#runtime?.session;
		if (!session) {
			throw new Error(`Agent runtime is unavailable: ${this.sessionManager.getSessionId()}`);
		}
		return session;
	}

	async startInLane(
		initialRetentionReasons: readonly AgentRetentionReason[] = [],
	): Promise<AgentSession> {
		return this.#ensureRuntimeInLane(true, initialRetentionReasons);
	}

	async prepareInLane(
		initialRetentionReasons: readonly AgentRetentionReason[] = [],
	): Promise<AgentSession> {
		return this.#ensureRuntimeInLane(false, initialRetentionReasons);
	}

	async #ensureRuntimeInLane(
		admitRun: boolean,
		initialRetentionReasons: readonly AgentRetentionReason[],
	): Promise<AgentSession> {
		const existing = this.#runtime;
		if (existing) {
			if (admitRun && !existing.admitted && this.#runStartsClosed) {
				throw new Error("host_shutting_down: Agent Run startup is closed");
			}
			for (const reason of initialRetentionReasons) this.#retentionReasons.add(reason);
			if (!admitRun || existing.admitted) return existing.session;
			this.#starting = true;
			this.#passivePreparation = false;
			this.#notifyStateChanged();
			try {
				await this.#admitPreparedRun(existing);
				return existing.session;
			} catch (error) {
				const cleanupErrors = [error, ...await this.#discardFailedStart("failure")];
				this.#clearRunScopedState();
				if (cleanupErrors.length > 1) {
					throw new AggregateError(cleanupErrors, "Agent Run admission cleanup failed");
				}
				throw error;
			} finally {
				this.#starting = false;
				this.#passivePreparation = false;
				this.#notifyStateChanged();
			}
		}
		if (this.#runStartsClosed) {
			throw new Error("host_shutting_down: Agent Run startup is closed");
		}
		if (!this.#startSession) {
			throw new Error(`Agent Run cannot restart: ${this.sessionManager.getSessionId()}`);
		}
		this.#starting = true;
		this.#passivePreparation = !admitRun;
		for (const reason of initialRetentionReasons) this.#retentionReasons.add(reason);
		this.#notifyStateChanged();
		let startedRun: StartedAgentRuntime | undefined;
		let readiness: Promise<void> | undefined;
		let readinessObserved = false;
		try {
			startedRun = await this.#startSession();
			readiness = startedRun.ready ?? Promise.resolve();
			this.#bindRuntime(startedRun);
			if (admitRun) this.#markPreparedRunAdmitted(this.#runtime!);
			if (this.#runStartsClosed) {
				const shutdownError = new Error(
					"Workflow shutdown during Agent Run initialization",
				);
				const cancellation = startedRun.projection.cancelInitialization(shutdownError);
				if (cancellation) {
					this.#startingCancellationRequested = true;
					const [cancellationResult] = await Promise.allSettled([
						cancellation,
						readiness,
					]);
					readinessObserved = true;
					if (cancellationResult.status === "rejected") {
						throw cancellationResult.reason;
					}
					throw shutdownError;
				}
				// Cancellation can lose to readiness or natural failure. Observe that exact
				// result before choosing termination versus Run Failure classification.
				await readiness;
				readinessObserved = true;
				this.#startingCancellationRequested = true;
				throw shutdownError;
			}
			if (admitRun) {
				await this.#runStartedHandler?.(this.#runtime!.session, this.#runtime!.handle);
			}
			await readiness;
			readinessObserved = true;
			return startedRun.session;
		} catch (error) {
			const cleanupErrors: unknown[] = [error];
			if (startedRun && readiness && !readinessObserved) {
				const cancellation = startedRun.projection.cancelInitialization(error);
				const results = await Promise.allSettled([
					...(cancellation ? [cancellation] : []),
					readiness,
				]);
				readinessObserved = true;
				for (const result of results) {
					if (
						result.status === "rejected" &&
						!cleanupErrors.includes(result.reason)
					) cleanupErrors.push(result.reason);
				}
			}
			const endCause = this.#startingCancellationRequested
				? "termination" as const
				: "failure" as const;
			cleanupErrors.push(...await this.#discardFailedStart(endCause));
			this.#clearRunScopedState();
			if (cleanupErrors.length > 1) {
				throw new AggregateError(
					cleanupErrors,
					admitRun
						? "Agent Run startup cleanup failed"
						: "Agent runtime preparation cleanup failed",
				);
			}
			throw error;
		} finally {
			if (this.#starting) {
				this.#starting = false;
				this.#passivePreparation = false;
				this.#notifyStateChanged();
			}
		}
	}

	async #admitPreparedRun(run: BoundAgentRuntime): Promise<void> {
		if (run.admitted) return;
		this.#markPreparedRunAdmitted(run);
		await this.#runStartedHandler?.(run.session, run.handle);
	}

	#markPreparedRunAdmitted(run: BoundAgentRuntime): void {
		this.#runSequence += 1;
		run.handle = Object.freeze({ sequence: this.#runSequence });
		run.admitted = true;
		this.#initializeRequestRelationships();
		this.#notifyStateChanged();
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

	addRetentionReason(reason: AgentRetentionReason, requestId?: string): void {
		if (!this.#runtime && !this.#starting) return;
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

	removeRetentionReason(reason: AgentRetentionReason, requestId?: string): void {
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

	hasRetentionReason(reason: AgentRetentionReason, requestId?: string): boolean {
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

	queuedInputCount(): number {
		const held = this.#heldNativeQueue;
		return (this.#runtime?.session.pendingMessageCount ?? 0) +
			(held ? held.steering.length + held.followUp.length : 0);
	}

	trackOperation(operation: Promise<unknown>): void {
		const tracked = operation.then(
			() => undefined,
			() => undefined,
		);
		this.#trackedOperations.add(tracked);
		void tracked.finally(() => this.#trackedOperations.delete(tracked));
	}

	async releaseIfEligibleInLane(
		handle: AgentRunHandle,
	): Promise<"released" | "retained" | "stale"> {
		const run = this.#runtime;
		if (!run?.admitted || run.handle !== handle) return "stale";
		if (hasInFlightProjectionInput(run)) {
			this.#deferReleaseUntilProjectionInputSettles(run);
			return "retained";
		}
		if (
			this.#starting ||
			this.#ending ||
			!run.session.isIdle
		) return "retained";
		// Selection owns Runtime availability, not the exact Run. Release an
		// otherwise unretained Run without tearing down its attached Pi mode.
		const retainRuntime = this.#retentionReasons.has("interactive_selection");
		const runRetentionReasonCount = this.#retentionReasons.size -
			(retainRuntime ? 1 : 0);
		if (
			runRetentionReasonCount > 0 ||
			this.#requestRelationships.size > 0 ||
			this.#inputRequired !== undefined ||
			this.#interruptionHold !== undefined
		) {
			return "retained";
		}
		this.#ending = true;
		this.#notifyStateChanged();
		const cleanupErrors: unknown[] = [];
		const attemptCleanup = async (cleanup: () => unknown | Promise<unknown>) => {
			try {
				await cleanup();
			} catch (error) {
				cleanupErrors.push(error);
			}
		};
		try {
			if (!retainRuntime) {
				await attemptCleanup(() => run.unsubscribe());
				await attemptCleanup(() => run.projection?.dispose());
				await attemptCleanup(() => run.session.dispose());
			}
		} finally {
			if (retainRuntime) {
				run.admitted = false;
				run.failed = false;
				run.expectedInterruption = false;
			} else {
				this.#runtime = undefined;
			}
			this.#clearRunScopedState(retainRuntime);
			this.#ending = false;
			this.#notifyStateChanged();
			this.#notifyEnded(run.handle, "clean");
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Agent Run cleanup failed");
		}
		return "released";
	}

	async releasePreparedRuntimeInLane(): Promise<"released" | "retained" | "stale"> {
		const run = this.#runtime;
		if (!run || run.admitted) return "stale";
		if (hasInFlightProjectionInput(run)) {
			this.#deferReleaseUntilProjectionInputSettles(run);
			return "retained";
		}
		if (
			this.#starting ||
			this.#ending ||
			this.#retentionReasons.size > 0
		) {
			return "retained";
		}
		this.#ending = true;
		this.#notifyStateChanged();
		const cleanupErrors: unknown[] = [];
		const attemptCleanup = async (cleanup: () => unknown | Promise<unknown>) => {
			try {
				await cleanup();
			} catch (error) {
				cleanupErrors.push(error);
			}
		};
		try {
			await attemptCleanup(() => run.unsubscribe());
			await attemptCleanup(() => run.projection?.dispose());
			await attemptCleanup(() => run.session.dispose());
		} finally {
			this.#runtime = undefined;
			this.#clearRunScopedState();
			this.#ending = false;
			this.#notifyStateChanged();
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Prepared Agent runtime cleanup failed");
		}
		return "released";
	}

	async discardAndEndInLane(
		cause: Exclude<AgentRunEndCause, "clean">,
		disposeRun?: (session: AgentSession) => Promise<void>,
	): Promise<void> {
		const run = this.#runtime;
		if (!run) {
			this.#clearRunScopedState();
			return;
		}
		// A failed selected Run becomes Dormant in place so transcript, commands,
		// extension state, and projection identity remain available to the human.
		const retainRuntime = cause === "failure" &&
			disposeRun === undefined &&
			run.projection !== undefined &&
			this.#retentionReasons.has("interactive_selection");
		const endedHandle = run.handle;
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
		if (run.admitted) this.#runFenceHandler?.(run.handle);
		try {
			if (run.admitted) {
				await attemptCleanup(() =>
					this.#runEndingHandler?.(run.session, run.handle, cause)
				);
			}
			if (!retainRuntime) await attemptCleanup(() => run.unsubscribe());
			await attemptCleanup(() => run.session.clearQueue());
			if (disposeRun) {
				await attemptCleanup(() => disposeRun(run.session));
			} else {
				await attemptCleanup(() => run.session.abort());
				await attemptCleanup(() => run.session.waitForIdle());
			}
			if (!retainRuntime) await attemptCleanup(() => run.projection?.dispose());
			if (!disposeRun && !retainRuntime) {
				await attemptCleanup(() => run.session.dispose());
			}
			await attemptCleanup(() => Promise.all([...this.#trackedOperations]).then(
				() => undefined,
			));
		} finally {
			if (retainRuntime) {
				run.admitted = false;
				run.failed = false;
				run.expectedInterruption = false;
			} else {
				this.#runtime = undefined;
			}
			this.#clearRunScopedState(retainRuntime);
			this.#ending = false;
			this.#notifyStateChanged();
			if (endedHandle.sequence > 0) this.#notifyEnded(endedHandle, cause);
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Agent Run cleanup failed");
		}
	}

	#clearRunScopedState(preserveInteractiveSelection = false): void {
		const interactiveSelectionRetained = preserveInteractiveSelection &&
			this.#retentionReasons.has("interactive_selection");
		this.#retentionReasons.clear();
		if (interactiveSelectionRetained) {
			this.#retentionReasons.add("interactive_selection");
		}
		this.#requestRelationships.clear();
		this.#startingCancellationRequested = false;
		this.#passivePreparation = false;
		this.#inputRequired = undefined;
		this.#interruptionHold = undefined;
		this.#isolatedResumption = undefined;
		this.#interrupting = false;
		this.#heldNativeQueue = undefined;
	}

	async #discardFailedStart(
		cause: Extract<AgentRunEndCause, "failure" | "termination">,
	): Promise<unknown[]> {
		const failedStart = this.#runtime;
		if (!failedStart) return [];
		const cleanupErrors: unknown[] = [];
		const attemptCleanup = async (cleanup: () => unknown | Promise<unknown>) => {
			try {
				await cleanup();
			} catch (error) {
				cleanupErrors.push(error);
			}
		};
		if (failedStart.admitted) this.#runFenceHandler?.(failedStart.handle);
		try {
			// An initializing projection may already be the human's active view.
			// Publish terminal failure before disposal so its owner closes the invalid
			// attachment before the Runtime disappears.
			if (failedStart.admitted) {
				await attemptCleanup(() =>
					this.#runEndingHandler?.(
						failedStart.session,
						failedStart.handle,
						cause,
					)
				);
			}
			await attemptCleanup(() => failedStart.unsubscribe());
			await attemptCleanup(() => failedStart.projection?.dispose());
			await attemptCleanup(() => failedStart.session.dispose());
		} finally {
			this.#runtime = undefined;
			this.#clearRunScopedState();
			this.#starting = false;
			this.#notifyStateChanged();
			if (failedStart.admitted) this.#notifyEnded(failedStart.handle, cause);
		}
		return cleanupErrors;
	}

	#markRunFailed(run: BoundAgentRuntime, handle: AgentRunHandle): void {
		if (!run.admitted || run.failed) return;
		run.failed = true;
		this.#runFenceHandler?.(handle);
		this.#notifyStateChanged();
	}

	#bindRuntime(startedRun: {
		session: AgentSession;
		projection: PiNativeAgentProjection | undefined;
	}, admitted = false): void {
		const { session, projection } = startedRun;
		if (admitted) this.#runSequence += 1;
		const handle = Object.freeze({
			sequence: admitted ? this.#runSequence : 0,
		});
		const run: BoundAgentRuntime = {
			handle,
			session,
			projection,
			unsubscribe: () => undefined,
			admitted,
			failed: false,
			expectedInterruption: false,
			releaseDeferredUntilInputSettles: false,
		};
		// Publish ownership before the native subscribe call so startup rollback can
		// still dispose the exact projection and session if subscription itself fails.
		this.#runtime = run;
		run.unsubscribe = session.subscribe((event) => {
			if (
				event.type === "agent_start" ||
				event.type === "queue_update" ||
				event.type === "thinking_level_changed"
			) this.#notifyStateChanged();
			if (event.type === "agent_end") {
				const assistant = [...event.messages]
					.reverse()
					.find((message) => message.role === "assistant");
				const expectedInterruption = run.expectedInterruption;
				run.expectedInterruption = false;
				const terminalFailure = assistant?.role === "assistant" &&
					assistant.stopReason === "error" &&
					!event.willRetry &&
					// Pi 0.84 can report an error when an interrupted sequential tool
					// rejects before the abort reaches the model loop. The explicit
					// interruption request owns that terminal transition; do not turn it
					// into Run Failure before the exact Hold is established.
					!this.#interrupting &&
					!expectedInterruption;
				if (terminalFailure) this.#markRunFailed(run, run.handle);
			}
			if (event.type === "agent_settled") {
				run.expectedInterruption = false;
				for (const handler of this.#settledHandlers) {
					handler(run.handle, run.failed ? "failed" : "settled");
				}
			}
			if (event.type === "agent_end") {
				this.#restoreHeldNativeQueueAfterIsolatedTurn(run, run.handle, event);
			}
		});
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
		run: BoundAgentRuntime,
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

	#deferReleaseUntilProjectionInputSettles(run: BoundAgentRuntime): void {
		// agent_settled can request release before the projection loop leaves
		// session.prompt(); retry only after that exact input lifecycle closes.
		if (run.releaseDeferredUntilInputSettles || !run.projection) return;
		run.releaseDeferredUntilInputSettles = true;
		void run.projection.whenInputIdle().then(() => {
			if (this.#runtime !== run || !run.releaseDeferredUntilInputSettles) return;
			run.releaseDeferredUntilInputSettles = false;
			this.#projectionInputSettledHandler?.();
		});
	}
}

function hasInFlightProjectionInput(run: BoundAgentRuntime): boolean {
	// Pi remains session-idle during async input and prompt preflight, so only
	// the native projection can protect the exact Runtime across that interval.
	return run.projection?.isProcessingInput() ?? false;
}

function isRequestRelationshipReason(
	reason: AgentRetentionReason,
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
