import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai";

/** Fake responders read the Request ID from the same visible Delivery as a model. */
export function latestRequestFromContext(context: { messages: readonly unknown[] }): { requestMessageId: string; fromAgentId: string } {
	for (const message of [...context.messages as Context["messages"]].reverse()) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type !== "text") continue;
			let payload: { messages?: Array<{ kind: string; requestMessageId: string; fromAgentId: string }> };
			try { payload = JSON.parse(part.text); } catch { continue; }
			const request = payload.messages?.findLast(item => item.kind === "request");
			if (request) return request;
		}
	}
	assert.fail("Fake responder needs a delivered Request");
}
