import type {
	AgentSessionRuntime,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

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
	DeferredMessageCoordinator,
	type AgentMessageInput,
	type AgentMessageReceipt,
	type MessageBoundaryHooks,
} from "./deferred-messages.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import { InProcessAgentHost } from "../runtime/in-process-agent-host.ts";
import { DefaultChildSessionFactory } from "../runtime/default-child-session-factory.ts";

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
} from "./deferred-messages.ts";

export type OrdinaryAgentCoordinatorView = Readonly<{
	status(agentId?: string): AgentStatus;
	children(agentId?: string): readonly AgentStatus[];
	spawn(toolCallId: string, input: AgentSpawnInput): Promise<AgentSpawnReceipt>;
	message(toolCallId: string, input: AgentMessageInput): Promise<AgentMessageReceipt>;
}>;

export class WorkflowCoordinator {
	readonly #ownerIdentity: OwnerIdentity;
	readonly #agents = new Map<string, AgentRecord>();
	readonly #spawner: DefaultChildSpawner;
	readonly #messages: DeferredMessageCoordinator;
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
		},
	) {
		this.#ownerIdentity = identity;
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
		this.#messages = new DeferredMessageCoordinator({
			agents: this.#agents,
			isShuttingDown: () => this.#shuttingDown,
			boundaryHooks: options.messageBoundaryHooks,
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
}
