import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("native Agent Message rendering shows bounded Steer intent and typed disposition", async () => {
	const host = await createTestOwnerHost(piAgentCoordination);
	const tool = host.session.getToolDefinition("agent_message");
	assert.ok(tool?.renderCall);
	assert.ok(tool.renderResult);
	const parameters = tool.parameters as unknown as {
		anyOf?: Array<{
			properties?: Record<string, {
				const?: unknown;
				anyOf?: Array<{ const?: unknown }>;
			}>;
		}>;
	};
	const sendSchema = parameters.anyOf?.find(
		(candidate) => candidate.properties?.operation?.const === "send",
	);
	assert.deepEqual(
		sendSchema?.properties?.deliveryMode?.anyOf?.map(({ const: value }) => value),
		["deferred", "steer"],
	);
	const longContent = "Direction ".repeat(20).trim();
	const args = {
		operation: "send" as const,
		targetAgentId: "recipient-agent",
		content: longContent,
		deliveryMode: "steer" as const,
	};
	const renderContext = {
		args,
		toolCallId: "render-message",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: host.cwd,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		executionStarted: true,
	};
	const callText = tool.renderCall(args, plainTheme, renderContext).render(160).join("\n");
	assert.match(callText, /recipient-agent/);
	assert.match(callText, /steer/);
	assert.equal(callText.includes(longContent), false);
	assert.match(callText, /…/);

	const messageId = "source-derived-message-identity";
	const resultText = tool.renderResult(
		{
			content: [{ type: "text", text: "scheduling receipt" }],
			details: { messageId, delivery: "pending" },
		},
		{ expanded: false, isPartial: false },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.match(resultText, /pending/);
	assert.match(resultText, new RegExp(messageId));

	const deferredText = tool.renderCall(
		{
			operation: "send",
			targetAgentId: "recipient-agent",
			content: "Routine direction.",
		},
		plainTheme,
		{ ...renderContext, args: {
			operation: "send",
			targetAgentId: "recipient-agent",
			content: "Routine direction.",
		} },
	).render(160).join("\n");
	assert.equal(deferredText.includes("deferred"), false);

	await host.runtime.dispose();
});
