import type { SessionManager } from "@earendil-works/pi-coding-agent";

import type { ToolCallPointer } from "./identities.ts";
import {
	inspectStandaloneMessageDelivery,
	type DeliveryInspection,
	type MessageDeliveryItem,
} from "./message-delivery.ts";

export function createCreationRequestDeliveryItem(options: {
	requestId: string;
	fromAgentId: string;
	question: string;
	source: ToolCallPointer;
}): MessageDeliveryItem {
	const { requestId, fromAgentId, question, source } = options;
	return {
		source,
		projection: { kind: "request", requestId, fromAgentId, question },
	};
}

export function inspectCreationRequestDelivery(options: {
	recipientAgentId: string;
	sessionManager: SessionManager;
	requestId: string;
	fromAgentId: string;
	question: string;
	source: ToolCallPointer;
}): DeliveryInspection {
	const {
		recipientAgentId,
		sessionManager,
		requestId,
		fromAgentId,
		question,
		source,
	} = options;
	return inspectStandaloneMessageDelivery({
		recipientAgentId,
		sessionManager,
		source,
		expectedProjection: {
			kind: "request",
			requestId,
			fromAgentId,
			question,
		},
		subject: `Creation Request ${requestId}`,
	});
}
