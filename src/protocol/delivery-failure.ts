import type { EntryPointer, ModelVisibleMessage } from "./message-delivery.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { ProtocolInvariantError } from "./identities.ts";
import { DELIVERY_FAILURE_CUSTOM_TYPE } from "./custom-entry-types.ts";

export type DeliveryFailureNotice = Readonly<{
	notificationId: string;
	messageId: string;
	requestMessageId?: string;
	recipientAgentId: string;
	messageKind: ModelVisibleMessage["kind"];
	failure: Readonly<{ reason: string; outcome: "confirmed_not_delivered" | "uncertain" }>;
	delivery: Readonly<{ disposition: "not_observed"; inspectedThrough: EntryPointer }>
		| Readonly<{ disposition: "indeterminate"; reason: "inspection_incomplete" }>;
}>;

export type ModelVisibleDeliveryFailure = Readonly<{
	customType: typeof DELIVERY_FAILURE_CUSTOM_TYPE;
	content: string;
	display: true;
}>;

export function createDeliveryFailureNotice(notice: DeliveryFailureNotice): ModelVisibleDeliveryFailure {
	return {
		customType: DELIVERY_FAILURE_CUSTOM_TYPE,
		display: true,
		content: JSON.stringify({ ...notice, guidance:
			"An admitted Message encountered a Delivery failure. This notice is not Delivery proof or a new Request. The evidence is a snapshot, not a guarantee of the current outcome; transport loss alone cannot prove non-Delivery. You may poll, explicitly retry the same identity, cancel an outstanding Request, or escalate. No retry, replacement Message or Request resolution was performed by this notification.",
		}),
	};
}

export function inspectDeliveryFailureNotice(
	agentId: string, transcript: TranscriptInspection, message: ModelVisibleDeliveryFailure,
): EntryPointer | undefined {
	const matches = coordinationEntries(transcript, agentId, `custom:${DELIVERY_FAILURE_CUSTOM_TYPE}`)
		.filter(entry => entry.type === "custom_message" && entry.customType === message.customType &&
			entry.content === message.content && entry.display);
	if (matches.length > 1) throw new ProtocolInvariantError("Delivery failure notice has duplicate Deliveries");
	return matches[0] ? { agentId, entryId: matches[0].id } : undefined;
}
