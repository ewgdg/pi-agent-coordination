import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import { findAuthoredAgentMessageSources } from "../src/protocol/request-resolution.ts";

test("a schema-rejected agent_message call is not authored protocol evidence", () => {
	const agentId = "schema-rejected-message-author";
	const rejectedToolCallId = "invalid-cancel-arguments";
	const sessionManager = SessionManager.inMemory(process.cwd(), { id: agentId });
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId });
	sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "cancel",
				messageId: "request-id-was-supplied-under-the-wrong-key",
				reason: "Cancel the Request.",
			}, { id: rejectedToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: rejectedToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Validation failed for tool agent_message" }],
		details: {},
		isError: true,
		timestamp: Date.now(),
	});

	assert.deepEqual(findAuthoredAgentMessageSources({
		authorAgentId: agentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
	}), []);
});
