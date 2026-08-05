import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import {
	requireAgentRecord,
	requireLiveSession,
	type AgentRecord,
} from "./agent-record.ts";
import type { MessageCoordinator } from "./messages.ts";
import { sendAndAwaitTranscriptCommit } from "../pi-integration/transcript-commit.ts";
import {
	createSupervisoryResumeMessage,
	resolveCommittedRunControl,
	type RunControlInput,
	type RunControlReceipt,
} from "../protocol/run-control.ts";
import { isModeratorIdentity } from "../protocol/moderator-input.ts";

export class RunSupervisor {
	readonly #agents: Map<string, AgentRecord>;
	readonly #ownerAgentId: string;
	readonly #messages: MessageCoordinator;
	readonly #quarantinedAgentIds: ReadonlySet<string>;

	constructor(options: {
		agents: Map<string, AgentRecord>;
		quarantinedAgentIds?: ReadonlySet<string>;
		ownerAgentId: string;
		messages: MessageCoordinator;
	}) {
		this.#agents = options.agents;
		this.#quarantinedAgentIds = options.quarantinedAgentIds ?? new Set();
		this.#ownerAgentId = options.ownerAgentId;
		this.#messages = options.messages;
	}

	execute(
		callerAgentId: string,
		toolCallId: string,
		input: RunControlInput,
	): Promise<RunControlReceipt> {
		const caller = this.#requireAgent(callerAgentId);
		const committed = resolveCommittedRunControl({
			callerAgentId,
			sessionManager: requireLiveSession(caller).sessionManager,
			toolCallId,
			providedInput: input,
		});
		const control = committed.input;
		const target = this.#requireControllableTarget(callerAgentId, control.agentId);
		return target.host.lane.run(async () => {
			if (control.operation === "terminate") {
				const residualRequests = target.host.residualRequestCounts();
				if (!target.host.currentHandle()) {
					return {
						agentId: target.identity.agentId,
						disposition: "not_running",
						residualRequests,
					};
				}
				this.#messages.discardSchedulingInLane(target);
				await target.host.discardAndEndInLane();
				return {
					agentId: target.identity.agentId,
					disposition: "terminated",
					residualRequests,
				};
			}
			if (control.operation === "resume") {
				const message = createSupervisoryResumeMessage({
					workflowId: caller.identity.workflowId,
					fromAgentId: callerAgentId,
					input: control,
					source: committed.source,
				});
				const identity = {
					agentId: target.identity.agentId,
					messageId: message.messageId,
				};
				const hold = target.host.currentInterruptionHold();
				if (!hold) {
					return { ...identity, delivery: "rejected", rejectionReason: "not_held" };
				}
				const admission = await this.#messages.admitResumeInLane(target, message, hold);
				if (admission === "pending") return { ...identity, delivery: "pending" };
				return {
					...identity,
					delivery: "rejected",
					rejectionReason: admission === "capacity_exhausted"
						? "resume_slot_occupied"
						: "target_unavailable",
				};
			}
			this.#messages.prepareInterruptionInLane(target);
			const disposition = await target.host.interruptCurrentRunInLane();
			return { agentId: target.identity.agentId, disposition };
		});
	}

	resumeFromHuman(
		agentId: string,
		text: string,
		images: readonly ImageContent[] | undefined,
	): Promise<boolean> {
		const record = this.#requireAgent(agentId);
		return record.host.lane.run(async () => {
			const hold = record.host.currentInterruptionHold();
			if (!hold) return false;
			if (!record.host.beginIsolatedResumptionInLane(hold)) {
				throw new Error("Run resumption is already in progress");
			}
			const session = requireLiveSession(record);
			const content: Array<TextContent | ImageContent> = [
				{ type: "text", text },
				...(images ?? []),
			];
			try {
				const committed = await sendAndAwaitTranscriptCommit({
					session,
					matchesCandidate: (event) =>
						event.type === "message_end" && event.message.role === "user",
					inspectCommit: () => {
						const tail = session.sessionManager.getEntries().at(-1);
						return tail?.type === "message" &&
							tail.message.role === "user" &&
							JSON.stringify(tail.message.content) === JSON.stringify(content);
					},
					send: () => session.sendUserMessage(content),
					onDispatched: (completion) => record.host.trackOperation(completion),
				});
				if (!committed) {
					throw new Error("Run resumption input did not commit");
				}
				if (!record.host.commitIsolatedResumptionInLane(hold)) {
					throw new Error(
						"invariant_violation: committed human resume Message lost its exact Hold",
					);
				}
				return true;
			} catch (error) {
				record.host.cancelIsolatedResumptionInLane(hold);
				throw error;
			}
		});
	}

	#requireControllableTarget(callerAgentId: string, targetAgentId: string): AgentRecord {
		const caller = this.#requireAgent(callerAgentId);
		const target = this.#requireAgent(targetAgentId);
		const callerIsModerator = isModeratorIdentity(caller.identity);
		if (
			targetAgentId === this.#ownerAgentId ||
			targetAgentId === callerAgentId ||
			(callerAgentId !== this.#ownerAgentId &&
				!callerIsModerator &&
				target.identity.directSpawnerAgentId !== caller.identity.agentId)
		) {
			throw new Error(
				`unauthorized: Agent ${callerAgentId} cannot control Agent Run ${targetAgentId}`,
			);
		}
		return target;
	}

	#requireAgent(agentId: string): AgentRecord {
		return requireAgentRecord(
			this.#agents,
			this.#quarantinedAgentIds,
			agentId,
		);
	}
}
