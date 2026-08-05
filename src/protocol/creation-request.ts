import type { ToolCallPointer } from "./identities.ts";

export const MESSAGE_DELIVERY_CUSTOM_TYPE = "agent-coordination.message-delivery";

export function createCreationRequestDelivery(options: {
	requestId: string;
	fromAgentId: string;
	question: string;
	source: ToolCallPointer;
}): {
	customType: typeof MESSAGE_DELIVERY_CUSTOM_TYPE;
	content: string;
	display: true;
	details: { messages: readonly [ToolCallPointer] };
} {
	const { requestId, fromAgentId, question, source } = options;
	return {
		customType: MESSAGE_DELIVERY_CUSTOM_TYPE,
		content: JSON.stringify({
			messages: [{ kind: "request", requestId, fromAgentId, question }],
		}),
		display: true,
		details: { messages: [source] },
	};
}
