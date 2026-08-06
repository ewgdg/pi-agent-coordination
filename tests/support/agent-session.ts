import assert from "node:assert/strict";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

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
	const { command, surface } = await openAgentsSurface(host);
	while (surface.render(80).some((line) => line.includes("Agents / "))) {
		surface.handleInput?.("h");
	}
	if (!selectAgentInCurrentTree(surface, agentId, host.session.sessionId)) {
		surface.handleInput?.("\x1b");
		await command;
		assert.fail(`Agent ${agentId} is absent from the Live selector hierarchy`);
	}
	await command;
	assert.equal(host.runtime.session.sessionId, agentId);
}

export async function openAgentsSurface(
	host: TestOwnerHost,
): Promise<Readonly<{ command: Promise<void>; surface: Component }>> {
	const command = host.runtime.session.prompt("/agents");
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	return { command, surface: host.ui.customSurfaces[0]! };
}

function selectAgentInCurrentTree(
	surface: NonNullable<TestOwnerHost["ui"]["customSurfaces"][number]>,
	targetAgentId: string,
	ownerAgentId: string,
): boolean {
	const firstRender = surface.render(80).join("\n");
	let currentRender = firstRender;
	do {
		if (focusedDetailsShowAgent(surface, targetAgentId)) {
			surface.handleInput?.("\r");
			return true;
		}
		if (!focusedDetailsShowAgent(surface, ownerAgentId)) {
			const beforeZoom = currentRender;
			surface.handleInput?.("l");
			const afterZoom = surface.render(80).join("\n");
			if (afterZoom !== beforeZoom) {
				if (selectAgentInCurrentTree(surface, targetAgentId, ownerAgentId)) return true;
				surface.handleInput?.("h");
			}
		}
		surface.handleInput?.("j");
		currentRender = surface.render(80).join("\n");
	} while (currentRender !== firstRender);
	return false;
}

function focusedDetailsShowAgent(
	surface: NonNullable<TestOwnerHost["ui"]["customSurfaces"][number]>,
	targetAgentId: string,
): boolean {
	const lines = surface.render(80);
	const selectedRow = lines.findIndex((line) => line.includes("→"));
	if (selectedRow < 0) return false;
	return lines
		.slice(selectedRow + 1, selectedRow + 5)
		.some((line) => line.slice(1, -1).trim() === targetAgentId);
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Timed out waiting for the /agents custom surface");
}
