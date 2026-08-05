import type {
	AgentSessionRuntime,
	ExtensionFactory,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

import {
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
	selectionStatuses(): readonly AgentStatus[];
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
	#shutdownPromise: Promise<void> | undefined;
	#shuttingDown = false;

	constructor(
		runtime: AgentSessionRuntime,
		identity: OwnerIdentity,
		options: {
			entryModulePath: string;
			childExtensionFactory(agentId: string): ExtensionFactory;
			spawnBoundaryHooks?: SpawnBoundaryHooks;
			messageBoundaryHooks?: MessageBoundaryHooks;
			pendingMessageLimit?: number;
			humanRequestPresentation?: HumanRequestPresentation;
			humanRequestBoundaryHooks?: HumanRequestBoundaryHooks;
			humanSessionSelection?: HumanSessionSelection;
		},
	) {
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
			childExtensionFactory: options.childExtensionFactory,
		});
		this.#messages = new MessageCoordinator({
			agents: this.#agents,
			isShuttingDown: () => this.#shuttingDown,
			boundaryHooks: options.messageBoundaryHooks,
			pendingMessageLimit: options.pendingMessageLimit,
		});
		this.#messages.integrate(this.#requireAgent(identity.agentId));
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
		});
		this.#runSupervisor = new RunSupervisor({
			agents: this.#agents,
			ownerAgentId: identity.agentId,
			messages: this.#messages,
		});
		this.#spawner = new DefaultChildSpawner({
			agents: this.#agents,
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
			selectionStatuses: () =>
				[...this.#agents.values()].map((record) => statusOf(record)),
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

	#requireAgent(agentId: string): AgentRecord {
		const record = this.#agents.get(agentId);
		if (!record) throw new Error(`unknown_identity: ${agentId}`);
		return record;
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
				target.host.addRetentionReason("interactive_selection");
				try {
					await selection.activate({
						agentId,
						session,
						services: target.services,
						diagnostics: target.services.diagnostics,
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
