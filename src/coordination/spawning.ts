import {
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";

import {
	requireLiveSession,
	type AgentRecord,
} from "./agent-record.ts";
import { MessageCoordinator } from "./messages.ts";
import { resolveOrdinaryAgentMetadata } from "../protocol/agent-metadata.ts";
import {
	type AgentSpawnInput,
	validateAgentSpawnInput,
} from "../protocol/agent-spawn-input.ts";
import {
	commitChildAgentIdentity,
	type ChildAgentIdentity,
	validateCommittedChildIdentity,
} from "../protocol/child-identity.ts";
import {
	deriveMessageIdentity,
	ProtocolInvariantError,
	resolveCommittedSpawnSource,
	toolCallPointerKey,
	type ToolCallPointer,
} from "../protocol/identities.ts";
import {
	InProcessAgentHost,
	type RunRetentionReason,
} from "../runtime/in-process-agent-host.ts";
import {
	DefaultChildSessionFactory,
	type PreparedAgentRun,
} from "../runtime/default-child-session-factory.ts";
import type { EffectiveAgentRunConfiguration } from "../templates/agent-configuration.ts";

export type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";

export type AgentSpawnReceipt =
	| Readonly<{
		disposition: "pending";
		agentId: string;
		requestId: string;
		effectiveConfiguration: EffectiveAgentRunConfiguration;
	}>
	| Readonly<{
		disposition: "created_unscheduled";
		agentId: string;
		requestId: string;
		failedStage: "run_start" | "delivery_admission";
		effectiveConfiguration: EffectiveAgentRunConfiguration;
	}>
	| Readonly<{
		disposition: "not_created";
		failedStage: "identity_commit";
	}>
	| Readonly<{
		disposition: "indeterminate";
		agentId?: string;
		requestId?: string;
		lastConfirmedStage?: "identity" | "run_start";
		effectiveConfiguration?: EffectiveAgentRunConfiguration;
	}>;

// Tests control only whether a concrete Pi boundary confirms, rejects, or loses
// confirmation; all session, transcript, and Run effects still use the real host.
export type SpawnBoundaryHooks = Readonly<{
	afterIdentityCommit?(context: {
		sessionManager: SessionManager;
		identity: ChildAgentIdentity;
	}): void | "confirmation_lost";
	beforeRunStart?(): void | "confirmed_failure";
	afterRunStart?(context: {
		session: AgentSession;
		identity: ChildAgentIdentity;
	}): void | "confirmation_lost";
	beforeDeliveryAdmission?(): void | "confirmed_failure";
	afterDeliveryAdmission?(): void | "confirmation_lost";
}>;

export class DefaultChildSpawner {
	readonly #agents: Map<string, AgentRecord>;
	readonly #sessionFactory: DefaultChildSessionFactory;
	readonly #boundaryHooks: SpawnBoundaryHooks;
	readonly #isShuttingDown: () => boolean;
	readonly #messages: MessageCoordinator;
	readonly #integrateAgent: (record: AgentRecord) => void;
	readonly #agentIdBySpawnSource: Map<string, string>;

	constructor(options: {
		agents: Map<string, AgentRecord>;
		agentIdBySpawnSource?: Map<string, string>;
		sessionFactory: DefaultChildSessionFactory;
		messages: MessageCoordinator;
		integrateAgent(record: AgentRecord): void;
		boundaryHooks?: SpawnBoundaryHooks;
		isShuttingDown(): boolean;
	}) {
		this.#agents = options.agents;
		this.#agentIdBySpawnSource = options.agentIdBySpawnSource ?? new Map();
		this.#sessionFactory = options.sessionFactory;
		this.#messages = options.messages;
		this.#integrateAgent = options.integrateAgent;
		this.#boundaryHooks = options.boundaryHooks ?? {};
		this.#isShuttingDown = options.isShuttingDown;
	}

	async spawn(
		callerAgentId: string,
		toolCallId: string,
		providedInput: AgentSpawnInput,
	): Promise<AgentSpawnReceipt> {
		if (this.#isShuttingDown()) {
			throw new Error("host_shutting_down: Workflow is shutting down");
		}
		const parent = this.#requireAgent(callerAgentId);
		const parentSession = requireLiveSession(parent);
		const { source, input: committedInput } = resolveCommittedSpawnSource({
			agentId: callerAgentId,
			sessionManager: parentSession.sessionManager,
			toolCallId,
		});
		const input = validateAgentSpawnInput(committedInput);
		if (!isDeepStrictEqual(input, providedInput)) {
			throw new Error("invariant_violation: executed Agent Spawn input differs from its source");
		}
		this.#assertUnclaimedSpawnSource(source);

		let baseline: ReturnType<DefaultChildSessionFactory["snapshotRuntimeBaseline"]>;
		let metadata: ReturnType<typeof resolveOrdinaryAgentMetadata>;
		try {
			metadata = resolveOrdinaryAgentMetadata({
				explicitLabel: input.label,
				explicitDescription: input.description,
				templateName: input.template,
			});
			baseline = this.#sessionFactory.snapshotRuntimeBaseline(parent);
		} catch {
			return { disposition: "not_created", failedStage: "identity_commit" };
		}

		let sessionManager: SessionManager;
		try {
			sessionManager = SessionManager.create(
				baseline.cwd,
				this.#sessionFactory.workflowSessionDirectory(),
			);
		} catch {
			return { disposition: "not_created", failedStage: "identity_commit" };
		}
		const agentId = sessionManager.getSessionId();
		const requestId = deriveMessageIdentity(source);
		const blueprint = { baseline, spawnInput: input } as const;
		let prepared: PreparedAgentRun;
		try {
			prepared = await this.#sessionFactory.prepareRun(agentId, blueprint);
		} catch {
			return { disposition: "not_created", failedStage: "identity_commit" };
		}

		const identity: ChildAgentIdentity = {
			agentId,
			workflowId: parent.identity.workflowId,
			directSpawnerAgentId: callerAgentId,
			spawnSource: source,
			configuration: {
				...metadata,
				baseline,
			},
		};
		try {
			commitChildAgentIdentity(sessionManager, identity);
		} catch {
			return {
				disposition: "indeterminate",
				agentId,
				requestId,
				effectiveConfiguration: prepared.configuration,
			};
		}
		const identityConfirmation = this.#boundaryHooks.afterIdentityCommit?.({
			sessionManager,
			identity,
		});
		validateCommittedChildIdentity(sessionManager, identity);

		const child = this.#sessionFactory.createAgentRecord({
			identity,
			sessionManager,
			blueprint,
			firstPrepared: prepared,
		});
		this.#agents.set(agentId, child);
		this.#agentIdBySpawnSource.set(toolCallPointerKey(source), agentId);
		parent.children.push(agentId);
		this.#integrateAgent(child);
		this.#addRetentionReason(parent, "awaiting_answer", requestId);
		if (identityConfirmation === "confirmation_lost") {
			return {
				disposition: "indeterminate",
				agentId,
				requestId,
				effectiveConfiguration: prepared.configuration,
			};
		}

		try {
			if (this.#boundaryHooks.beforeRunStart?.() === "confirmed_failure") {
				throw new Error("Confirmed Run startup failure");
			}
			await child.host.lane.run(() => child.host.startInLane(["pending_delivery"]));
		} catch (error) {
			if (error instanceof ProtocolInvariantError) throw error;
			return {
				disposition: "created_unscheduled",
				agentId,
				requestId,
				failedStage: "run_start",
				effectiveConfiguration: prepared.configuration,
			};
		}
		if (
			this.#boundaryHooks.afterRunStart?.({
				session: child.host.requireLiveSession(),
				identity,
			}) === "confirmation_lost"
		) {
			return {
				disposition: "indeterminate",
				agentId,
				requestId,
				lastConfirmedStage: "identity",
				effectiveConfiguration: prepared.configuration,
			};
		}

		try {
			if (this.#boundaryHooks.beforeDeliveryAdmission?.() === "confirmed_failure") {
				throw new Error("Confirmed Delivery admission failure");
			}
			const admission = await this.#messages.admitCreationRequest({
				recipient: child,
				requestId,
				fromAgentId: callerAgentId,
				question: input.request,
				source,
			});
			if (admission === "rejected") throw new Error("Confirmed Delivery admission failure");
		} catch (error) {
			if (error instanceof ProtocolInvariantError) throw error;
			child.host.removeRetentionReason("pending_delivery");
			await this.#messages.requestRelease(child);
			return {
				disposition: "created_unscheduled",
				agentId,
				requestId,
				failedStage: "delivery_admission",
				effectiveConfiguration: prepared.configuration,
			};
		}
		if (this.#boundaryHooks.afterDeliveryAdmission?.() === "confirmation_lost") {
			return {
				disposition: "indeterminate",
				agentId,
				requestId,
				lastConfirmedStage: "run_start",
				effectiveConfiguration: prepared.configuration,
			};
		}
		return {
			disposition: "pending",
			agentId,
			requestId,
			effectiveConfiguration: prepared.configuration,
		};
	}

	#assertUnclaimedSpawnSource(source: ToolCallPointer): void {
		if (this.#agentIdBySpawnSource.has(toolCallPointerKey(source))) {
			throw new Error("invariant_violation: Agent Spawn source already has a child");
		}
	}

	#addRetentionReason(
		record: AgentRecord,
		reason: RunRetentionReason,
		requestId?: string,
	): void {
		record.host.addRetentionReason(reason, requestId);
	}

	#requireAgent(agentId: string): AgentRecord {
		const record = this.#agents.get(agentId);
		if (!record) throw new Error(`unknown_identity: ${agentId}`);
		return record;
	}
}
