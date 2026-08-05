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

export type { AgentStatus } from "./agent-record.ts";
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

export type OrdinaryAgentCoordinatorView = Readonly<{
	status(agentId?: string): AgentStatus;
	children(agentId?: string): readonly AgentStatus[];
	spawn(toolCallId: string, input: AgentSpawnInput): Promise<AgentSpawnReceipt>;
	message(toolCallId: string, input: AgentMessageInput): Promise<AgentMessageReceipt>;
	control(toolCallId: string, input: RunControlInput): Promise<RunControlReceipt>;
	resumeFromHuman(
		text: string,
		images: readonly ImageContent[] | undefined,
	): Promise<boolean>;
	selectionRoster(): Readonly<{
		live: readonly AgentStatus[];
		dormant: readonly AgentStatus[];
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
	focusHumanRequest(requestId: string): Promise<void>;
	reachSafeBoundary(): Promise<void>;
	beginExecution(): Promise<void>;
	ensureExecution(): Promise<void>;
	endExecution(): void;
}>;

export class WorkflowCoordinator {
	readonly #ownerIdentity: OwnerIdentity;
	readonly #agents = new Map<string, AgentRecord>();
	readonly #spawner: DefaultChildSpawner;
	readonly #messages: MessageCoordinator;
	readonly #humanRequests: HumanRequestCoordinator;
	readonly #runSupervisor: RunSupervisor;
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
			spawnBoundaryHooks?: SpawnBoundaryHooks;
			messageBoundaryHooks?: MessageBoundaryHooks;
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
			const record = sessionFactory.createAgentRecord({
				identity: recovered.identity,
				sessionManager: recovered.sessionManager,
				blueprint: {
					baseline: recovered.identity.configuration.baseline,
					spawnInput: recovered.spawnInput,
				},
			});
			this.#agents.set(recovered.identity.agentId, record);
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
		for (const record of this.#agents.values()) this.#messages.integrate(record);
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
		});
		this.#runSupervisor = new RunSupervisor({
			agents: this.#agents,
			quarantinedAgentIds: this.#quarantinedAgentIds,
			ownerAgentId: identity.agentId,
			messages: this.#messages,
		});
		this.#spawner = new DefaultChildSpawner({
			agents: this.#agents,
			agentIdBySpawnSource: this.#agentIdBySpawnSource,
			sessionFactory,
			messages: this.#messages,
			boundaryHooks: options.spawnBoundaryHooks,
			isShuttingDown: () => this.#shuttingDown,
		});
	}

	forAgent(agentId: string): OrdinaryAgentCoordinatorView {
		this.#requireAgent(agentId);
		return Object.freeze({
			status: (targetAgentId?: string) => this.#statusFor(agentId, targetAgentId),
			children: (targetAgentId?: string) => this.#childrenFor(agentId, targetAgentId),
			spawn: (toolCallId, input) => this.#spawner.spawn(agentId, toolCallId, input),
			message: (toolCallId, input) => this.#messages.execute(agentId, toolCallId, input),
			control: (toolCallId, input) =>
				this.#runSupervisor.execute(agentId, toolCallId, input),
			resumeFromHuman: (text, images) =>
				this.#runSupervisor.resumeFromHuman(agentId, text, images),
			selectionRoster: () => this.#selectionRoster(),
			selectForHuman: (targetAgentId) => this.#selectForHuman(targetAgentId),
			askHuman: (toolCallId, input, signal) =>
				this.#humanRequests.ask(agentId, toolCallId, input, signal),
			guardHumanToolResult: (message) =>
				this.#humanRequests.guardResultCommit(agentId, message),
			reconcileHumanToolResults: () =>
				this.#humanRequests.reconcileCommittedResults(agentId),
			humanAttention: () => this.#humanRequests.attentionItems(agentId),
			focusHumanRequest: (requestId) =>
				this.#humanRequests.focus(agentId, requestId),
			reachSafeBoundary: () => this.#messages.reachSafeBoundary(agentId),
			beginExecution: () => this.#beginExecution(agentId),
			ensureExecution: () => this.#ensureExecution(agentId),
			endExecution: () => this.#releaseExecution(agentId),
		});
	}

	shutdown(disposeNativeRuntime: () => Promise<void>): Promise<void> {
		this.#shuttingDown = true;
		this.#shutdownPromise ??= this.#shutdown(disposeNativeRuntime);
		return this.#shutdownPromise;
	}

	#statusFor(callerAgentId: string, targetAgentId = callerAgentId): AgentStatus {
		return statusOf(this.#requireObservable(callerAgentId, targetAgentId));
	}

	#childrenFor(callerAgentId: string, targetAgentId = callerAgentId): readonly AgentStatus[] {
		if (
			targetAgentId !== callerAgentId &&
			callerAgentId !== this.#ownerIdentity.agentId
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
			target.identity.directSpawnerAgentId !== caller.identity.agentId
		) {
			throw new Error(`unauthorized: Agent ${callerAgentId} cannot observe ${targetAgentId}`);
		}
		return target;
	}

	#selectionRoster(): Readonly<{
		live: readonly AgentStatus[];
		dormant: readonly AgentStatus[];
	}> {
		const authorityOrder: AgentRecord[] = [];
		const appendAuthoritySubtree = (agentId: string) => {
			const record = this.#requireAgent(agentId);
			authorityOrder.push(record);
			for (const childId of record.children) appendAuthoritySubtree(childId);
		};
		appendAuthoritySubtree(this.#ownerIdentity.agentId);
		const live: AgentStatus[] = [];
		const dormant: Array<{ status: AgentStatus; recency: number; order: number }> = [];
		for (const [order, record] of authorityOrder.entries()) {
			const status = statusOf(record);
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

	#requireAgent(agentId: string): AgentRecord {
		return requireAgentRecord(
			this.#agents,
			this.#quarantinedAgentIds,
			agentId,
		);
	}

	async #beginExecution(agentId: string): Promise<void> {
		if (this.#executionPermits.has(agentId)) {
			throw new Error(
				`invariant_violation: Agent ${agentId} execution already holds Workflow capacity`,
			);
		}
		await this.#ensureExecution(agentId);
	}

	async #ensureExecution(agentId: string): Promise<void> {
		if (this.#executionPermits.has(agentId)) return;
		const record = this.#requireAgent(agentId);
		const run = record.host.observe();
		if (run.phase !== "live" || run.attention === "input_required") return;
		const permit = await this.#executionScheduler.admit(
			"ordinary",
			record.host.requireLiveSession().agent.signal,
		);
		if (permit) this.#executionPermits.set(agentId, permit);
	}

	#releaseExecution(agentId: string): void {
		const permit = this.#executionPermits.get(agentId);
		if (!permit) return;
		this.#executionPermits.delete(agentId);
		permit.release();
	}

	async #shutdown(disposeNativeRuntime: () => Promise<void>): Promise<void> {
		if (
			this.#humanSessionSelection &&
			this.#humanSessionSelection.selectedAgentId() !== this.#ownerIdentity.agentId
		) {
			await this.#selectForHuman(this.#ownerIdentity.agentId);
		}
		const children = [...this.#agents.values()].filter(
			(record) => record.identity.agentId !== this.#ownerIdentity.agentId,
		);
		await Promise.all(
			children.map((record) =>
				record.host.lane.run(() => {
					this.#messages.discardSchedulingInLane(record);
					return record.host.discardAndEndInLane();
				}),
			),
		);
		const owner = this.#requireAgent(this.#ownerIdentity.agentId);
		await owner.host.lane.run(() => {
			this.#messages.discardSchedulingInLane(owner);
			return owner.host.discardAndEndInLane(async () => disposeNativeRuntime());
		});
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
