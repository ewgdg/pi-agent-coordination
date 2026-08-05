import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	continueFromCommittedInput,
	persistCommittedInput,
} from "../pi-integration/committed-input.ts";
import { resolveModeratorAgentMetadata } from "../protocol/agent-metadata.ts";
import {
	createModelVisibleModeratorInput,
	MAX_OBLIGATION_STALL_REQUEST_SOURCES,
	validateCommittedModeratorInput,
	type ModeratorIdentity,
	type ObligationStallModeratorInput,
} from "../protocol/moderator-input.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
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
import { SerialLane } from "../runtime/serial-lane.ts";
import { statusOf, type AgentRecord } from "./agent-record.ts";
import type { MessageCoordinator } from "./messages.ts";

type ObligationStallSnapshot = Readonly<{
	key: string;
	agentId: string;
	requestIds: readonly string[];
	inspectedThrough: Readonly<{ agentId: string; entryId: string }>;
}>;

type ObligationStallHandling = {
	snapshot: ObligationStallSnapshot;
	moderatorAgentId?: string;
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
	readonly #handlingByKey = new Map<string, ObligationStallHandling>();
	readonly #attemptByModeratorAgentId = new Map<string, ObligationStallSnapshot>();
	readonly #integratedAgentIds = new Set<string>();
	readonly #reconciliationLane = new SerialLane();

	constructor(options: {
		agents: Map<string, AgentRecord>;
		ownerIdentity: OwnerIdentity;
		sessionFactory: DefaultChildSessionFactory;
		messages: MessageCoordinator;
		integrateAgent(record: AgentRecord): void;
		isShuttingDown(): boolean;
		reportError(error: unknown): void;
		boundaryHooks?: OperationalIncidentBoundaryHooks;
	}) {
		this.#agents = options.agents;
		this.#ownerIdentity = options.ownerIdentity;
		this.#sessionFactory = options.sessionFactory;
		this.#messages = options.messages;
		this.#integrateAgent = options.integrateAgent;
		this.#isShuttingDown = options.isShuttingDown;
		this.#reportError = options.reportError;
		this.#boundaryHooks = options.boundaryHooks ?? {};
	}

	integrate(record: AgentRecord): void {
		if (this.#integratedAgentIds.has(record.identity.agentId)) return;
		this.#integratedAgentIds.add(record.identity.agentId);
		record.host.addSettledHandler((_handle, settlement) => {
			if (settlement !== "settled") return;
			void record.host.lane
				.run(() => this.#reconciliationLane.run(() => this.#reconcileWorkflow()))
				.catch((error: unknown) => this.#reportError(error));
		});
		record.host.addStateChangeHandler(() => {
			void this.#reconciliationLane
				.run(() => this.#reconcileWorkflow())
				.catch((error: unknown) => this.#reportError(error));
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
			"incoming_requests" | "outgoing_requests" | "obligation_stall"
		> = [];
		if (moderator.host.requestRelationshipIds("answer_owed").length > 0) {
			predicates.push("incoming_requests");
		}
		if (moderator.host.requestRelationshipIds("awaiting_answer").length > 0) {
			predicates.push("outgoing_requests");
		}
		const snapshot = handling?.snapshot ?? attempt;
		const affected = snapshot ? this.#agents.get(snapshot.agentId) : undefined;
		const current = affected ? this.#observeObligationStall(affected) : undefined;
		if (snapshot && current?.key === snapshot.key) {
			predicates.push("obligation_stall");
		}
		if (predicates.length > 0) {
			return Promise.resolve({ disposition: "blocked", predicates });
		}
		if (!attempt) return Promise.resolve({ disposition: "already_cleared" });
		this.#releaseHandling(attempt.key);
		this.#attemptByModeratorAgentId.delete(moderatorAgentId);
		const originalObligationRemains = affected !== undefined &&
			attempt.requestIds.some((requestId) =>
				affected.host.hasRetentionReason("answer_owed", requestId)
			);
		return Promise.resolve({
			disposition: originalObligationRemains ? "resolved" : "already_cleared",
		});
	}

	async #reconcileWorkflow(): Promise<void> {
		if (this.#isShuttingDown()) return;
		for (const record of [...this.#agents.values()]) {
			if (this.#isModerator(record)) continue;
			const snapshot = this.#observeObligationStall(record);
			this.#clearChangedHandling(record.identity.agentId, snapshot?.key);
			if (!snapshot || this.#handlingByKey.has(snapshot.key)) continue;

			const handling: ObligationStallHandling = { snapshot };
			this.#handlingByKey.set(snapshot.key, handling);
			try {
				await this.#createModerator(record, handling);
			} catch (error) {
				if (handling.moderatorAgentId === undefined) {
					this.#handlingByKey.delete(snapshot.key);
				}
				throw error;
			}
		}
	}

	async #createModerator(
		affected: AgentRecord,
		handling: ObligationStallHandling,
	): Promise<void> {
		const owner = this.#agents.get(this.#ownerIdentity.agentId);
		if (!owner) throw new Error("invariant_violation: Workflow Owner is unavailable");
		const baseline = this.#sessionFactory.snapshotRuntimeBaseline(owner);
		const sessionManager = SessionManager.create(
			baseline.cwd,
			this.#sessionFactory.workflowSessionDirectory(),
		);
		const agentId = sessionManager.getSessionId();
		const prepared = await this.#sessionFactory.prepareModeratorRun(agentId, baseline);
		const current = this.#observeObligationStall(affected);
		if (!current || current.key !== handling.snapshot.key) {
			this.#handlingByKey.delete(handling.snapshot.key);
			return;
		}

		const metadata = resolveModeratorAgentMetadata("obligation_stall");
		const identity: ModeratorIdentity = {
			agentId,
			workflowId: this.#ownerIdentity.workflowId,
			directSpawnerAgentId: null,
			configuration: { ...metadata, baseline },
		};
		const sources = this.#messages.requestSources(
			current.requestIds.slice(0, MAX_OBLIGATION_STALL_REQUEST_SOURCES),
		);
		const input: ObligationStallModeratorInput = {
			trigger: {
				kind: "obligation_stall",
				agentId: current.agentId,
				obligations: {
					total: current.requestIds.length,
					sources,
				},
			},
			inspectedThrough: [current.inspectedThrough],
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
		) return;
		await moderator.host.lane.run(async () => {
			const session = await moderator.host.startInLane(["moderator_handling"]);
			moderator.host.trackOperation(continueFromCommittedInput(session));
		});
	}

	#observeObligationStall(
		record: AgentRecord,
	): ObligationStallSnapshot | undefined {
		const run = record.host.observe();
		if (
			run.phase !== "live" ||
			run.work !== "settled" ||
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
			key: JSON.stringify(["obligation_stall", record.identity.agentId, ...requestIds]),
			agentId: record.identity.agentId,
			requestIds,
			inspectedThrough,
		};
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
		return record.identity.agentId !== record.identity.workflowId &&
			record.identity.directSpawnerAgentId === null;
	}

	#clearChangedHandling(agentId: string, currentKey: string | undefined): void {
		for (const [key, handling] of this.#handlingByKey) {
			if (handling.snapshot.agentId !== agentId || key === currentKey) continue;
			this.#releaseHandling(key);
		}
	}

	#releaseHandling(key: string): void {
		const handling = this.#handlingByKey.get(key);
		if (!handling) return;
		this.#handlingByKey.delete(key);
		if (!handling.moderatorAgentId) return;
		this.#agents
			.get(handling.moderatorAgentId)
			?.host.removeRetentionReason("moderator_handling");
	}
}
