import type {
	AgentSessionRuntime,
	ExtensionFactory,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { dirname, resolve } from "node:path";

import {
	requireAgentRecord,
	requireLiveServices,
	statusOf,
	type AgentRecord,
	type AgentStatus,
} from "./agent-record.ts";
import {
	DefaultChildSpawner,
	type AgentSpawnInput,
	type AgentSpawnReceipt,
	type SpawnBoundaryHooks,
} from "./spawning.ts";
import {
	MessageCoordinator,
	type AgentMessageInput,
	type AgentMessageReceipt,
	type MessageBoundaryHooks,
} from "./messages.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import {
	isRuntimeThinkingLevel,
	type ModelReference,
	type RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";
import { InProcessAgentHost } from "../runtime/in-process-agent-host.ts";
import {
	DefaultChildSessionFactory,
} from "../runtime/default-child-session-factory.ts";
import {
	HumanRequestCoordinator,
	type GuardedHumanToolResult,
	type HumanAttentionItem,
	type HumanRequestBoundaryHooks,
} from "./human-requests.ts";
import type {
	HumanAnswerCandidate,
	HumanRequestInput,
} from "../protocol/human-request.ts";
import { RunSupervisor } from "./run-supervision.ts";
import type {
	RunControlInput,
	RunControlReceipt,
} from "../protocol/run-control.ts";
import { SerialLane } from "../runtime/serial-lane.ts";
import type { AgentTemplateRoot } from "../templates/agent-templates.ts";
import { WorkflowPolicyStore } from "../policy/workflow-policy.ts";
import {
	WorkflowExecutionScheduler,
	type WorkflowExecutionPermit,
} from "./workflow-execution-scheduler.ts";
import type { ColdWorkflowRecovery } from "../bootstrap/cold-host-discovery.ts";
import { piSessionRecency } from "../pi-integration/session-recency.ts";
import {
	OperationalIncidentCoordinator,
	type OperationalIncidentBoundaryHooks,
	type OperationalIncidentAttention,
	type OperationalIncidentPresentation,
} from "./operational-incidents.ts";
import type {
	ModeratorControlInput,
	ModeratorControlReceipt,
} from "../protocol/moderator-control.ts";
import { isModeratorIdentity } from "../protocol/moderator-input.ts";
import type { OperationReviewClock } from "./operation-review.ts";
import {
	configureCoordinatedSession,
	type AutomaticGenerationReconciliationAdapter,
} from "../pi-integration/automatic-reconciliation.ts";
import { createAgentActivityExtension } from "../bootstrap/agent-extension.ts";
import type {
	AgentActivitySnapshot,
	AgentActivityStatus,
} from "../presentation/agent-activity-surface.ts";
import type {
	PiNativeAgentProjection,
	PiNativeProjectionHost,
} from "../pi-integration/native-agent-projection.ts";
import type { DurableAgentView } from "../presentation/agent-view-surface.ts";
import { DurableAgentViewAttachment } from "./durable-agent-view.ts";

export type { AgentStatus } from "./agent-record.ts";
export type AgentRosterStatus = AgentStatus & Readonly<{
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
	queuedInputCount: number;
}>;
export type {
	AgentSpawnInput,
	AgentSpawnReceipt,
	SpawnBoundaryHooks,
} from "./spawning.ts";
export type {
	AgentMessageInput,
	AgentMessageReceipt,
	MessageBoundaryHooks,
} from "./messages.ts";

export type HumanPresentationCoordinatorView = Readonly<{
	status(agentId?: string): AgentStatus;
	agentActivity(): AgentActivitySnapshot;
	addAgentActivityChangeHandler(handler: () => void): () => void;
	refreshAgentActivity(): void;
	resumeFromHuman(
		text: string,
		images: readonly ImageContent[] | undefined,
	): Promise<boolean>;
	selectionRoster(): Readonly<{
		live: readonly AgentRosterStatus[];
		dormant: readonly AgentRosterStatus[];
	}>;
	openAgentView(agentId: string): Promise<DurableAgentView | undefined>;
	focusHumanAnswer(agentId: string, requestId: string): Promise<void>;
	humanAttention(): readonly HumanAttentionItem[];
	operationalAttention(): readonly OperationalIncidentAttention[];
}>;

type ActiveDurableAgentView = {
	record: AgentRecord;
	attachment: DurableAgentViewAttachment;
	failed: boolean;
};

type AgentViewTarget = Readonly<{
	projection: PiNativeAgentProjection;
	retryIfChanged: boolean;
}>;

type AgentCoordinatorView = HumanPresentationCoordinatorView & Readonly<{
	children(agentId?: string): readonly AgentStatus[];
	message(toolCallId: string, input: AgentMessageInput): Promise<AgentMessageReceipt>;
	control(toolCallId: string, input: RunControlInput): Promise<RunControlReceipt>;
	askHuman(
		toolCallId: string,
		input: HumanRequestInput,
		signal: AbortSignal | undefined,
	): Promise<HumanAnswerCandidate>;
	guardHumanToolResult(
		message: MessageEndEvent["message"],
	): GuardedHumanToolResult | undefined;
	reconcileHumanToolResults(): void;
	reachSafeBoundary(): Promise<void>;
	beginExecution(): Promise<void>;
	ensureExecution(): Promise<void>;
	beginToolExecution(toolCallId: string, toolName: string): void;
	reconcileCommittedToolResults(): void;
	endExecution(): void;
}>;

export type OrdinaryAgentCoordinatorView = AgentCoordinatorView & Readonly<{
	spawn(toolCallId: string, input: AgentSpawnInput): Promise<AgentSpawnReceipt>;
}>;

export type ModeratorAgentCoordinatorView = AgentCoordinatorView & Readonly<{
	moderatorControl(
		toolCallId: string,
		input: ModeratorControlInput,
	): Promise<ModeratorControlReceipt>;
}>;

export class WorkflowCoordinator {
	readonly #ownerIdentity: OwnerIdentity;
	readonly #agents = new Map<string, AgentRecord>();
	readonly #spawner: DefaultChildSpawner;
	readonly #sessionFactory: DefaultChildSessionFactory;
	readonly #messages: MessageCoordinator;
	readonly #humanRequests: HumanRequestCoordinator;
	readonly #runSupervisor: RunSupervisor;
	readonly #operationalIncidents: OperationalIncidentCoordinator;
	readonly #agentActivityChangeHandlers = new Set<() => void>();
	readonly #agentViewLane = new SerialLane();
	#activeAgentView: ActiveDurableAgentView | undefined;
	readonly #workflowPolicy: WorkflowPolicyStore;
	readonly #executionScheduler: WorkflowExecutionScheduler;
	readonly #executionPermits = new Map<string, WorkflowExecutionPermit>();
	readonly #quarantinedAgentIds: ReadonlySet<string>;
	readonly #agentIdBySpawnSource: Map<string, string>;
	#shutdownPromise: Promise<void> | undefined;
	#shuttingDown = false;

	constructor(
		runtime: AgentSessionRuntime,
		identity: OwnerIdentity,
		options: {
			entryModulePath: string;
			packageRoot?: string;
			templateRoots?(
				baselineCwd: string,
				projectTrusted: boolean,
			): readonly AgentTemplateRoot[];
			childExtensionFactory(agentId: string): ExtensionFactory;
			moderatorExtensionFactory(agentId: string): ExtensionFactory;
			spawnBoundaryHooks?: SpawnBoundaryHooks;
			messageBoundaryHooks?: MessageBoundaryHooks;
			incidentBoundaryHooks?: OperationalIncidentBoundaryHooks;
			operationalIncidentPresentation?: OperationalIncidentPresentation;
			operationReviewClock?: OperationReviewClock;
			automaticGenerationReconciliation?: AutomaticGenerationReconciliationAdapter;
			workflowPolicy?: WorkflowPolicyStore;
			recoveredWorkflow?: ColdWorkflowRecovery;
			humanRequestBoundaryHooks?: HumanRequestBoundaryHooks;
			projectionHost?: PiNativeProjectionHost;
		},
	) {
		this.#quarantinedAgentIds = options.recoveredWorkflow?.quarantinedAgentIds ?? new Set();
		this.#agentIdBySpawnSource = new Map(
			options.recoveredWorkflow?.agentIdBySpawnSource ?? [],
		);
		this.#workflowPolicy = options.workflowPolicy ?? new WorkflowPolicyStore();
		this.#executionScheduler = new WorkflowExecutionScheduler(this.#workflowPolicy);
		this.#ownerIdentity = identity;
		configureCoordinatedSession(
			runtime.session,
			options.automaticGenerationReconciliation,
		);
		this.#agents.set(identity.agentId, {
			identity,
			services: runtime.services,
			host: InProcessAgentHost.bindOwner(runtime),
			children: [],
		});
		const sessionFactory = new DefaultChildSessionFactory({
			ownerRuntime: runtime,
			ownerIdentity: identity,
			entryModulePath: options.entryModulePath,
			packageRoot: options.packageRoot ?? resolve(dirname(options.entryModulePath), ".."),
			templateRoots: options.templateRoots,
			childExtensionFactory: options.childExtensionFactory,
			moderatorExtensionFactory: options.moderatorExtensionFactory,
			activityExtensionFactory: (agentId) =>
				createAgentActivityExtension(() => this.#agentView(agentId)),
			projectionHost: options.projectionHost,
			automaticGenerationReconciliation:
				options.automaticGenerationReconciliation,
		});
		this.#sessionFactory = sessionFactory;
		for (const recovered of options.recoveredWorkflow?.agents ?? []) {
			if (
				options.recoveredWorkflow?.transcriptPathByAgentId.get(
					recovered.identity.agentId,
				) !== recovered.sessionManager.getSessionFile()
			) {
				throw new Error(
					`invariant_violation: recovered Agent ${recovered.identity.agentId} has inconsistent transcript location`,
				);
			}
			const record = recovered.role === "moderator"
				? sessionFactory.createModeratorRecord({
					identity: recovered.identity,
					sessionManager: recovered.sessionManager,
				})
				: sessionFactory.createAgentRecord({
					identity: recovered.identity,
					sessionManager: recovered.sessionManager,
					blueprint: {
						baseline: recovered.identity.configuration.baseline,
						spawnInput: recovered.spawnInput,
					},
				});
			this.#agents.set(recovered.identity.agentId, record);
			if (recovered.role === "moderator") continue;
			const parent = this.#agents.get(recovered.identity.directSpawnerAgentId);
			if (!parent) {
				throw new Error(
					`invariant_violation: recovered Agent ${recovered.identity.agentId} has no verified Direct Spawner`,
				);
			}
			parent.children.push(recovered.identity.agentId);
		}
		this.#messages = new MessageCoordinator({
			agents: this.#agents,
			quarantinedAgentIds: this.#quarantinedAgentIds,
			isShuttingDown: () => this.#shuttingDown,
			boundaryHooks: options.messageBoundaryHooks,
			workflowPolicy: this.#workflowPolicy,
		});
		this.#humanRequests = new HumanRequestCoordinator({
			agents: this.#agents,
			ownerIdentity: identity,
			boundaryHooks: options.humanRequestBoundaryHooks,
			interruptRun: (record) => {
				record.host.prepareInterruption();
				void record.host.lane.run(async () => {
					this.#messages.prepareInterruptionInLane(record);
					await record.host.interruptCurrentRunInLane();
				});
			},
			suspendExecution: (record) => {
				this.#releaseExecution(record.identity.agentId);
			},
			beginHumanWaiting: (source) => {
				this.#operationalIncidents.beginHumanWaiting(source);
			},
			beginHumanResultCommit: (source) => {
				this.#operationalIncidents.beginHumanResultCommit(source);
			},
			onAttentionChanged: () => this.#notifyAgentActivityChanged(),
		});
		this.#runSupervisor = new RunSupervisor({
			agents: this.#agents,
			quarantinedAgentIds: this.#quarantinedAgentIds,
			ownerAgentId: identity.agentId,
			messages: this.#messages,
			isInteractivelySelected: (agentId) => this.#isInteractivelySelected(agentId),
		});
		this.#operationalIncidents = new OperationalIncidentCoordinator({
			agents: this.#agents,
			ownerIdentity: identity,
			sessionFactory,
			messages: this.#messages,
			workflowPolicy: this.#workflowPolicy,
			integrateAgent: (record) => this.#integrateAgent(record),
			isShuttingDown: () => this.#shuttingDown,
			reportError: (error) => {
				runtime.services.diagnostics.push({
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			},
			boundaryHooks: options.incidentBoundaryHooks,
			presentation: options.operationalIncidentPresentation,
			operationReviewClock: options.operationReviewClock,
			onAttentionChanged: () => this.#notifyAgentActivityChanged(),
		});
		for (const record of this.#agents.values()) this.#integrateAgent(record);
		this.#spawner = new DefaultChildSpawner({
			agents: this.#agents,
			agentIdBySpawnSource: this.#agentIdBySpawnSource,
			sessionFactory,
			messages: this.#messages,
			integrateAgent: (record) => this.#integrateAgent(record),
			boundaryHooks: options.spawnBoundaryHooks,
			isShuttingDown: () => this.#shuttingDown,
		});
	}

	forAgent(agentId: string): OrdinaryAgentCoordinatorView {
		this.#requireAgent(agentId);
		return Object.freeze({
			...this.#agentView(agentId),
			spawn: (toolCallId, input) => this.#spawner.spawn(agentId, toolCallId, input),
		});
	}

	forModerator(agentId: string): ModeratorAgentCoordinatorView {
		this.#requireModerator(agentId);
		return Object.freeze({
			...this.#agentView(agentId),
			moderatorControl: (toolCallId, input) => {
				this.#assertAdmissionOpen();
				return this.#operationalIncidents.executeModeratorControl(
					agentId,
					toolCallId,
					input,
				);
			},
		});
	}

	#agentView(agentId: string): AgentCoordinatorView {
		return {
			status: (targetAgentId?: string) => this.#statusFor(agentId, targetAgentId),
			agentActivity: () => this.#agentActivity(agentId),
			addAgentActivityChangeHandler: (handler) => {
				this.#agentActivityChangeHandlers.add(handler);
				return () => this.#agentActivityChangeHandlers.delete(handler);
			},
			refreshAgentActivity: () => this.#notifyAgentActivityChanged(),
			children: (targetAgentId?: string) => this.#childrenFor(agentId, targetAgentId),
			message: (toolCallId, input) => this.#messages.execute(agentId, toolCallId, input),
			control: (toolCallId, input) => {
				this.#assertAdmissionOpen();
				return this.#runSupervisor.execute(agentId, toolCallId, input);
			},
			resumeFromHuman: (text, images) => {
				this.#assertAdmissionOpen();
				return this.#handleHumanInput(agentId, text, images);
			},
			selectionRoster: () => this.#selectionRoster(),
			openAgentView: (targetAgentId) => {
				this.#assertAdmissionOpen();
				return this.#openAgentView(targetAgentId);
			},
			focusHumanAnswer: (targetAgentId, requestId) => {
				this.#assertAdmissionOpen();
				return this.#focusHumanAnswer(targetAgentId, requestId);
			},
			askHuman: (toolCallId, input, signal) => {
				this.#assertAdmissionOpen();
				return this.#humanRequests.ask(agentId, toolCallId, input, signal);
			},
			guardHumanToolResult: (message) =>
				this.#humanRequests.guardResultCommit(agentId, message),
			reconcileHumanToolResults: () =>
				this.#humanRequests.reconcileCommittedResults(agentId),
			// These surfaces belong to the human Workflow Owner even while a child
			// Runtime supplies the selected interactive mode.
			humanAttention: () =>
				this.#humanRequests.attentionItems(this.#ownerIdentity.agentId),
			operationalAttention: () =>
				this.#operationalIncidents.attentionItems(this.#ownerIdentity.agentId),
			reachSafeBoundary: async () => {
				this.#operationalIncidents.reconcileCommittedToolResults(agentId);
				await this.#messages.reachSafeBoundary(agentId);
				await this.#operationalIncidents.reachSafeBoundary();
			},
			beginExecution: () => this.#beginExecution(agentId),
			ensureExecution: () => this.#ensureExecution(agentId),
			beginToolExecution: (toolCallId, toolName) => {
				this.#assertAdmissionOpen();
				this.#operationalIncidents.admitToolExecution(
					agentId,
					toolCallId,
					toolName,
				);
			},
			reconcileCommittedToolResults: () =>
				this.#operationalIncidents.reconcileCommittedToolResults(agentId),
			endExecution: () => this.#releaseExecution(agentId),
		};
	}

	shutdown(disposeNativeRuntime: () => Promise<void>): Promise<void> {
		this.#shuttingDown = true;
		this.#shutdownPromise ??= this.#shutdown(disposeNativeRuntime);
		return this.#shutdownPromise;
	}

	#assertAdmissionOpen(): void {
		if (this.#shuttingDown) {
			throw new Error("host_shutting_down: Workflow is shutting down");
		}
	}

	#statusFor(callerAgentId: string, targetAgentId = callerAgentId): AgentStatus {
		return statusOf(this.#requireObservable(callerAgentId, targetAgentId));
	}

	#childrenFor(callerAgentId: string, targetAgentId = callerAgentId): readonly AgentStatus[] {
		if (
			targetAgentId !== callerAgentId &&
			callerAgentId !== this.#ownerIdentity.agentId &&
			!this.#isModerator(callerAgentId)
		) {
			throw new Error(
				`unauthorized: Agent ${callerAgentId} cannot enumerate children of ${targetAgentId}`,
			);
		}
		const target = this.#requireObservable(callerAgentId, targetAgentId);
		return target.children.map((agentId) => statusOf(this.#requireAgent(agentId)));
	}

	#requireObservable(callerAgentId: string, targetAgentId: string): AgentRecord {
		const caller = this.#requireAgent(callerAgentId);
		const target = this.#requireAgent(targetAgentId);
		if (
			targetAgentId !== callerAgentId &&
			callerAgentId !== this.#ownerIdentity.agentId &&
			!this.#isModerator(callerAgentId) &&
			target.identity.directSpawnerAgentId !== caller.identity.agentId
		) {
			throw new Error(`unauthorized: Agent ${callerAgentId} cannot observe ${targetAgentId}`);
		}
		return target;
	}

	#selectionRoster(): Readonly<{
		live: readonly AgentRosterStatus[];
		dormant: readonly AgentRosterStatus[];
	}> {
		const authorityOrder: AgentRecord[] = [];
		const appendAuthoritySubtree = (agentId: string) => {
			const record = this.#requireAgent(agentId);
			authorityOrder.push(record);
			for (const childId of record.children) appendAuthoritySubtree(childId);
		};
		appendAuthoritySubtree(this.#ownerIdentity.agentId);
		for (const record of this.#agents.values()) {
			if (!authorityOrder.includes(record)) authorityOrder.push(record);
		}
		const live: AgentRosterStatus[] = [];
		const dormant: Array<{ status: AgentRosterStatus; recency: number; order: number }> = [];
		for (const [order, record] of authorityOrder.entries()) {
			const status = this.#rosterStatus(record);
			if (status.run.phase !== "dormant") {
				live.push(status);
				continue;
			}
			const header = record.host.sessionManager.getHeader();
			if (!header) {
				throw new Error(
					`invariant_violation: Agent ${record.identity.agentId} has no Pi session header`,
				);
			}
			dormant.push({
				status,
				recency: piSessionRecency(header, record.host.sessionManager.getEntries()),
				order,
			});
		}
		dormant.sort(
			(left, right) => right.recency - left.recency || left.order - right.order,
		);
		return {
			live,
			dormant: dormant.map(({ status }) => status),
		};
	}

	#rosterStatus(record: AgentRecord): AgentRosterStatus {
		const status = statusOf(record);
		const liveSession = record.host.currentHandle()
			? record.host.requireLiveSession()
			: undefined;
		const transcriptContext = record.host.sessionManager.buildSessionContext();
		const configured = record.effectiveConfiguration ?? record.identity.configuration.baseline;
		const model = liveSession?.model
			? { provider: liveSession.model.provider, modelId: liveSession.model.id }
			: transcriptContext.model ?? configured.model;
		const hasRecordedThinking = record.host.sessionManager.getBranch().some(
			(entry) => entry.type === "thinking_level_change",
		);
		const thinking = liveSession?.thinkingLevel ??
			(hasRecordedThinking ? transcriptContext.thinkingLevel : configured.thinking);
		if (!isRuntimeThinkingLevel(thinking)) {
			throw new Error(`invariant_violation: Agent ${status.agentId} has invalid thinking level`);
		}
		return {
			...status,
			model,
			thinking,
			queuedInputCount: record.host.queuedInputCount(),
		};
	}

	#agentActivity(agentId: string): AgentActivitySnapshot {
		const record = this.#requireAgent(agentId);
		const ownerScope = agentId === this.#ownerIdentity.agentId;
		return {
			scope: this.#agentActivityStatus(record),
			children: record.children.map((childId) =>
				this.#agentActivityStatus(this.#requireAgent(childId))
			),
			answerMode: this.#humanRequests.hasPendingRequest(agentId),
			humanAttention: ownerScope
				? this.#humanRequests.attentionItems(this.#ownerIdentity.agentId)
				: [],
			operationalAttention: ownerScope
				? this.#operationalIncidents.attentionItems(this.#ownerIdentity.agentId)
				: [],
		};
	}

	#agentActivityStatus(record: AgentRecord): AgentActivityStatus {
		const activeView = this.#activeAgentView;
		return {
			...this.#rosterStatus(record),
			failed: record.host.currentRunFailed() || (
				activeView?.record === record && activeView.failed
			),
		};
	}

	#notifyAgentActivityChanged(): void {
		for (const handler of this.#agentActivityChangeHandlers) handler();
	}

	#requireAgent(agentId: string): AgentRecord {
		return requireAgentRecord(
			this.#agents,
			this.#quarantinedAgentIds,
			agentId,
		);
	}

	#requireModerator(agentId: string): AgentRecord {
		const record = this.#requireAgent(agentId);
		if (!this.#isModerator(agentId)) {
			throw new Error(`unauthorized: Agent ${agentId} is not a Moderator`);
		}
		return record;
	}

	#isModerator(agentId: string): boolean {
		const identity = this.#agents.get(agentId)?.identity;
		return identity !== undefined && isModeratorIdentity(identity);
	}

	#integrateAgent(record: AgentRecord): void {
		record.host.addStateChangeHandler(() => this.#notifyAgentActivityChanged());
		record.host.addSettledHandler(() => this.#notifyAgentActivityChanged());
		record.host.setRunStartedHandler(async () => {
			await this.#bindViewedRunInLane(record);
		});
		record.host.setRunEndingHandler(async (session, _handle, cause) => {
			await this.#markViewedFailedRunInLane(record, session, cause);
		});
		this.#messages.integrate(record);
		this.#operationalIncidents.integrate(record);
		this.#notifyAgentActivityChanged();
	}

	#openAgentView(agentId: string): Promise<DurableAgentView | undefined> {
		return this.#agentViewLane.run(async () => {
			if (agentId === this.#ownerIdentity.agentId) {
				const active = this.#activeAgentView;
				if (active) await this.#closeActiveAgentViewInLane(active);
				return undefined;
			}
			const active = this.#activeAgentView;
			if (active?.record.identity.agentId === agentId) return undefined;
			const record = this.#requireAgent(agentId);
			if (active) {
				await this.#switchActiveAgentViewInLane(active, record);
				return undefined;
			}
			const target = await this.#acquireAgentViewTarget(record);
			let attachment!: DurableAgentViewAttachment;
			attachment = new DurableAgentViewAttachment({
				agentId,
				label: record.identity.configuration.label,
				projection: target.projection,
				requestClose: () => this.#closeAgentView(attachment),
				reportFailure: (error) => this.#reportAgentViewError(error),
			});
			this.#activeAgentView = {
				record,
				attachment,
				failed: false,
			};
			this.#notifyAgentActivityChanged();
			return attachment;
		});
	}

	async #acquireAgentViewTarget(record: AgentRecord): Promise<AgentViewTarget> {
		const phase = record.host.observe().phase;
		if (phase === "starting") {
			const initializingProjection = await waitForInitializingProjection(record);
			if (initializingProjection) {
				// Run startup deliberately waits for session_start UI. Entering its lane
				// here would deadlock the only human surface that can settle a startup
				// modal. The exact bound Run cannot change during these synchronous steps.
				record.host.addRetentionReason("interactive_selection");
				return { projection: initializingProjection, retryIfChanged: false };
			}
		}
		if (phase === "dormant" && !record.host.currentProjection()) {
			return this.#prepareAgentViewTarget(record);
		}
		return record.host.lane.run(() => this.#acquireAgentViewTargetInLane(record));
	}

	async #prepareAgentViewTarget(record: AgentRecord): Promise<AgentViewTarget> {
		const preparation = record.host.lane.run(() => {
			if (record.host.currentProjection()) {
				record.host.addRetentionReason("interactive_selection");
				return record.host.requirePreparedSession();
			}
			return record.host.prepareInLane(["interactive_selection"]);
		});
		// Preparation can pause in session_start UI. Attach the published projection
		// without waiting behind the modal that this view must let the human settle.
		const projection = await waitForStartupProjection(record, preparation);
		// Readiness continues after publication because session_start UI may need the
		// attached view. If it later fails, close only that exact unusable attachment.
		void preparation.catch((error) => {
			void this.#agentViewLane.run(async () => {
				const active = this.#activeAgentView;
				if (
					!active ||
					active.record !== record ||
					active.attachment.projection() !== projection
				) return;
				this.#reportAgentViewError(error);
				await this.#closeActiveAgentViewInLane(active);
			}).catch((cleanupError) => this.#reportAgentViewError(cleanupError));
		});
		record.host.addRetentionReason("interactive_selection");
		return { projection, retryIfChanged: false };
	}

	async #acquireAgentViewTargetInLane(record: AgentRecord): Promise<AgentViewTarget> {
		record.host.addRetentionReason("interactive_selection");
		const projection = record.host.currentProjection();
		if (projection) return { projection, retryIfChanged: true };
		record.host.removeRetentionReason("interactive_selection");
		throw new Error(
			`invariant_violation: live Agent ${record.identity.agentId} has no presentation projection`,
		);
	}

	async #switchActiveAgentViewInLane(
		active: ActiveDurableAgentView,
		record: AgentRecord,
	): Promise<void> {
		while (true) {
			const target = await this.#acquireAgentViewTarget(record);
			const previousRecord = active.record;
			let requestPreviousRunRelease = false;
			let targetChanged = false;
			await previousRecord.host.lane.run(() => {
				targetChanged = record.host.currentProjection() !== target.projection;
				if (targetChanged) return;
				if (
					previousRecord.host.currentProjection() === active.attachment.projection()
				) {
					previousRecord.host.removeRetentionReason("interactive_selection");
					requestPreviousRunRelease = true;
				}
				active.record = record;
				active.failed = false;
				active.attachment.retarget({
					agentId: record.identity.agentId,
					label: record.identity.configuration.label,
					projection: target.projection,
				});
			});
			if (targetChanged) {
				await this.#releaseUnpublishedAgentViewTarget(record, target);
				if (!target.retryIfChanged) {
					throw new Error(
						`stale_run: selected Agent ${record.identity.agentId} changed during view preparation`,
					);
				}
				continue;
			}
			if (requestPreviousRunRelease) {
				try {
					await this.#messages.requestRelease(previousRecord);
				} catch (error) {
					this.#reportAgentViewError(error);
				}
			}
			this.#notifyAgentActivityChanged();
			return;
		}
	}

	async #releaseUnpublishedAgentViewTarget(
		record: AgentRecord,
		_target: AgentViewTarget,
	): Promise<void> {
		await record.host.lane.run(() => {
			record.host.removeRetentionReason("interactive_selection");
		});
		await this.#messages.requestRelease(record);
	}

	#closeAgentView(attachment: DurableAgentViewAttachment): Promise<void> {
		return this.#agentViewLane.run(async () => {
			const active = this.#activeAgentView;
			if (!active || active.attachment !== attachment) {
				attachment.settleClosed();
				return;
			}
			await this.#closeActiveAgentViewInLane(active);
		});
	}

	async #closeActiveAgentViewInLane(active: ActiveDurableAgentView): Promise<void> {
		const cleanupErrors: unknown[] = [];
		let requestRunRelease = false;
		await collectCleanupFailure(
			cleanupErrors,
			() => active.record.host.cancelRuntimeInitialization(
				active.attachment.projection(),
				new Error("Agent view closed during Runtime initialization"),
			),
		);
		await active.record.host.lane.run(async () => {
			if (this.#activeAgentView !== active) return;
			this.#activeAgentView = undefined;
			if (
				active.record.host.currentProjection() === active.attachment.projection()
			) {
				active.record.host.removeRetentionReason("interactive_selection");
				requestRunRelease = true;
			}
			active.attachment.settleClosed();
		});
		if (requestRunRelease) {
			try {
				await this.#messages.requestRelease(active.record);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Agent view cleanup failed");
		}
	}

	async #bindViewedRunInLane(record: AgentRecord): Promise<void> {
		const active = this.#activeAgentView;
		if (!active || active.record !== record) return;
		const projection = record.host.currentProjection();
		if (!projection) {
			throw new Error(
				`invariant_violation: viewed Agent ${record.identity.agentId} started without a projection`,
			);
		}
		if (active.attachment.projection() !== projection) {
			throw new Error(
				`invariant_violation: viewed Agent ${record.identity.agentId} changed Runtime projection during Run admission`,
			);
		}
		record.host.addRetentionReason("interactive_selection");
		active.failed = false;
		this.#notifyAgentActivityChanged();
	}

	async #markViewedFailedRunInLane(
		record: AgentRecord,
		session: AgentSessionRuntime["session"],
		cause: "failure" | "termination" | "shutdown",
	): Promise<void> {
		const active = this.#activeAgentView;
		if (
			cause !== "failure" ||
			!active ||
			active.record !== record ||
			record.host.requireLiveSession() !== session ||
			record.host.currentProjection() !== active.attachment.projection()
		) return;
		if (record.host.observe().phase === "starting") {
			this.#activeAgentView = undefined;
			active.attachment.settleClosed();
			this.#notifyAgentActivityChanged();
			return;
		}
		active.failed = true;
		this.#notifyAgentActivityChanged();
	}

	#reportAgentViewError(error: unknown): void {
		const owner = this.#requireAgent(this.#ownerIdentity.agentId);
		requireLiveServices(owner).diagnostics.push({
			type: "error",
			message: `Agent view failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	}

	#focusHumanAnswer(agentId: string, requestId: string): Promise<void> {
		return this.#agentViewLane.run(() => {
			if (!this.#humanRequests.hasPendingRequest(agentId, requestId)) {
				throw new Error("stale_request: Human Request is no longer pending");
			}
			const active = this.#activeAgentView;
			if (!active || active.record.identity.agentId !== agentId) {
				throw new Error(
					`invariant_violation: Human Request Agent ${agentId} is not selected`,
				);
			}
			active.attachment.projection().focusEditor();
		});
	}

	#isInteractivelySelected(agentId: string): boolean {
		return this.#activeAgentView?.record.identity.agentId === agentId;
	}

	async #beginExecution(agentId: string): Promise<void> {
		this.#assertAdmissionOpen();
		if (this.#executionPermits.has(agentId)) {
			throw new Error(
				`invariant_violation: Agent ${agentId} execution already holds Workflow capacity`,
			);
		}
		const record = this.#requireAgent(agentId);
		if (!record.host.currentHandle()) {
			await record.host.lane.run(() => record.host.startInLane());
		}
		await this.#ensureExecution(agentId);
		this.#assertAdmissionOpen();
		this.#operationalIncidents.beginExecution(agentId);
	}

	async #ensureExecution(agentId: string): Promise<void> {
		this.#assertAdmissionOpen();
		if (this.#executionPermits.has(agentId)) return;
		const record = this.#requireAgent(agentId);
		const run = record.host.observe();
		if (run.phase !== "live" || run.attention === "input_required") return;
		const permit = await this.#executionScheduler.admit(
			this.#isModerator(agentId) ? "moderator" : "ordinary",
			record.host.requireLiveSession().agent.signal,
		);
		if (!permit) return;
		if (this.#shuttingDown) {
			permit.release();
			this.#assertAdmissionOpen();
		}
		this.#executionPermits.set(agentId, permit);
	}

	#releaseExecution(agentId: string): void {
		const permit = this.#executionPermits.get(agentId);
		if (!permit) return;
		this.#executionPermits.delete(agentId);
		permit.release();
	}

	#handleHumanInput(
		agentId: string,
		text: string,
		images: readonly ImageContent[] | undefined,
	): Promise<boolean> {
		if (this.#humanRequests.submitAnswer(agentId, text, (images?.length ?? 0) > 0)) {
			return Promise.resolve(true);
		}
		return this.#agentViewLane.run(async () => {
			const active = this.#activeAgentView;
			if (!active || active.record.identity.agentId !== agentId) {
				return this.#runSupervisor.resumeFromHuman(agentId, text, images);
			}
			return active.record.host.lane.run(async () => {
				if (this.#activeAgentView !== active) return true;
				const currentSession = active.record.host.currentHandle()
					? active.record.host.requireLiveSession()
					: undefined;
				if (
					currentSession &&
					active.attachment.projection() === active.record.host.currentProjection()
				) {
					if (active.record.host.currentInterruptionHold()) {
						return this.#runSupervisor.resumeFromHumanInLane(
							active.record,
							text,
							images,
						);
					}
					return false;
				}
				if (!currentSession) {
					await active.record.host.startInLane(["interactive_selection"]);
				}
				await this.#runSupervisor.submitFromHumanInLane(active.record, text, images);
				return true;
			});
		});
	}

	async #shutdown(disposeNativeRuntime: () => Promise<void>): Promise<void> {
		const cleanupErrors: unknown[] = [];
		const children = [...this.#agents.values()].filter(
			(record) => record.identity.agentId !== this.#ownerIdentity.agentId,
		);
		// Fence queued starts before awaiting any lane. A start already preparing its
		// projection observes the same fence immediately after binding and cancels there.
		collectSettledCleanupFailures(cleanupErrors, await Promise.allSettled(
			children.map((record) => record.host.beginShutdown()),
		));
		await collectCleanupFailure(
			cleanupErrors,
			() => this.#activeAgentView?.attachment.close(),
		);
		await collectCleanupFailure(
			cleanupErrors,
			() => this.#operationalIncidents.shutdown(),
		);
		collectSettledCleanupFailures(cleanupErrors, await Promise.allSettled(
			children.map((record) =>
				record.host.lane.run(() => this.#shutdownAgentInLane(record)),
			),
		));
		const owner = this.#requireAgent(this.#ownerIdentity.agentId);
		await collectCleanupFailure(
			cleanupErrors,
			() => owner.host.lane.run(() =>
				this.#shutdownAgentInLane(owner, disposeNativeRuntime)
			),
		);
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Workflow shutdown failed");
		}
	}

	async #shutdownAgentInLane(
		record: AgentRecord,
		disposeRun?: () => Promise<void>,
	): Promise<void> {
		const cleanupErrors: unknown[] = [];
		// Discard volatile delivery work before ending the host so no queued work
		// can outlive the Run whose transcript would receive it.
		await collectCleanupFailure(
			cleanupErrors,
			() => this.#messages.discardSchedulingInLane(record),
		);
		await collectCleanupFailure(
			cleanupErrors,
			() => record.host.discardAndEndInLane("shutdown", disposeRun),
		);
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Agent shutdown failed");
		}
	}

}

function waitForInitializingProjection(
	record: AgentRecord,
): Promise<PiNativeAgentProjection | undefined> {
	const current = record.host.currentProjection();
	if (current || record.host.observe().phase !== "starting") {
		return Promise.resolve(current);
	}
	return new Promise((resolve) => {
		const removeHandler = record.host.addStateChangeHandler(() => {
			const projection = record.host.currentProjection();
			if (!projection && record.host.observe().phase === "starting") return;
			removeHandler();
			resolve(projection);
		});
	});
}

function waitForStartupProjection(
	record: AgentRecord,
	startup: Promise<unknown>,
): Promise<PiNativeAgentProjection> {
	const current = record.host.currentProjection();
	if (current) return Promise.resolve(current);
	return new Promise((resolve, reject) => {
		let settled = false;
		let removeHandler: () => void = () => undefined;
		const settle = (
			result: { projection: PiNativeAgentProjection } | { error: unknown },
		) => {
			if (settled) return;
			settled = true;
			removeHandler();
			if ("projection" in result) resolve(result.projection);
			else reject(result.error);
		};
		const inspectProjection = () => {
			const projection = record.host.currentProjection();
			if (projection) settle({ projection });
		};
		removeHandler = record.host.addStateChangeHandler(inspectProjection);
		inspectProjection();
		void startup.then(
			() => {
				const projection = record.host.currentProjection();
				if (projection) settle({ projection });
				else {
					settle({
						error: new Error(
							`invariant_violation: selected Agent ${record.identity.agentId} prepared without a presentation projection`,
						),
					});
				}
			},
			(error) => settle({ error }),
		);
	});
}

async function collectCleanupFailure(
	errors: unknown[],
	cleanup: () => unknown | Promise<unknown>,
): Promise<void> {
	try {
		await cleanup();
	} catch (error) {
		appendCleanupFailure(errors, error);
	}
}

function collectSettledCleanupFailures(
	errors: unknown[],
	results: readonly PromiseSettledResult<unknown>[],
): void {
	for (const result of results) {
		if (result.status === "rejected") appendCleanupFailure(errors, result.reason);
	}
}

function appendCleanupFailure(errors: unknown[], error: unknown): void {
	if (error instanceof AggregateError) {
		for (const nested of error.errors) appendCleanupFailure(errors, nested);
		return;
	}
	errors.push(error);
}
