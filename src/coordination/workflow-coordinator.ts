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
import { DefaultChildSessionFactory } from "../runtime/default-child-session-factory.ts";
import {
	HumanRequestCoordinator,
	type HumanAttentionItem,
	type HumanRequestBoundaryHooks,
	type HumanRequestPresentation,
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
import type { HumanSessionSelection } from "../pi-integration/interactive-session-selection.ts";
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

type AgentCoordinatorView = Readonly<{
	status(agentId?: string): AgentStatus;
	children(agentId?: string): readonly AgentStatus[];
	message(toolCallId: string, input: AgentMessageInput): Promise<AgentMessageReceipt>;
	control(toolCallId: string, input: RunControlInput): Promise<RunControlReceipt>;
	resumeFromHuman(
		text: string,
		images: readonly ImageContent[] | undefined,
	): Promise<boolean>;
	selectionRoster(): Readonly<{
		live: readonly AgentRosterStatus[];
		dormant: readonly AgentRosterStatus[];
	}>;
	selectForHuman(agentId: string): Promise<"selected" | "dormant">;
	askHuman(
		toolCallId: string,
		input: HumanRequestInput,
		signal: AbortSignal | undefined,
	): Promise<HumanAnswerCandidate>;
	guardHumanToolResult(
		message: MessageEndEvent["message"],
	): MessageEndEvent["message"] | undefined;
	reconcileHumanToolResults(): void;
	humanAttention(): readonly HumanAttentionItem[];
	operationalAttention(): readonly OperationalIncidentAttention[];
	focusHumanRequest(requestId: string): Promise<void>;
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
	readonly #messages: MessageCoordinator;
	readonly #humanRequests: HumanRequestCoordinator;
	readonly #runSupervisor: RunSupervisor;
	readonly #operationalIncidents: OperationalIncidentCoordinator;
	readonly #humanSessionSelection: HumanSessionSelection | undefined;
	readonly #selectionLane = new SerialLane();
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
			humanRequestPresentation?: HumanRequestPresentation;
			humanRequestBoundaryHooks?: HumanRequestBoundaryHooks;
			humanSessionSelection?: HumanSessionSelection;
		},
	) {
		this.#quarantinedAgentIds = options.recoveredWorkflow?.quarantinedAgentIds ?? new Set();
		this.#agentIdBySpawnSource = new Map(
			options.recoveredWorkflow?.agentIdBySpawnSource ?? [],
		);
		this.#workflowPolicy = options.workflowPolicy ?? new WorkflowPolicyStore();
		this.#executionScheduler = new WorkflowExecutionScheduler(this.#workflowPolicy);
		this.#ownerIdentity = identity;
		this.#humanSessionSelection = options.humanSessionSelection;
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
			automaticGenerationReconciliation:
				options.automaticGenerationReconciliation,
		});
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
		if (this.#humanSessionSelection) {
			this.#requireAgent(identity.agentId).host.addRetentionReason(
				"interactive_selection",
			);
		}
		this.#humanRequests = new HumanRequestCoordinator({
			agents: this.#agents,
			ownerIdentity: identity,
			presentation: options.humanRequestPresentation,
			boundaryHooks: options.humanRequestBoundaryHooks,
			interruptRun: (record) => {
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
		});
		this.#runSupervisor = new RunSupervisor({
			agents: this.#agents,
			quarantinedAgentIds: this.#quarantinedAgentIds,
			ownerAgentId: identity.agentId,
			messages: this.#messages,
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
			children: (targetAgentId?: string) => this.#childrenFor(agentId, targetAgentId),
			message: (toolCallId, input) => this.#messages.execute(agentId, toolCallId, input),
			control: (toolCallId, input) => {
				this.#assertAdmissionOpen();
				return this.#runSupervisor.execute(agentId, toolCallId, input);
			},
			resumeFromHuman: (text, images) => {
				this.#assertAdmissionOpen();
				return this.#runSupervisor.resumeFromHuman(agentId, text, images);
			},
			selectionRoster: () => this.#selectionRoster(),
			selectForHuman: (targetAgentId) => {
				this.#assertAdmissionOpen();
				return this.#selectForHuman(targetAgentId);
			},
			askHuman: (toolCallId, input, signal) => {
				this.#assertAdmissionOpen();
				return this.#humanRequests.ask(agentId, toolCallId, input, signal);
			},
			guardHumanToolResult: (message) =>
				this.#humanRequests.guardResultCommit(agentId, message),
			reconcileHumanToolResults: () =>
				this.#humanRequests.reconcileCommittedResults(agentId),
			humanAttention: () => this.#humanRequests.attentionItems(agentId),
			operationalAttention: () => this.#operationalIncidents.attentionItems(agentId),
			focusHumanRequest: (requestId) => {
				this.#assertAdmissionOpen();
				return this.#humanRequests.focus(agentId, requestId);
			},
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
				// Moderators are standalone participants rather than members of the
				// ordinary creation hierarchy rendered by the Live tab.
				if (!this.#isModerator(status.agentId)) live.push(status);
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
		this.#messages.integrate(record);
		this.#operationalIncidents.integrate(record);
	}

	async #beginExecution(agentId: string): Promise<void> {
		this.#assertAdmissionOpen();
		if (this.#executionPermits.has(agentId)) {
			throw new Error(
				`invariant_violation: Agent ${agentId} execution already holds Workflow capacity`,
			);
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

	async #shutdown(disposeNativeRuntime: () => Promise<void>): Promise<void> {
		const cleanupErrors: unknown[] = [];
		await collectCleanupFailure(
			cleanupErrors,
			() => this.#operationalIncidents.shutdown(),
		);
		if (
			this.#humanSessionSelection &&
			this.#humanSessionSelection.selectedAgentId() !== this.#ownerIdentity.agentId
		) {
			await collectCleanupFailure(
				cleanupErrors,
				() => this.#selectForHuman(this.#ownerIdentity.agentId),
			);
		}
		const children = [...this.#agents.values()].filter(
			(record) => record.identity.agentId !== this.#ownerIdentity.agentId,
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

	#selectForHuman(agentId: string): Promise<"selected" | "dormant"> {
		const selection = this.#humanSessionSelection;
		if (!selection) return Promise.resolve("dormant");
		return this.#selectionLane.run(async () => {
			const target = this.#requireAgent(agentId);
			const previousAgentId = selection.selectedAgentId();
			if (previousAgentId === agentId) return "selected";
			const activated = await target.host.lane.run(async () => {
				const session = target.host.currentHandle()
					? target.host.requireLiveSession()
					: undefined;
				if (!session) return false;
				const services = requireLiveServices(target);
				target.host.addRetentionReason("interactive_selection");
				try {
					await selection.activate({
						agentId,
						session,
						services,
						diagnostics: services.diagnostics,
					});
					return true;
				} catch (error) {
					target.host.removeRetentionReason("interactive_selection");
					throw error;
				}
			});
			if (!activated) return "dormant";
			const previous = this.#requireAgent(previousAgentId);
			await previous.host.lane.run(() => {
				previous.host.removeRetentionReason("interactive_selection");
			});
			await this.#messages.requestRelease(previous);
			return "selected";
		});
	}
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
