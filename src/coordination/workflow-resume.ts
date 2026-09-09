import { withAgentTranscriptObservations, type AgentRecord } from "./agent-record.ts";
import type { MessageCoordinator } from "./messages.ts";
import type { Message } from "../protocol/message.ts";
import type { OutstandingRequestRecovery, WorkflowRecoveryView, WorkflowResumeReceipt } from "../protocol/workflow-resume.ts";
import type { WorkflowResumeActivation, WorkflowResumeDelivery } from "./workflow-recovery-outcomes.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

/** Snapshot order is Agent ID, then physical source order; it is not the lost volatile queue. */
export async function resumeWorkflow(options: {
	workflowId: string;
	ownerAgentId: string;
	agents: ReadonlyMap<string, AgentRecord>;
	quarantinedAgentIds: ReadonlySet<string>;
	messages: MessageCoordinator;
	activate(record: AgentRecord, requestIds: readonly string[], recovery: { isReady(): boolean; view(): WorkflowRecoveryView }): Promise<WorkflowResumeActivation>;
}): Promise<WorkflowResumeReceipt> {
	const records = [...options.agents.values()].sort((a, b) => a.identity.agentId.localeCompare(b.identity.agentId));
	const inspections = new Map<AgentRecord, TranscriptInspection>();
	const unavailableTargetReasons = new Map([...options.quarantinedAgentIds]
		.map(agentId => [agentId, "evidence_unavailable: quarantined Agent transcript"]));
	const requestInspectionFailures = new Map<string, string>();
	// Failures without a Request projection still need an observable result,
	// but must not prevent independent admissions or release of prepared inputs.
	const unscopedFailures: string[] = [];
	const agentInspectionFailures = new Map<string, string>();
	const unavailable = new Set(options.quarantinedAgentIds);
	for (const record of records) {
		try {
			inspections.set(record, await record.transcript.refresh());
		} catch (error) {
			unavailable.add(record.identity.agentId);
			unavailableTargetReasons.set(record.identity.agentId, recoveryError(error));
			if (record.identity.agentId === options.ownerAgentId) unscopedFailures.push(recoveryError(error));
		}
	}
	const deliveries: WorkflowResumeDelivery[] = [];
	const activations: WorkflowResumeActivation[] = [];
	const pending: Message[] = [];
	const requests: Extract<Message, { kind: "request" }>[] = [];
	const responders: { record: AgentRecord; requestIds: readonly string[] }[] = [];
	const readable = records.filter(record => !unavailable.has(record.identity.agentId));
	withAgentTranscriptObservations(readable, () => {
		for (const record of readable) {
			try {
				const requestIds = options.messages.recoveryRequestIds(record);
				if (requestIds.length) responders.push({ record, requestIds: [...requestIds] });
			} catch (error) {
				agentInspectionFailures.set(record.identity.agentId, recoveryError(error));
			}
			try {
				for (const candidate of options.messages.recoveryMessageCandidates(record)) {
					let message: Message | undefined;
					try {
						message = options.messages.recoveryMessage(candidate.authorAgentId, candidate.messageId);
						if (message.kind === "request") requests.push(message);
						if (unavailable.has(message.targetAgentId)) throw new Error("evidence_unavailable: recipient transcript");
						const inspected = options.messages.inspectRecoveryMessage(message);
						if (inspected) {
							if (message.kind === "request") deliveries.push(inspected);
							else if (inspected.disposition === "indeterminate" || inspected.disposition === "blocked") {
								unscopedFailures.push(`${message.messageId}: ${inspected.reason ?? inspected.disposition}`);
							}
						} else pending.push(message);
					} catch (error) {
						if (message?.kind === "request") requestInspectionFailures.set(candidate.messageId, recoveryError(error));
						else unscopedFailures.push(`${candidate.messageId}: ${recoveryError(error)}`);
					}
				}
			} catch (error) {
				unscopedFailures.push(`${record.identity.agentId}: ${recoveryError(error)}`);
			}
		}
	}, inspections);

	let ready = false;
	const views = new Map<string, WorkflowRecoveryView>();
	const recoveryFor = (agentId: string) => ({
		isReady: () => ready,
		view: () => views.get(agentId) ?? { outstandingRequests: [] },
	});
	// Activate interrupted obligations before queued siblings can start the same Run.
	// Both paths still recheck current evidence and use the normal recipient lane.
	try {
		for (const { record, requestIds } of responders) {
			try {
				activations.push(await options.activate(record, requestIds, recoveryFor(record.identity.agentId)));
			} catch (error) {
				activations.push({ agentId: record.identity.agentId, requestIds, disposition: "indeterminate", reason: recoveryError(error) });
			}
		}
		for (const message of pending) {
			try {
				const outcome = await options.messages.resumeMessage(message);
				if (message.kind === "request") deliveries.push(outcome);
				else if (outcome.disposition === "blocked" || outcome.disposition === "indeterminate") {
					unscopedFailures.push(`${message.messageId}: ${outcome.reason ?? outcome.disposition}`);
				}
			} catch (error) {
				if (message.kind === "request") deliveries.push({ messageId: message.messageId, targetAgentId: message.targetAgentId, kind: message.kind, disposition: "indeterminate", reason: recoveryError(error) });
				else unscopedFailures.push(`${message.messageId}: ${recoveryError(error)}`);
			}
		}
	} finally {
		// Even failed recovery must release its admission barrier. Suppression,
		// exact-Run fences and shutdown still belong to ordinary scheduling.
		for (const record of records) {
			const outstandingRequests = requests
				.filter(request => request.fromAgentId === record.identity.agentId)
				.flatMap(request => {
					const delivery = deliveries.find(item => item.messageId === request.messageId);
					if (delivery?.reason === "not_created" || delivery?.reason === "request_resolved") return [];
					const activation = activations.find(item =>
						item.agentId === request.targetAgentId && item.requestIds.includes(request.messageId));
					// Outbound inspection errors must not override verified responder activation.
					const unavailableReason = unavailableTargetReasons.get(request.targetAgentId)
						?? requestInspectionFailures.get(request.messageId)
						?? (!activation && !delivery ? agentInspectionFailures.get(request.targetAgentId) : undefined);
					return [Object.freeze({
						requestMessageId: request.messageId,
						targetAgentId: request.targetAgentId,
						...requestRecoveryOutcome(activation, delivery, unavailableReason),
					})];
				});
			views.set(record.identity.agentId, Object.freeze({ outstandingRequests: Object.freeze(outstandingRequests) }));
		}
		// No recipient lane waits here: all admissions finish before any
		// continuation can dispatch, including cycles of outstanding delegations.
		ready = true;
		const releases = await Promise.allSettled(responders.map(async ({ record }) =>
			options.messages.deliveryEligibilityChanged(record)));
		const failedRelease = releases.find(result => result.status === "rejected");
		if (failedRelease?.status === "rejected") {
			throw new Error(
				`recovery_dispatch_failed: work may already be admitted or dispatched; ${recoveryError(failedRelease.reason)}`,
				{ cause: failedRelease.reason },
			);
		}
	}
	if (unscopedFailures.length) {
		throw new Error(`recovery_incomplete: work may already be admitted or dispatched; ${unscopedFailures.join("; ")}`);
	}
	return { workflowId: options.workflowId, ...recoveryFor(options.ownerAgentId).view() };
}

function requestRecoveryOutcome(
	activation: WorkflowResumeActivation | undefined,
	delivery: WorkflowResumeDelivery | undefined,
	unavailableReason: string | undefined,
): Pick<OutstandingRequestRecovery, "status" | "reason"> {
	if (unavailableReason || delivery?.disposition === "indeterminate") {
		return { status: "indeterminate", reason: unavailableReason ?? delivery?.reason };
	}
	if (activation) {
		if (activation.disposition === "admitted") return { status: "continuation_admitted" };
		if (activation.reason === "already_running") return { status: "already_running" };
		if (activation.reason === "resolved") return { status: "resolved" };
		return {
			status: activation.disposition === "blocked" ? "blocked" : "indeterminate",
			reason: activation.reason ?? "recovery_evidence_unavailable",
		};
	}
	if (delivery?.disposition === "scheduled" || delivery?.reason === "already_scheduled") {
		return { status: "delivery_scheduled" };
	}
	return {
		status: delivery?.disposition === "blocked" ? "blocked" : "indeterminate",
		reason: delivery?.reason === "delivered" ? "responder_recovery_unavailable" : delivery?.reason ?? "recovery_evidence_unavailable",
	};
}

function recoveryError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
