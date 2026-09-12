import { randomUUID } from "node:crypto";
import { EvidenceUnavailableError, type AgentRecord } from "./agent-record.ts";
import type { MessageDeliveryFailure, MessageDeliveryScheduler } from "./message-delivery-scheduler.ts";
import { createDeliveryFailureNotice, inspectDeliveryFailureNotice, type DeliveryFailureNotice } from "../protocol/delivery-failure.ts";

/** Failure notices use normal author scheduling, never recipient recovery authority. */
export async function scheduleDeliveryFailureNotice(options: {
	failure: MessageDeliveryFailure;
	author: AgentRecord;
	scheduler: MessageDeliveryScheduler;
	isShuttingDown(): boolean;
}): Promise<void> {
	const { failure, author, scheduler, isShuttingDown } = options;
	const { record: recipient, delivery } = failure;
	if (isShuttingDown()) return;
	const inspectDelivery = (): DeliveryFailureNotice["delivery"] | undefined => {
		try {
			if (delivery.inspectProof()) return undefined;
			const tail = recipient.transcript.inspect().entries.at(-1);
			if (!tail) throw new EvidenceUnavailableError("Recipient transcript has no inspection cursor");
			return { disposition: "not_observed", inspectedThrough: { agentId: recipient.identity.agentId, entryId: tail.id } };
		} catch (error) {
			if (!(error instanceof EvidenceUnavailableError)) throw error;
			return { disposition: "indeterminate", reason: "inspection_incomplete" };
		}
	};
	const evidence = inspectDelivery();
	if (!evidence) return;
	const projection = delivery.deliveryItem.projection;
	const notificationId = randomUUID();
	const message = createDeliveryFailureNotice({
		notificationId, messageId: delivery.messageId,
		...(projection.kind === "request" ? { requestMessageId: delivery.messageId } : {}),
		recipientAgentId: recipient.identity.agentId,
		messageKind: projection.kind,
		failure: { reason: failure.reason, outcome: evidence.disposition === "indeterminate" ? "uncertain" : failure.outcome },
		delivery: evidence,
	});
	// Queue separately from the failing recipient lane. A settled/dormant author
	// gets a turn; an Agent Wait is preempted, not completed with fabricated Answers.
	const admission = await scheduler.admitCustom(author, {
		messageId: notificationId,
		deliveryMode: "deferred",
		customMessage: message,
		preemptsAgentWait: true,
		inspectProof: () => inspectDeliveryFailureNotice(author.identity.agentId, author.transcript.inspect(), message),
		isSuppressed: () => isShuttingDown() || inspectDelivery() === undefined,
	});
	if (admission !== "pending") throw new Error(`Author Delivery failure notification rejected: ${admission}`);
}
