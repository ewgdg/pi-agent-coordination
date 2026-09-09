import { withAgentTranscriptObservations, type AgentRecord } from "./agent-record.ts";
import type { MessageCoordinator } from "./messages.ts";
import type { Message } from "../protocol/message.ts";
import type { WorkflowResumeActivation, WorkflowResumeDelivery, WorkflowResumeReceipt } from "../protocol/workflow-resume.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

/** Snapshot order is Agent ID, then physical source order; it is not the lost volatile queue. */
export async function resumeWorkflow(options: {
	workflowId: string;
	agents: ReadonlyMap<string, AgentRecord>;
	quarantinedAgentIds: ReadonlySet<string>;
	messages: MessageCoordinator;
	activate(record: AgentRecord, requestIds: readonly string[]): Promise<WorkflowResumeActivation>;
}): Promise<WorkflowResumeReceipt> {
	const records = [...options.agents.values()].sort((a, b) => a.identity.agentId.localeCompare(b.identity.agentId));
	const inspections = new Map<AgentRecord, TranscriptInspection>();
	const indeterminate: { agentId: string; reason: string }[] = [...options.quarantinedAgentIds]
		.sort().map(agentId => ({ agentId, reason: "evidence_unavailable: quarantined Agent transcript" }));
	const unavailable = new Set(options.quarantinedAgentIds);
	for (const record of records) {
		try {
			inspections.set(record, await record.transcript.refresh());
		} catch (error) {
			unavailable.add(record.identity.agentId);
			indeterminate.push({ agentId: record.identity.agentId, reason: recoveryError(error) });
		}
	}
	const deliveries: WorkflowResumeDelivery[] = [];
	const activations: WorkflowResumeActivation[] = [];
	const pending: Message[] = [];
	const responders: { record: AgentRecord; requestIds: readonly string[] }[] = [];
	const readable = records.filter(record => !unavailable.has(record.identity.agentId));
	withAgentTranscriptObservations(readable, () => {
		for (const record of readable) {
			try {
				const requestIds = options.messages.recoveryRequestIds(record);
				if (requestIds.length) responders.push({ record, requestIds: [...requestIds] });
			} catch (error) {
				indeterminate.push({ agentId: record.identity.agentId, reason: recoveryError(error) });
			}
			try {
				for (const candidate of options.messages.recoveryMessageCandidates(record)) {
					try {
						const message = options.messages.recoveryMessage(candidate.authorAgentId, candidate.messageId);
						if (unavailable.has(message.targetAgentId)) throw new Error("evidence_unavailable: recipient transcript");
						const inspected = options.messages.inspectRecoveryMessage(message);
						if (inspected) deliveries.push(inspected);
						else pending.push(message);
					} catch (error) {
						indeterminate.push({ agentId: record.identity.agentId, reason: `${candidate.messageId}: ${recoveryError(error)}` });
					}
				}
			} catch (error) {
				indeterminate.push({ agentId: record.identity.agentId, reason: recoveryError(error) });
			}
		}
	}, inspections);
	// Activate interrupted obligations before queued siblings can start the same Run.
	// Both paths still recheck current evidence and use the normal recipient lane.
	for (const { record, requestIds } of responders) {
		try {
			activations.push(await options.activate(record, requestIds));
		} catch (error) {
			activations.push({ agentId: record.identity.agentId, requestIds, disposition: "indeterminate", reason: recoveryError(error) });
		}
	}
	for (const message of pending) {
		try {
			deliveries.push(await options.messages.resumeMessage(message));
		} catch (error) {
			deliveries.push({ messageId: message.messageId, targetAgentId: message.targetAgentId, kind: message.kind, disposition: "indeterminate", reason: recoveryError(error) });
		}
	}
	return { workflowId: options.workflowId, deliveries, activations, indeterminate };
}

function recoveryError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
