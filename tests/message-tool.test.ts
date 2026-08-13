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
	assert.deepEqual(
		parameters.anyOf?.map((candidate) => candidate.properties?.operation?.const),
		["send", "request", "answer", "cancel", "poll", "retry"],
	);
	const cancelSchema = parameters.anyOf?.find(
		(candidate) => candidate.properties?.operation?.const === "cancel",
	);
	assert.deepEqual(Object.keys(cancelSchema?.properties ?? {}).sort(), [
		"operation",
		"reason",
		"requestMessageId",
	]);
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

	const answerText = tool.renderCall(
		{
			operation: "answer",
			requestId: "request-identity",
			answer: "One canonical Answer.",
		},
		plainTheme,
		{ ...renderContext, args: {
			operation: "answer",
			requestId: "request-identity",
			answer: "One canonical Answer.",
		} },
	).render(160).join("\n");
	assert.match(answerText, /request-identity/);
	assert.match(answerText, /One canonical Answer/);

	const cancellationText = tool.renderCall(
		{
			operation: "cancel",
			requestMessageId: "request-message-identity",
			reason: "The result is no longer needed.",
		},
		plainTheme,
		{ ...renderContext, args: {
			operation: "cancel",
			requestMessageId: "request-message-identity",
			reason: "The result is no longer needed.",
		} },
	).render(160).join("\n");
	assert.match(cancellationText, /request-message-identity/);

	const existingCancellationText = tool.renderResult(
		{
			content: [{ type: "text", text: "already cancelled" }],
			details: {
				disposition: "already_cancelled",
				cancellationMessageId: "cancellation-message-identity",
			},
		},
		{ expanded: false, isPartial: false },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.match(existingCancellationText, /cancellation-message-identity/);

	const retrievalText = tool.renderResult(
		{
			content: [{ type: "text", text: "retrieved Answer" }],
			details: {
				disposition: "answer_delivered",
				messageId: "request-identity",
				requestId: "request-identity",
				answerId: "answer-identity",
				fromAgentId: "responder-agent",
				answer: "Recovered immutable Answer.",
				answerSource: {
					agentId: "responder-agent",
					entryId: "answer-entry",
					toolCallId: "answer-call",
				},
			},
		},
		{ expanded: false, isPartial: false },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.match(retrievalText, /answer_delivered/);
	assert.match(retrievalText, /answer-identity/);
	assert.match(retrievalText, /Recovered immutable Answer/);

	await host.runtime.dispose();
});

test("native Agent Spawn rendering exposes verified runtime configuration only in resolved receipts", async () => {
	const host = await createTestOwnerHost(piAgentCoordination);
	const tool = host.session.getToolDefinition("agent_spawn");
	assert.ok(tool?.renderCall);
	assert.ok(tool.renderResult);
	const args = {
		request: "Investigate the configured repository.",
		template: "research-agent",
		label: "Researcher",
		description: "Primary-source investigation",
		config: {
			cwd: "subproject",
			model: { id: "inherit", thinking: "high" as const },
		},
	};
	const renderContext = {
		args,
		toolCallId: "render-spawn",
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
	assert.match(callText, /Researcher/);
	assert.match(callText, /Primary-source investigation/);

	const effectiveConfiguration = {
		cwd: "/work/subproject",
		model: { provider: "provider", modelId: "model" },
		thinking: "high" as const,
		tools: ["read", "agent_message"],
		skills: ["research"],
		extensions: ["/extensions/research.ts"],
		projectContext: { mode: "append" as const, body: "Configured context" },
	};
	const receipt = {
		disposition: "pending" as const,
		agentId: "agent-identity-1234567890",
		requestId: "request-identity",
		effectiveConfiguration,
	};
	const collapsedText = tool.renderResult(
		{ content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt },
		{ expanded: false, isPartial: false },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.match(collapsedText, /pending/);
	assert.match(collapsedText, /provider\/model/);
	assert.match(collapsedText, /high/);
	assert.equal(collapsedText.includes(effectiveConfiguration.cwd), false);

	const expandedText = tool.renderResult(
		{ content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt },
		{ expanded: true, isPartial: false },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.match(expandedText, /\/work\/subproject/);
	assert.match(expandedText, /agent_message/);
	assert.match(expandedText, /Configured context/);

	const partialText = tool.renderResult(
		{ content: [{ type: "text", text: "starting" }], details: undefined },
		{ expanded: false, isPartial: true },
		plainTheme,
		renderContext,
	).render(160).join("\n");
	assert.equal(partialText.includes("provider/model"), false);

	await host.runtime.dispose();
});
