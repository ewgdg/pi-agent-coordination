import assert from "node:assert/strict";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentToolResult,
} from "@earendil-works/pi-coding-agent";

import type { TestOwnerHost } from "./pi-host.ts";

export async function executeRegisteredTool(
	session: AgentSession,
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(toolName, input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const tool = session.getToolDefinition(toolName);
	assert.ok(tool, toolName);
	return tool.execute(
		toolCallId,
		input as never,
		undefined,
		undefined,
		session.extensionRunner.createContext(),
	);
}

export async function executeAndCommitRegisteredTool(
	session: AgentSession,
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
	const result = await executeRegisteredTool(session, toolName, toolCallId, input);
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName,
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
	return result;
}

export async function selectAgent(
	host: TestOwnerHost,
	agentId: string,
): Promise<void> {
	host.ui.select = async (title, options) => {
		host.ui.agentViews.push({ title, options: [...options] });
		return options.find((option) => option.includes(agentId));
	};
	await host.runtime.session.prompt("/agents");
	assert.equal(host.runtime.session.sessionId, agentId);
}
