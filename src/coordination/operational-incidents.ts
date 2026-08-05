import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	continueFromCommittedInput,
	persistCommittedInput,
} from "../pi-integration/committed-input.ts";
import { resolveModeratorAgentMetadata } from "../protocol/agent-metadata.ts";
import {
	createModelVisibleModeratorInput,
	isModeratorIdentity,
	MAX_MODERATOR_REQUEST_SOURCES,
	validateCommittedModeratorInput,
	type EntryPointer,
	type ModeratorIdentity,
	type ModeratorInput,
	type ModeratorTrigger,
} from "../protocol/moderator-input.ts";
import type {
	OwnerIdentity,
	RuntimeConfigurationBaseline,
} from "../protocol/owner-identity.ts";
import type {
	ModeratorControlInput,
	ModeratorControlReceipt,
} from "../protocol/moderator-control.ts";
import {
	sameModeratorControlInput,
	validateModeratorControlInput,
} from "../protocol/moderator-control.ts";
import { resolveCommittedToolCall } from "../protocol/identities.ts";
import type { DefaultChildSessionFactory } from "../runtime/default-child-session-factory.ts";
import type { AgentRunHandle } from "../runtime/in-process-agent-host.ts";
import { SerialLane } from "../runtime/serial-lane.ts";
import { statusOf, type AgentRecord } from "./agent-record.ts";
import { detectDependencyDeadlocks } from "./dependency-deadlock.ts";
import type { MessageCoordinator } from "./messages.ts";

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

type OperationalConditionSnapshot =
	| ObligationStallSnapshot
	| RunFailureSnapshot
	| DependencyDeadlockSnapshot;

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
	affectedAgentIds: readonly string[];
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
	readonly #sessionFactory: DefaultChildSessionFactory;
	readonly #messages: MessageCoordinator;
	readonly #integrateAgent: (record: AgentRecord) => void;
	readonly #isShuttingDown: () => boolean;
	readonly #reportError: (error: unknown) => void;
	readonly #boundaryHooks: OperationalIncidentBoundaryHooks;
	readonly #presentation: OperationalIncidentPresentation;
	readonly #handlingByKey = new Map<string, OperationalIncidentHandling>();
	readonly #attemptByModeratorAgentId = new Map<string, OperationalConditionSnapshot>();
	readonly #runFailureByKey = new Map<string, RunFailureSnapshot>();
	readonly #integratedAgentIds = new Set<string>();
	readonly #reconciliationLane = new SerialLane();
	#ownerRuntimeBaseline: RuntimeConfigurationBaseline;

	constructor(options: {
		agents: Map<string, AgentRecord>;
		ownerIdentity: OwnerIdentity;
		sessionFactory: DefaultChildSessionFactory;
		messages: MessageCoordinator;
		integrateAgent(record: AgentRecord): void;
		isShuttingDown(): boolean;
		reportError(error: unknown): void;
		boundaryHooks?: OperationalIncidentBoundaryHooks;
		presentation?: OperationalIncidentPresentation;
	}) {
		this.#agents = options.agents;
		this.#ownerIdentity = options.ownerIdentity;
		this.#sessionFactory = options.sessionFactory;
		this.#messages = options.messages;
		this.#integrateAgent = options.integrateAgent;
		this.#isShuttingDown = options.isShuttingDown;
		this.#reportError = options.reportError;
		this.#boundaryHooks = options.boundaryHooks ?? {};
		this.#presentation = options.presentation ?? unavailablePresentation;
		const owner = options.agents.get(options.ownerIdentity.agentId);
		if (!owner) throw new Error("invariant_violation: Workflow Owner is unavailable");
		this.#ownerRuntimeBaseline = options.sessionFactory.snapshotRuntimeBaseline(owner);
	}

	integrate(record: AgentRecord): void {
		if (this.#integratedAgentIds.has(record.identity.agentId)) return;
		this.#integratedAgentIds.add(record.identity.agentId);
		record.host.addSettledHandler((_handle, settlement) => {
			if (settlement !== "settled") return;
			this.#scheduleReconciliationAfterHostLane(record);
		});
		record.host.addEndedHandler((handle, cause) => {
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
			this.#scheduleReconciliation();
		});
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
			sessionManager: moderator.host.sessionManager,
			toolCallId,
			toolName: "moderator_control",
		});
		const input = validateModeratorControlInput(committedInput);
		if (!sameModeratorControlInput(input, providedInput)) {
			throw new Error(
				"invariant_violation: executed Moderator control input differs from its source",
			);
		}
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
			return Promise.resolve({ disposition: "blocked", predicates });
		}
		if (!attempt) return Promise.resolve({ disposition: "already_cleared" });
		if (handling) this.#releaseHandling(handling.snapshot.key);
		this.#attemptByModeratorAgentId.delete(moderatorAgentId);
		const originalObligationRemains = attempt.affectedAgentIds.some((agentId) => {
			const affected = this.#agents.get(agentId);
			return affected !== undefined && this.#messages.hasUnsettledAnswerObligation(
				affected,
				attempt.requestIds,
			);
		});
		return Promise.resolve({
			disposition: originalObligationRemains ? "resolved" : "already_cleared",
		});
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

	async #reconcileWorkflow(): Promise<void> {
		if (this.#isShuttingDown()) return;
		const snapshots: OperationalConditionSnapshot[] = [];
		for (const [key, snapshot] of this.#runFailureByKey) {
			if (!this.#conditionRemains(snapshot)) {
				this.#runFailureByKey.delete(key);
				continue;
			}
			snapshots.push(snapshot);
		}
		snapshots.push(...this.#observeDependencyDeadlocks());
		for (const record of [...this.#agents.values()]) {
			if (this.#isModerator(record)) continue;
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

	async #createModerator(
		handling: OperationalIncidentHandling,
	): Promise<void> {
		const owner = this.#agents.get(this.#ownerIdentity.agentId);
		if (!owner) throw new Error("invariant_violation: Workflow Owner is unavailable");
		const baseline = owner.host.currentHandle()
			? this.#sessionFactory.snapshotRuntimeBaseline(owner)
			: this.#ownerRuntimeBaseline;
		this.#ownerRuntimeBaseline = baseline;
		const sessionManager = SessionManager.create(
			baseline.cwd,
			this.#sessionFactory.workflowSessionDirectory(),
		);
		const agentId = sessionManager.getSessionId();
		const prepared = await this.#sessionFactory.prepareModeratorRun(agentId, baseline);
		if (!this.#conditionRemains(handling.snapshot)) {
			this.#handlingByKey.delete(handling.snapshot.key);
			return;
		}

		const metadata = resolveModeratorAgentMetadata(handling.snapshot.kind);
		const identity: ModeratorIdentity = {
			agentId,
			workflowId: this.#ownerIdentity.workflowId,
			directSpawnerAgentId: null,
			configuration: { ...metadata, baseline },
		};
		const input: ModeratorInput = {
			trigger: this.#triggerFor(handling.snapshot),
			inspectedThrough: handling.snapshot.inspectedThrough,
			...(handling.previousAttempt === undefined
				? {}
				: { previousAttempt: handling.previousAttempt }),
		};
		if (
			this.#boundaryHooks.beforeModeratorBootstrapCommit?.() ===
			"confirmed_failure"
		) {
			throw new Error("Confirmed Moderator bootstrap commit failure");
		}
		const modelInput = createModelVisibleModeratorInput(identity, input);
		sessionManager.appendCustomMessageEntry(
			modelInput.customType,
			modelInput.content,
			modelInput.display,
			modelInput.details,
		);
		persistCommittedInput(sessionManager);
		validateCommittedModeratorInput({ sessionManager, identity, input });
		handling.moderatorAgentId = agentId;
		handling.committedAttemptCount += 1;
		this.#attemptByModeratorAgentId.set(agentId, handling.snapshot);

		const moderator = this.#sessionFactory.createModeratorRecord({
			identity,
			sessionManager,
			firstPrepared: prepared,
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
				const session = await moderator.host.startInLane(["moderator_handling"]);
				moderator.host.trackOperation(continueFromCommittedInput(session));
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
		}
	}

	#attentionFor(handling: OperationalIncidentHandling): OperationalIncidentAttention {
		return {
			trigger: this.#triggerFor(handling.snapshot),
			affectedAgentIds: [...handling.snapshot.affectedAgentIds],
			diagnostics: [...handling.diagnostics],
		};
	}

	#triggerFor(snapshot: OperationalConditionSnapshot): ModeratorTrigger {
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
			run.attention === "none" &&
			!record.host.currentRunFailed() &&
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
		if (handling.exhausted) this.#presentation.dismiss(key);
		if (!handling.moderatorAgentId) return;
		this.#agents
			.get(handling.moderatorAgentId)
			?.host.removeRetentionReason("moderator_handling");
	}
}
