import { uuidv7 } from "@earendil-works/pi-ai";
import {
	materializeNewAgentTranscript,
	transcriptFromSessionFile,
} from "../pi-integration/session-manager-transcript.ts";
import { resolveModeratorAgentMetadata } from "../protocol/agent-metadata.ts";
import {
	createModelVisibleModeratorInput,
	createModelVisibleModeratorRoutineStart,
	isModeratorIdentity,
	MAX_MODERATOR_REQUEST_SOURCES,
	validateCommittedModeratorInput,
	type EntryPointer,
	type ModeratorIdentity,
	type ModeratorInput,
	type ModeratorTrigger,
} from "../protocol/moderator-input.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import {
	createModelVisibleObligationReminder,
	inspectObligationReminder,
	obligationReminderDeliveryId,
} from "../protocol/obligation-reminder.ts";
import {
	createModelVisibleRunFailureRecovery,
	runFailureRecoveryDeliveryId,
	inspectRunFailureRecovery,
	RUN_FAILURE_RECOVERY_DIRECTIVE,
	type RunFailureRecovery,
} from "../protocol/run-failure-recovery.ts";
import type {
	ModeratorControlInput,
	ModeratorControlReceipt,
} from "../protocol/moderator-control.ts";
import {
	sameModeratorControlInput,
	validateModeratorControlInput,
} from "../protocol/moderator-control.ts";
import {
	currentCoordinationScope,
	ProtocolInvariantError,
	resolveCommittedToolCall,
	toolCallPointerKey,
	type ToolCallPointer,
} from "../protocol/identities.ts";
import type { ProcessChildSessionFactory } from "../runtime/process-child-session-factory.ts";
import type { AgentRunHandle } from "../runtime/agent-runtime-host.ts";
import { SerialLane } from "../runtime/serial-lane.ts";
import type { WorkflowPolicyStore } from "../policy/workflow-policy.ts";
import { statusOf, type AgentRecord } from "./agent-record.ts";
import { detectDependencyDeadlocks } from "./dependency-deadlock.ts";
import type { MessageCoordinator } from "./messages.ts";
import {
	OperationReviewWatcher,
	SYSTEM_OPERATION_REVIEW_CLOCK,
	type OperationReviewClock,
	type OperationReviewSnapshot,
} from "./operation-review.ts";

export const MAX_AUTOMATIC_MODERATOR_ATTEMPTS = 2;

type ConditionSnapshotBase = Readonly<{
	key: string;
	affectedAgentIds: readonly string[];
	requestIds: readonly string[];
	inspectedThrough: readonly EntryPointer[];
}>;

type ObligationStallSnapshot = ConditionSnapshotBase & Readonly<{
	kind: "obligation_stall";
	agentId: string;
}>;

type RunFailureSnapshot = ConditionSnapshotBase & Readonly<{
	kind: "run_failure";
	agentId: string;
	run: AgentRunHandle;
}>;

type DependencyDeadlockSnapshot = ConditionSnapshotBase & Readonly<{
	kind: "dependency_deadlock";
}>;

type OperationReviewConditionSnapshot = ConditionSnapshotBase & Readonly<{
	kind: "operation_review";
	review: OperationReviewSnapshot;
}>;

type OperationalConditionSnapshot =
	| ObligationStallSnapshot
	| RunFailureSnapshot
	| DependencyDeadlockSnapshot
	| OperationReviewConditionSnapshot;

type OperationalIncidentHandling = {
	snapshot: OperationalConditionSnapshot;
	moderatorAgentId?: string;
	committedAttemptCount: number;
	diagnostics: EntryPointer[];
	exhausted: boolean;
	previousAttempt?: EntryPointer;
};

export type OperationalIncidentAttention = Readonly<{
	trigger: ModeratorTrigger;
	affectedAgents: readonly Readonly<{
		agentId: string;
		label: string;
	}>[];
	diagnostics: readonly EntryPointer[];
}>;

export type OperationalIncidentPresentation = Readonly<{
	present(conditionKey: string, attention: OperationalIncidentAttention): void;
	dismiss(conditionKey: string): void;
}>;

const unavailablePresentation: OperationalIncidentPresentation = {
	present() {},
	dismiss() {},
};

export type OperationalIncidentBoundaryHooks = Readonly<{
	beforeModeratorBootstrapCommit?(): void | "confirmed_failure";
	beforeModeratorRunStart?(): void | "confirmed_failure";
}>;

export class OperationalIncidentCoordinator {
	readonly #agents: Map<string, AgentRecord>;
	readonly #ownerIdentity: OwnerIdentity;
	readonly #sessionFactory: ProcessChildSessionFactory;
	readonly #messages: MessageCoordinator;
	readonly #integrateAgent: (record: AgentRecord) => void;
	readonly #isShuttingDown: () => boolean;
	readonly #reportError: (error: unknown) => void;
	readonly #boundaryHooks: OperationalIncidentBoundaryHooks;
	readonly #presentation: OperationalIncidentPresentation;
	readonly #workflowPolicy: WorkflowPolicyStore;
	readonly #operationReviews: OperationReviewWatcher;
	readonly #onAttentionChanged: () => void;
	readonly #handlingByKey = new Map<string, OperationalIncidentHandling>();
	readonly #attemptByModeratorAgentId = new Map<string, OperationalConditionSnapshot>();
	readonly #runFailureByKey = new Map<string, RunFailureSnapshot>();
	readonly #integratedAgentIds = new Set<string>();
	readonly #reconciliationLane = new SerialLane();

	constructor(options: {
		agents: Map<string, AgentRecord>;
		ownerIdentity: OwnerIdentity;
		sessionFactory: ProcessChildSessionFactory;
		messages: MessageCoordinator;
		workflowPolicy: WorkflowPolicyStore;
		integrateAgent(record: AgentRecord): void;
		isShuttingDown(): boolean;
		reportError(error: unknown): void;
		boundaryHooks?: OperationalIncidentBoundaryHooks;
		presentation?: OperationalIncidentPresentation;
		operationReviewClock?: OperationReviewClock;
		onAttentionChanged?(): void;
	}) {
		this.#agents = options.agents;
		this.#ownerIdentity = options.ownerIdentity;
		this.#sessionFactory = options.sessionFactory;
		this.#messages = options.messages;
		this.#workflowPolicy = options.workflowPolicy;
		this.#integrateAgent = options.integrateAgent;
		this.#isShuttingDown = options.isShuttingDown;
		this.#reportError = options.reportError;
		this.#boundaryHooks = options.boundaryHooks ?? {};
		this.#presentation = options.presentation ?? unavailablePresentation;
		this.#onAttentionChanged = options.onAttentionChanged ?? (() => undefined);
		this.#operationReviews = new OperationReviewWatcher({
			clock: options.operationReviewClock ?? SYSTEM_OPERATION_REVIEW_CLOCK,
			isUnresolved: (toolCall) => this.#isToolCallUnresolved(toolCall),
			hasAnswerObligation: (agentId) => {
				const record = this.#agents.get(agentId);
				return record !== undefined &&
					this.#messages.answerObligationRequestIds(record).length > 0;
			},
			onReviewStateChanged: () => this.#scheduleReconciliation(),
		});
		if (!options.agents.has(options.ownerIdentity.agentId)) {
			throw new Error("invariant_violation: Workflow Owner is unavailable");
		}
	}

	integrate(record: AgentRecord): void {
		if (this.#integratedAgentIds.has(record.identity.agentId)) return;
		this.#integratedAgentIds.add(record.identity.agentId);
		record.host.addSettledHandler((_handle, settlement) => {
			this.#operationReviews.setAgentAttendance(record.identity.agentId, "idle");
			if (settlement !== "settled") return;
			this.#scheduleReconciliationAfterHostLane(record);
		});
		record.host.addEndedHandler((handle, cause) => {
			this.#operationReviews.endRun(record.identity.agentId);
			if (this.#isModerator(record)) {
				if (cause === "failure" && !this.#isShuttingDown()) {
					void this.#reconciliationLane
						.run(async () => {
							const handling = [...this.#handlingByKey.values()].find(
								(candidate) =>
									candidate.moderatorAgentId === record.identity.agentId,
							);
							if (handling) await this.#handleModeratorFailure(handling, record);
						})
						.catch((error: unknown) => this.#reportError(error));
				}
				return;
			}
			if (
				cause === "failure" &&
				!this.#isShuttingDown()
			) {
				const requestIds = [...this.#messages.answerObligationRequestIds(record)].sort();
				if (requestIds.length > 0) {
					const snapshot: RunFailureSnapshot = {
						kind: "run_failure",
						key: JSON.stringify([
							"run_failure",
							record.identity.agentId,
							handle.sequence,
						]),
						agentId: record.identity.agentId,
						affectedAgentIds: [record.identity.agentId],
						run: handle,
						requestIds,
						inspectedThrough: [statusOf(record).primaryEvidence.inspectedThrough],
					};
					this.#runFailureByKey.set(snapshot.key, snapshot);
				}
			}
			this.#scheduleReconciliation();
		});
		record.host.addStateChangeHandler(() => {
			this.#operationReviews.reconcileAgent(record.identity.agentId);
			this.#scheduleReconciliation();
		});
	}

	beginExecution(agentId: string): void {
		this.#operationReviews.setAgentAttendance(agentId, "attended");
	}

	admitToolExecution(agentId: string, toolCallId: string, toolName: string): void {
		const record = this.#requireAgent(agentId);
		this.#operationReviews.reconcileAgent(agentId);
		const transcript = record.transcript.inspect();
		const { source } = resolveCommittedToolCall({
			agentId,
			transcript,
			toolCallId,
			toolName,
		});
		// Agent Wait is intentional coordination suspension. Dependency Deadlock
		// observes its Request graph; Operation Review must not time the parked tool.
		if (toolName === "agent_wait") return;
		const entry = transcript.entries.find(({ id }) => id === source.entryId);
		if (entry?.type !== "message" || entry.message.role !== "assistant") {
			throw new Error("invariant_violation: root tool call source is unavailable");
		}
		const toolCalls = entry.message.content.filter((part) => part.type === "toolCall");
		const classification = record.host.classifyToolBatch(
			toolCalls.map(({ name }) => name),
		);
		this.#operationReviews.admit({
			toolCall: source,
			classification,
			policyIntervalMs: this.#workflowPolicy.current().operationReviewIntervalMs,
		});
	}

	beginHumanWaiting(toolCall: ToolCallPointer): void {
		this.#operationReviews.beginHumanWaiting(toolCall);
	}

	beginHumanResultCommit(toolCall: ToolCallPointer): void {
		this.#operationReviews.beginHumanResultCommit(toolCall);
	}

	reconcileCommittedToolResults(agentId: string): void {
		this.#operationReviews.reconcileAgent(agentId);
	}

	executeModeratorControl(
		moderatorAgentId: string,
		toolCallId: string,
		providedInput: ModeratorControlInput,
	): Promise<ModeratorControlReceipt> {
		const moderator = this.#agents.get(moderatorAgentId);
		if (!moderator) throw new Error(`unknown_identity: ${moderatorAgentId}`);
		const { input: committedInput } = resolveCommittedToolCall({
			agentId: moderatorAgentId,
			transcript: moderator.transcript.inspect(),
			toolCallId,
			toolName: "moderator_control",
		});
		const input = validateModeratorControlInput(committedInput);
		if (!sameModeratorControlInput(input, providedInput)) {
			throw new Error(
				"invariant_violation: executed Moderator control input differs from its source",
			);
		}
		return this.#reconciliationLane.run(() =>
			input.operation === "renew_review_deadline"
				? this.#renewOperationReview(input)
				: this.#resolveHandling(moderatorAgentId, moderator)
		);
	}

	async #renewOperationReview(
		input: Extract<ModeratorControlInput, { operation: "renew_review_deadline" }>,
	): Promise<ModeratorControlReceipt> {
		this.#assertWorkflowToolCallPointer(input.toolCall);
		const disposition = this.#operationReviews.renew(
			input.toolCall,
			input.nextReviewInMs,
		);
		await this.#reconcileWorkflow();
		return disposition === "renewed"
			? {
				disposition,
				toolCall: input.toolCall,
				nextReviewInMs: input.nextReviewInMs,
			}
			: { disposition, toolCall: input.toolCall };
	}

	#resolveHandling(
		moderatorAgentId: string,
		moderator: AgentRecord,
	): ModeratorControlReceipt {
		const handling = [...this.#handlingByKey.values()].find(
			(candidate) => candidate.moderatorAgentId === moderatorAgentId,
		);
		const attempt = this.#attemptByModeratorAgentId.get(moderatorAgentId);

		const predicates: Array<
			| "incoming_requests"
			| "outgoing_requests"
			| "obligation_stall"
			| "run_failure"
			| "dependency_deadlock"
			| "operation_review"
		> = [];
		if (moderator.host.requestRelationshipIds("answer_owed").length > 0) {
			predicates.push("incoming_requests");
		}
		if (moderator.host.requestRelationshipIds("awaiting_answer").length > 0) {
			predicates.push("outgoing_requests");
		}
		const current = handling && this.#conditionRemains(handling.snapshot);
		if (handling && current) {
			predicates.push(handling.snapshot.kind);
		}
		if (predicates.length > 0) {
			return { disposition: "blocked", predicates };
		}
		if (!attempt) return { disposition: "already_cleared" };
		if (handling) this.#releaseHandling(handling.snapshot.key);
		this.#attemptByModeratorAgentId.delete(moderatorAgentId);
		const originalObligationRemains = attempt.affectedAgentIds.some((agentId) => {
			const affected = this.#agents.get(agentId);
			return affected !== undefined && this.#messages.hasUnsettledAnswerObligation(
				affected,
				attempt.requestIds,
			);
		});
		return {
			disposition: originalObligationRemains ? "resolved" : "already_cleared",
		};
	}

	attentionItems(callerAgentId: string): readonly OperationalIncidentAttention[] {
		if (callerAgentId !== this.#ownerIdentity.agentId) return [];
		return [...this.#handlingByKey.values()].flatMap((handling) =>
			handling.exhausted
				? [this.#attentionFor(handling)]
				: []
		);
	}

	reachSafeBoundary(): Promise<void> {
		return this.#reconciliationLane.run(() => undefined);
	}

	shutdown(): void {
		this.#operationReviews.shutdown();
		let attentionDismissed = false;
		for (const [key, handling] of this.#handlingByKey) {
			if (!handling.exhausted) continue;
			this.#presentation.dismiss(key);
			attentionDismissed = true;
		}
		this.#handlingByKey.clear();
		this.#attemptByModeratorAgentId.clear();
		this.#runFailureByKey.clear();
		if (attentionDismissed) this.#onAttentionChanged();
	}

	async #reconcileWorkflow(): Promise<void> {
		if (this.#isShuttingDown()) return;
		const snapshots: OperationalConditionSnapshot[] = [];
		for (const [key, snapshot] of this.#runFailureByKey) {
			if (!this.#conditionRemains(snapshot)) {
				await this.#notifyRunFailureRecovery(snapshot);
				this.#runFailureByKey.delete(key);
				continue;
			}
			snapshots.push(snapshot);
		}
		snapshots.push(...this.#observeOperationReviews());
		const dependencyDeadlocks = this.#observeDependencyDeadlocks();
		snapshots.push(...dependencyDeadlocks);
		const deadlockedAgentIds = new Set(
			dependencyDeadlocks.flatMap(({ affectedAgentIds }) => affectedAgentIds),
		);
		for (const record of [...this.#agents.values()]) {
			if (
				this.#isModerator(record) ||
				deadlockedAgentIds.has(record.identity.agentId)
			) continue;
			const snapshot = this.#observeObligationStall(record);
			if (snapshot) snapshots.push(snapshot);
		}
		const currentKeys = new Set(snapshots.map(({ key }) => key));
		for (const key of this.#handlingByKey.keys()) {
			if (!currentKeys.has(key)) this.#releaseHandling(key);
		}
		for (const snapshot of snapshots) {
			const existing = this.#handlingByKey.get(snapshot.key);
			if (existing?.moderatorAgentId !== undefined || existing?.exhausted) continue;
			if (
				!existing &&
				snapshot.kind === "obligation_stall" &&
				this.#scheduleObligationReminder(snapshot)
			) continue;
			const handling: OperationalIncidentHandling = existing ?? {
				snapshot,
				committedAttemptCount: 0,
				diagnostics: [],
				exhausted: false,
			};
			this.#handlingByKey.set(snapshot.key, handling);
			try {
				await this.#createModerator(handling);
			} catch (error) {
				if (
					handling.moderatorAgentId === undefined &&
					handling.committedAttemptCount === 0
				) {
					this.#handlingByKey.delete(snapshot.key);
				}
				throw error;
			}
		}
	}

	#scheduleObligationReminder(
		snapshot: ObligationStallSnapshot,
	): boolean {
		const requestId = snapshot.requestIds[0];
		if (!requestId || snapshot.requestIds.length !== 1) {
			throw new Error(
				`invariant_violation: Agent ${snapshot.agentId} has an invalid Answer obligation set`,
			);
		}
		const recipient = this.#requireAgent(snapshot.agentId);
		const question = this.#messages.requestQuestion(requestId);
		const inspectProof = () => inspectObligationReminder({
			recipientAgentId: snapshot.agentId,
			transcript: recipient.transcript.inspect(),
			requestMessageId: requestId,
			question,
		});
		if (inspectProof()) return false;
		// Settlement reconciliation can run while the affected Agent lane is held.
		// Schedule admission without awaiting that lane so the reminder cannot
		// deadlock behind the reconciliation that requested it.
		void this.#messages.admitCustomDelivery(recipient, {
			messageId: obligationReminderDeliveryId(requestId),
			deliveryMode: "deferred",
			customMessage: createModelVisibleObligationReminder({
				requestMessageId: requestId,
				question,
			}),
			inspectProof,
			isSuppressed: () => !this.#messages.hasUnsettledAnswerObligation(
				recipient,
				[requestId],
			),
		}).then((admission) => {
			if (admission !== "pending") {
				throw new Error(`Obligation Reminder delivery rejected: ${admission}`);
			}
		}).catch((error: unknown) => this.#reportError(error));
		return true;
	}

	async #createModerator(
		handling: OperationalIncidentHandling,
	): Promise<void> {
		if (!this.#agents.has(this.#ownerIdentity.agentId)) {
			throw new Error("invariant_violation: Workflow Owner is unavailable");
		}
		this.#sessionFactory.admitProcessRuntimePlatform();
		const agentId = uuidv7();
		const prepared = await this.#sessionFactory.prepareModeratorRun({ agentId });
		const sessionManager = this.#sessionFactory.createStagingSession(prepared);
		if (this.#isShuttingDown()) return;
		if (!this.#conditionRemains(handling.snapshot)) {
			this.#handlingByKey.delete(handling.snapshot.key);
			return;
		}

		const metadata = resolveModeratorAgentMetadata(handling.snapshot.kind);
		const identity: ModeratorIdentity = {
			agentId,
			workflowId: this.#ownerIdentity.workflowId,
			directSpawnerAgentId: null,
			metadata,
		};
		const input: ModeratorInput = {
			trigger: this.#triggerFor(handling.snapshot),
			inspectedThrough: handling.snapshot.inspectedThrough,
			...(handling.previousAttempt === undefined
				? {}
				: { previousAttempt: handling.previousAttempt }),
		};
		const bootstrapBoundary =
			this.#boundaryHooks.beforeModeratorBootstrapCommit?.();
		if (this.#isShuttingDown()) return;
		if (bootstrapBoundary === "confirmed_failure") {
			throw new Error("Confirmed Moderator bootstrap commit failure");
		}
		const modelInput = createModelVisibleModeratorInput(identity, input);
		sessionManager.appendCustomMessageEntry(
			modelInput.customType,
			modelInput.content,
			modelInput.display,
			modelInput.details,
		);
		let sessionPath: string;
		try {
			sessionPath = await materializeNewAgentTranscript(sessionManager);
		} catch (error) {
			if (error instanceof ProtocolInvariantError) throw error;
			const candidatePath = sessionManager.getSessionFile();
			if (!candidatePath || !hasExactDurableModeratorEvidence({
				sessionPath: candidatePath,
				identity,
				input,
			})) throw error;
			sessionPath = candidatePath;
		}
		validateCommittedModeratorInput({
			transcript: transcriptFromSessionFile(sessionPath).inspect(),
			identity,
			input,
		});
		if (handling.snapshot.kind === "operation_review") {
			this.#operationReviews.markModeratorInputCommitted(
				handling.snapshot.review.toolCall,
			);
		}
		handling.moderatorAgentId = agentId;
		handling.committedAttemptCount += 1;
		this.#attemptByModeratorAgentId.set(agentId, handling.snapshot);

		const moderator = this.#sessionFactory.createModeratorRecord({
			identity,
			initialPreparation: prepared,
			sessionPath,
		});
		this.#agents.set(agentId, moderator);
		this.#integrateAgent(moderator);
		if (
			this.#boundaryHooks.beforeModeratorRunStart?.() ===
			"confirmed_failure"
		) {
			await this.#handleModeratorFailure(handling, moderator);
			return;
		}
		try {
			await moderator.host.lane.run(async () => {
				if (this.#isShuttingDown()) return;
				await moderator.host.startInLane(["moderator_handling"]);
				moderator.host.deliverInLane({
					kind: "custom",
					message: createModelVisibleModeratorRoutineStart(),
					triggerTurn: true,
				});
			});
		} catch (error) {
			this.#reportError(error);
			await this.#handleModeratorFailure(handling, moderator);
		}
	}

	async #handleModeratorFailure(
		handling: OperationalIncidentHandling,
		moderator: AgentRecord,
	): Promise<void> {
		if (this.#isShuttingDown()) return;
		if (handling.moderatorAgentId !== moderator.identity.agentId) return;
		if (!this.#conditionRemains(handling.snapshot)) {
			this.#releaseHandling(handling.snapshot.key);
			return;
		}
		handling.previousAttempt = statusOf(moderator).primaryEvidence.inspectedThrough;
		handling.diagnostics.push(handling.previousAttempt);
		handling.moderatorAgentId = undefined;
		if (handling.committedAttemptCount < MAX_AUTOMATIC_MODERATOR_ATTEMPTS) {
			await this.#createModerator(handling);
		} else {
			handling.exhausted = true;
			this.#presentation.present(
				handling.snapshot.key,
				this.#attentionFor(handling),
			);
			this.#onAttentionChanged();
		}
	}

	#attentionFor(handling: OperationalIncidentHandling): OperationalIncidentAttention {
		return {
			trigger: this.#triggerFor(handling.snapshot),
			affectedAgents: handling.snapshot.affectedAgentIds.map((agentId) => ({
				agentId,
				label: this.#requireAgent(agentId).identity.metadata.label,
			})),
			diagnostics: [...handling.diagnostics],
		};
	}

	#triggerFor(snapshot: OperationalConditionSnapshot): ModeratorTrigger {
		if (snapshot.kind === "operation_review") {
			return {
				kind: "operation_review",
				toolCall: snapshot.review.toolCall,
				reviewIntervalMs: snapshot.review.reviewIntervalMs,
			};
		}
		const requestSet = {
			total: snapshot.requestIds.length,
			sources: this.#messages.requestSources(
				snapshot.requestIds.slice(0, MAX_MODERATOR_REQUEST_SOURCES),
			),
		};
		if (snapshot.kind === "run_failure") {
			return {
				kind: "run_failure",
				agentId: snapshot.agentId,
				runSequence: snapshot.run.sequence,
				obligations: requestSet,
			};
		}
		if (snapshot.kind === "obligation_stall") {
			return {
				kind: "obligation_stall",
				agentId: snapshot.agentId,
				obligations: requestSet,
			};
		}
		return {
			kind: "dependency_deadlock",
			agentIds: snapshot.affectedAgentIds,
			requests: requestSet,
		};
	}

	#observeObligationStall(
		record: AgentRecord,
	): ObligationStallSnapshot | undefined {
		const run = record.host.observe();
		if (
			run.phase !== "live" ||
			run.work !== "settled" ||
			record.host.currentRunFailed() ||
			run.attention !== "none" ||
			record.host.hasRetentionReason("pending_delivery") ||
			record.host.hasRetentionReason("interactive_selection") ||
			record.host.hasRetentionReason("interruption_hold")
		) {
			return undefined;
		}
		const requestIds = [
			...record.host.requestRelationshipIds("answer_owed"),
		].sort();
		if (requestIds.length === 0) return undefined;
		if (this.#operationReviews.hasUnresolvedAsynchronousCall(record.identity.agentId)) {
			return undefined;
		}
		if (this.#hasExternalProgress(record, new Set())) return undefined;
		const inspectedThrough = statusOf(record).primaryEvidence.inspectedThrough;
		return {
			kind: "obligation_stall",
			key: JSON.stringify(["obligation_stall", record.identity.agentId, ...requestIds]),
			agentId: record.identity.agentId,
			affectedAgentIds: [record.identity.agentId],
			requestIds,
			inspectedThrough: [inspectedThrough],
		};
	}

	#conditionRemains(snapshot: OperationalConditionSnapshot): boolean {
		if (snapshot.kind === "operation_review") {
			return this.#operationReviews.expiredReviews().some(
				(review) => toolCallPointerKey(review.toolCall) === snapshot.key,
			);
		}
		if (snapshot.kind === "obligation_stall") {
			const affected = this.#agents.get(snapshot.agentId);
			return affected !== undefined &&
				this.#observeObligationStall(affected)?.key === snapshot.key;
		}
			if (snapshot.kind === "run_failure") {
				const affected = this.#agents.get(snapshot.agentId);
				if (!affected) return false;
				if (affected.host.latestStartedRunSequence() > snapshot.run.sequence) return false;
				return this.#messages.hasUnsettledAnswerObligation(
				affected,
				snapshot.requestIds,
			);
		}
		return this.#observeDependencyDeadlocks().some(({ key }) => key === snapshot.key);
	}

	#observeOperationReviews(): readonly OperationReviewConditionSnapshot[] {
		return this.#operationReviews.expiredReviews().flatMap((review) => {
			const record = this.#agents.get(review.toolCall.agentId);
			if (!record) return [];
			const requestIds = [...this.#messages.answerObligationRequestIds(record)].sort();
			if (requestIds.length === 0) return [];
			return [{
				kind: "operation_review" as const,
				key: toolCallPointerKey(review.toolCall),
				affectedAgentIds: [review.toolCall.agentId],
				requestIds,
				inspectedThrough: [statusOf(record).primaryEvidence.inspectedThrough],
				review,
			}];
		});
	}

	#observeDependencyDeadlocks(): readonly DependencyDeadlockSnapshot[] {
		const ordinaryAgents = [...this.#agents.values()].filter(
			(record) => !this.#isModerator(record),
		);
		const eligibleAgentIds = ordinaryAgents.flatMap((record) =>
			this.#isDeadlockEligible(record) ? [record.identity.agentId] : []
		);
		const requestIds = [...new Set(ordinaryAgents.flatMap((record) => [
			...record.host.requestRelationshipIds("awaiting_answer"),
			...record.host.requestRelationshipIds("answer_owed"),
		]))].sort();
		return detectDependencyDeadlocks({
			eligibleAgentIds,
			requests: this.#messages.requestRelationships(requestIds),
		}).map((component) => ({
			kind: "dependency_deadlock",
			key: JSON.stringify([
				"dependency_deadlock",
				...component.agentIds,
				"requests",
				...component.requestIds,
			]),
			affectedAgentIds: component.agentIds,
			requestIds: component.requestIds,
			inspectedThrough: component.agentIds.map(
				(agentId) => statusOf(this.#agents.get(agentId)!).primaryEvidence.inspectedThrough,
			),
		}));
	}

	#isDeadlockEligible(record: AgentRecord): boolean {
		const run = record.host.observe();
		return run.phase === "live" &&
			run.work === "settled" &&
			(run.attention === "none" || run.attention === "agent_wait") &&
			!record.host.currentRunFailed() &&
			!this.#operationReviews.hasUnresolvedAsynchronousCall(
				record.identity.agentId,
			) &&
			run.retentionReasons.length > 0 &&
			run.retentionReasons.every(
				({ reason }) => reason === "awaiting_answer" || reason === "answer_owed",
			);
	}

	#hasExternalProgress(record: AgentRecord, path: Set<string>): boolean {
		const agentId = record.identity.agentId;
		if (path.has(agentId)) return false;
		path.add(agentId);
		try {
			const requestIds = record.host.requestRelationshipIds("awaiting_answer");
			for (const targetAgentId of this.#messages.requestTargetAgentIds(requestIds)) {
				const target = this.#agents.get(targetAgentId);
				if (!target || this.#isModerator(target)) continue;
				const run = target.host.observe();
				if (run.phase === "starting") return true;
				if (
					run.phase === "live" &&
					(
						run.work === "active" ||
						run.attention === "input_required" ||
						target.host.hasRetentionReason("pending_delivery") ||
						target.host.hasRetentionReason("interactive_selection")
					)
				) return true;
				if (
					run.phase === "live" &&
					run.work === "settled" &&
					!target.host.hasRetentionReason("interruption_hold") &&
					this.#hasExternalProgress(target, path)
				) return true;
			}
			return false;
		} finally {
			path.delete(agentId);
		}
	}

	#isModerator(record: AgentRecord): boolean {
		return isModeratorIdentity(record.identity);
	}

	#requireAgent(agentId: string): AgentRecord {
		const record = this.#agents.get(agentId);
		if (!record) throw new Error(`unknown_identity: ${agentId}`);
		return record;
	}

	#isToolCallUnresolved(toolCall: ToolCallPointer): boolean {
		const record = this.#agents.get(toolCall.agentId);
		if (!record) return false;
		const entries = currentCoordinationScope(
			record.transcript.inspect(),
			toolCall.agentId,
		);
		const sourceExists = entries.some(
			(entry) =>
				entry.id === toolCall.entryId &&
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) => part.type === "toolCall" && part.id === toolCall.toolCallId,
				),
		);
		if (!sourceExists) return false;
		return !entries.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCall.toolCallId,
		);
	}

	#assertWorkflowToolCallPointer(toolCall: ToolCallPointer): void {
		const record = this.#requireAgent(toolCall.agentId);
		const source = currentCoordinationScope(
			record.transcript.inspect(),
			toolCall.agentId,
		).find((entry) => entry.id === toolCall.entryId);
		if (
			source?.type !== "message" ||
			source.message.role !== "assistant" ||
			!source.message.content.some(
				(part) => part.type === "toolCall" && part.id === toolCall.toolCallId,
			)
		) {
			throw new Error("unknown_evidence: Moderator renewal tool-call pointer is invalid");
		}
	}

	async #notifyRunFailureRecovery(snapshot: RunFailureSnapshot): Promise<void> {
		const handling = this.#handlingByKey.get(snapshot.key);
		if (!handling?.moderatorAgentId) return;
		const affected = this.#agents.get(snapshot.agentId);
		if (
			!affected ||
			affected.host.latestStartedRunSequence() <= snapshot.run.sequence
		) return;
		const moderator = this.#agents.get(handling.moderatorAgentId);
		if (!moderator) return;
		const recovery: RunFailureRecovery = {
			trigger: {
				kind: "run_failure",
				agentId: snapshot.agentId,
				failedRunSequence: snapshot.run.sequence,
			},
			recovery: {
				kind: "successor_run_started",
				successorRunSequence: affected.host.latestStartedRunSequence(),
			},
			originalObligationsRemain: this.#messages.hasUnsettledAnswerObligation(
				affected,
				snapshot.requestIds,
			),
			requiredAction: "resolve",
			guidance: RUN_FAILURE_RECOVERY_DIRECTIVE,
		};
		const admission = await this.#messages.admitCustomDelivery(moderator, {
			messageId: runFailureRecoveryDeliveryId(recovery),
			deliveryMode: "deferred",
			customMessage: createModelVisibleRunFailureRecovery(recovery),
			inspectProof: () => inspectRunFailureRecovery({
				moderatorAgentId: moderator.identity.agentId,
				transcript: moderator.transcript.inspect(),
				recovery,
			}),
		});
		if (admission !== "pending") {
			throw new Error(`Run Failure Recovery delivery rejected: ${admission}`);
		}
	}

	#scheduleReconciliation(): void {
		void this.#reconciliationLane
			.run(() => this.#reconcileWorkflow())
			.catch((error: unknown) => this.#reportError(error));
	}

	#scheduleReconciliationAfterHostLane(record: AgentRecord): void {
		void record.host.lane
			.run(() => this.#reconciliationLane.run(() => this.#reconcileWorkflow()))
			.catch((error: unknown) => this.#reportError(error));
	}

	#releaseHandling(key: string): void {
		const handling = this.#handlingByKey.get(key);
		if (!handling) return;
		this.#handlingByKey.delete(key);
		if (handling.exhausted) {
			this.#presentation.dismiss(key);
			this.#onAttentionChanged();
		}
		if (!handling.moderatorAgentId) return;
		this.#agents
			.get(handling.moderatorAgentId)
			?.host.removeRetentionReason("moderator_handling");
	}
}

function hasExactDurableModeratorEvidence(options: {
	sessionPath: string;
	identity: ModeratorIdentity;
	input: ModeratorInput;
}): boolean {
	try {
		validateCommittedModeratorInput({
			transcript: transcriptFromSessionFile(options.sessionPath).inspect(),
			identity: options.identity,
			input: options.input,
		});
		return true;
	} catch (error) {
		if (error instanceof ProtocolInvariantError) throw error;
		return false;
	}
}
