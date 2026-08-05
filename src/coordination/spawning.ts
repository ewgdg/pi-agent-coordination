import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	requireLiveSession,
	type AgentRecord,
} from "./agent-record.ts";
import { normalizeAgentDescription } from "../protocol/agent-metadata.ts";
import {
	commitChildAgentIdentity,
	type ChildAgentIdentity,
	validateCommittedChildIdentity,
} from "../protocol/child-identity.ts";
import { createCreationRequestDelivery } from "../protocol/creation-request.ts";
import {
	deriveMessageIdentity,
	resolveCommittedSpawnSource,
	sameToolCallPointer,
	type ToolCallPointer,
} from "../protocol/identities.ts";
import type { RunRetentionReason } from "../runtime/in-process-owner-run-host.ts";
import { SerialLane } from "../runtime/serial-lane.ts";
import { DefaultChildSessionFactory } from "../runtime/default-child-session-factory.ts";

export type AgentSpawnInput = Readonly<{
	request: string;
	description?: string;
}>;

export type AgentSpawnReceipt =
	| Readonly<{
		disposition: "pending";
		agentId: string;
		requestId: string;
	}>
	| Readonly<{
		disposition: "created_unscheduled";
		agentId: string;
		requestId: string;
		failedStage: "run_start" | "delivery_admission";
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
	}>;

// Tests control only whether a concrete Pi boundary confirms, rejects, or loses
// confirmation; all session, transcript, and Run effects still use the real host.
export type SpawnBoundaryHooks = Readonly<{
	afterIdentityCommit?(context: {
		sessionManager: SessionManager;
		identity: ChildAgentIdentity;
	}): void | "confirmation_lost";
	beforeRunStart?(): void | "confirmed_failure";
	afterRunStart?(): void | "confirmation_lost";
	beforeDeliveryAdmission?(): void | "confirmed_failure";
	afterDeliveryAdmission?(): void | "confirmation_lost";
}>;

export class DefaultChildSpawner {
	readonly #agents: Map<string, AgentRecord>;
	readonly #sessionFactory: DefaultChildSessionFactory;
	readonly #boundaryHooks: SpawnBoundaryHooks;
	readonly #isShuttingDown: () => boolean;

	constructor(options: {
		agents: Map<string, AgentRecord>;
		sessionFactory: DefaultChildSessionFactory;
		boundaryHooks?: SpawnBoundaryHooks;
		isShuttingDown(): boolean;
	}) {
		this.#agents = options.agents;
		this.#sessionFactory = options.sessionFactory;
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
		const input = validateCommittedSpawnInput(committedInput);
		if (input.request !== providedInput.request || input.description !== providedInput.description) {
			throw new Error("invariant_violation: executed Agent Spawn input differs from its source");
		}
		this.#assertUnclaimedSpawnSource(source);

		let inherited: ReturnType<DefaultChildSessionFactory["snapshotInheritedRuntime"]>;
		let description: string | undefined;
		try {
			description = normalizeAgentDescription(input.description);
			inherited = this.#sessionFactory.snapshotInheritedRuntime(parent);
		} catch {
			return { disposition: "not_created", failedStage: "identity_commit" };
		}

		let sessionManager: SessionManager;
		try {
			sessionManager = SessionManager.create(
				inherited.baseline.cwd,
				this.#sessionFactory.workflowSessionDirectory(),
			);
		} catch {
			return { disposition: "not_created", failedStage: "identity_commit" };
		}
		const agentId = sessionManager.getSessionId();
		const requestId = deriveMessageIdentity(source);
		let services: AgentRecord["services"];
		try {
			services = await this.#sessionFactory.createValidatedServices(agentId, inherited);
		} catch {
			return { disposition: "not_created", failedStage: "identity_commit" };
		}

		const identity: ChildAgentIdentity = {
			agentId,
			workflowId: parent.identity.workflowId,
			directSpawnerAgentId: callerAgentId,
			spawnSource: source,
			configuration: {
				label: "agent",
				...(description === undefined ? {} : { description }),
				baseline: inherited.baseline,
			},
		};
		try {
			commitChildAgentIdentity(sessionManager, identity);
		} catch {
			return { disposition: "indeterminate", agentId, requestId };
		}
		const identityConfirmation = this.#boundaryHooks.afterIdentityCommit?.({
			sessionManager,
			identity,
		});
		validateCommittedChildIdentity(sessionManager, identity);

		const child: AgentRecord = {
			identity,
			services,
			lane: new SerialLane(),
			starting: true,
			children: [],
		};
		this.#agents.set(agentId, child);
		parent.children.push(agentId);
		this.#addRetentionReason(parent, "awaiting_answer");
		if (identityConfirmation === "confirmation_lost") {
			child.starting = false;
			return { disposition: "indeterminate", agentId, requestId };
		}

		try {
			if (this.#boundaryHooks.beforeRunStart?.() === "confirmed_failure") {
				throw new Error("Confirmed Run startup failure");
			}
			await child.lane.run(async () => {
				const started = await this.#sessionFactory.start({
					sessionManager,
					services,
					inherited,
					parentSession,
				});
				child.session = started.session;
				child.host = started.host;
				child.starting = false;
			});
		} catch {
			child.starting = false;
			child.session?.dispose();
			return {
				disposition: "created_unscheduled",
				agentId,
				requestId,
				failedStage: "run_start",
			};
		}
		if (this.#boundaryHooks.afterRunStart?.() === "confirmation_lost") {
			return {
				disposition: "indeterminate",
				agentId,
				requestId,
				lastConfirmedStage: "identity",
			};
		}

		try {
			if (this.#boundaryHooks.beforeDeliveryAdmission?.() === "confirmed_failure") {
				throw new Error("Confirmed Delivery admission failure");
			}
			await child.lane.run(() => {
				const session = requireLiveSession(child);
				// A fresh child is settled here, so triggerTurn admits this at its Idle
				// boundary as a standalone turn. followUp preserves Deferred semantics if
				// session state changes before Pi processes the admission.
				const deliveryPromise = session.sendCustomMessage(
					createCreationRequestDelivery({
						requestId,
						fromAgentId: callerAgentId,
						question: input.request,
						source,
					}),
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				child.deliveryPromise = deliveryPromise.then(
					() => child.host?.setRetentionReasons(["answer_owed"]),
					() => undefined,
				);
			});
		} catch {
			return {
				disposition: "created_unscheduled",
				agentId,
				requestId,
				failedStage: "delivery_admission",
			};
		}
		if (this.#boundaryHooks.afterDeliveryAdmission?.() === "confirmation_lost") {
			return {
				disposition: "indeterminate",
				agentId,
				requestId,
				lastConfirmedStage: "run_start",
			};
		}
		return { disposition: "pending", agentId, requestId };
	}

	#assertUnclaimedSpawnSource(source: ToolCallPointer): void {
		for (const record of this.#agents.values()) {
			if (
				"spawnSource" in record.identity &&
				sameToolCallPointer(record.identity.spawnSource, source)
			) {
				throw new Error("invariant_violation: Agent Spawn source already has a child");
			}
		}
	}

	#addRetentionReason(record: AgentRecord, reason: RunRetentionReason): void {
		const host = record.host;
		if (!host) return;
		const current = host.observe().retentionReasons;
		if (!current.includes(reason)) host.setRetentionReasons([...current, reason]);
	}

	#requireAgent(agentId: string): AgentRecord {
		const record = this.#agents.get(agentId);
		if (!record) throw new Error(`unknown_identity: ${agentId}`);
		return record;
	}
}

function validateCommittedSpawnInput(value: Record<string, unknown>): AgentSpawnInput {
	const keys = Object.keys(value).sort();
	const expected = value.description === undefined ? ["request"] : ["description", "request"];
	if (!sameStringList(keys, expected)) {
		throw new Error("invalid_input: Agent Spawn input has an invalid shape");
	}
	if (typeof value.request !== "string" || value.request.length === 0) {
		throw new Error("invalid_input: Agent Spawn request must not be empty");
	}
	if (value.description !== undefined && typeof value.description !== "string") {
		throw new Error("invalid_input: Agent Spawn description must be a string");
	}
	return {
		request: value.request,
		...(value.description === undefined ? {} : { description: value.description }),
	};
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
