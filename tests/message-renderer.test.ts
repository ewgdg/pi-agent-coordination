import assert from "node:assert/strict";
import test from "node:test";

import {
	initTheme,
	type AgentToolResult,
	type Theme,
} from "@earendil-works/pi-coding-agent";

import type { AgentMessageReceipt } from "../src/coordination/message-receipts.ts";
import type { AgentMessageInput } from "../src/protocol/agent-message-input.ts";
import {
	renderAgentMessageCall,
	renderAgentMessageResult,
} from "../src/tools/message-renderer.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const targetAgentId = "019fa1ff-6e95-761e-b4ce-7415983c81e3";
const resolveLabel = (agentId: string) =>
	agentId === targetAgentId ? "Researcher" : undefined;

function renderCall(args: AgentMessageInput, width = 60): string {
	initTheme("dark");
	return renderAgentMessageCall(args, plainTheme, resolveLabel)
		.render(width)
		.join("\n");
}

function renderResult(
	receipt: AgentMessageReceipt,
	expanded: boolean,
	width = 60,
): string {
	initTheme("dark");
	const result: AgentToolResult<AgentMessageReceipt> = {
		content: [],
		details: receipt,
	};
	return renderAgentMessageResult(result, { expanded, isPartial: false }, plainTheme)
		.render(width)
		.join("\n");
}

test("send call shows the [Send] badge, compact target identity, and bounded content preview", () => {
	const rendered = renderCall({
		operation: "send",
		targetAgentId,
		content: "Context ".repeat(100) + "Distinctive ending.",
	});
	assert.match(rendered, /\[Send\]/);
	assert.match(rendered, /to Researcher · 983c81e3/);
	assert.doesNotMatch(rendered, new RegExp(targetAgentId));
	assert.doesNotMatch(rendered, /\{"messages"/);
	assert.match(rendered, /Context/);
	assert.match(rendered, /…/);
	assert.doesNotMatch(rendered, /Distinctive ending/);
});

test("collapsed send call preserves formatting within ten visible body rows", () => {
	const rendered = renderCall({
		operation: "send",
		targetAgentId,
		content: "First line.\n\nThird line.",
	});
	assert.match(rendered, /First line\.\n\nThird line\.$/);
	assert.doesNotMatch(rendered, /…/);
});

test("send call marks steer delivery", () => {
	const rendered = renderCall({
		operation: "send",
		targetAgentId,
		content: "Act now.",
		deliveryMode: "steer",
	});
	assert.match(rendered, /\[Send\]/);
	assert.match(rendered, /steer/);
	assert.match(rendered, /Act now\./);
});

test("request call shows the [Request] badge and question preview", () => {
	const rendered = renderCall({
		operation: "request",
		targetAgentId,
		question: "Please review the design proposal.",
	});
	assert.match(rendered, /\[Request\]/);
	assert.match(rendered, /to Researcher · 983c81e3/);
	assert.match(rendered, /review the design proposal/);
	assert.doesNotMatch(rendered, /\[Send\]/);
});

test("request call marks steer delivery", () => {
	const rendered = renderCall({
		operation: "request",
		targetAgentId,
		question: "Please proceed immediately.",
		deliveryMode: "steer",
	});
	assert.match(rendered, /\[Request\]/);
	assert.match(rendered, /steer/);
	assert.match(rendered, /proceed immediately/);
});

test("expanded call shows the complete payload without an ellipsis", () => {
	initTheme("dark");
	const body = "Context ".repeat(30) + "Distinctive ending.";
	const rendered = renderAgentMessageCall(
		{ operation: "send", targetAgentId, content: body },
		plainTheme,
		resolveLabel,
		true,
	).render(60).join("\n");
	assert.match(rendered, /\[Send\]/);
	assert.match(rendered, /Distinctive ending/);
	assert.doesNotMatch(rendered, /…/);
});

test("answer and cancel calls show their own badges with payload and correlation", () => {
	const answer = renderCall({
		operation: "answer",
		answer: "The answer is accepted.",
	});
	assert.match(answer, /\[Answer\]/);
	assert.match(answer, /answer is accepted/);

	const cancel = renderCall({
		operation: "cancel",
		requestMessageId: "request-nine",
		reason: "No longer needed.",
	});
	assert.match(cancel, /\[Cancel\]/);
	assert.match(cancel, /request-nine/);
	assert.match(cancel, /No longer needed/);
});

test("poll and retry calls show their badges and message id without a body preview", () => {
	for (const operation of ["poll", "retry"] as const) {
		const rendered = renderCall({
			operation,
			messageId: "message-three",
		});
		assert.match(rendered, new RegExp(`\\[${operation === "poll" ? "Poll" : "Retry"}\\]`));
		assert.match(rendered, /message-three/);
		assert.equal(
			rendered.split("\n").filter((line) => line.trim().length > 0).length,
			1,
		);
	}
});

test("collapsed result shows disposition and ids without exposing the receipt", () => {
	const rendered = renderResult({
		disposition: "delivered",
		messageId: "message-one",
		deliveryEvidence: { agentId: "observer-agent", entryId: "entry-7" },
	}, false);
	assert.match(rendered, /delivered/);
	assert.match(rendered, /message-one/);
	assert.doesNotMatch(rendered, /deliveryEvidence|entry-7/);
});

test("expanded result exposes the complete structured receipt", () => {
	const rendered = renderResult({
		disposition: "delivered",
		messageId: "message-one",
		deliveryEvidence: { agentId: "observer-agent", entryId: "entry-7" },
	}, true);
	assert.match(rendered, /"disposition": "delivered"/);
	assert.match(rendered, /"deliveryEvidence"/);
	assert.match(rendered, /"entry-7"/);
});

test("answer_delivered result shows the shared bounded answer preview with truncation", () => {
	const answer = "The complete answer body ".repeat(20) + "Distinctive tail.";
	const rendered = renderResult({
		disposition: "answer_delivered",
		requestMessageId: "request-one",
		answerId: "answer-one",
		fromAgentId: "responder-agent",
		answer,
		answerSource: {
			agentId: "responder-agent",
			entryId: "entry-2",
			toolCallId: "call-2",
		},
	}, false, 30);
	assert.match(rendered, /answer_delivered/);
	assert.match(rendered, /answer · answer-one/);
	assert.match(rendered, /complete answer body/);
	assert.match(rendered, /…/);
	assert.doesNotMatch(rendered, /Distinctive tail/);
});

test("not_sent result surfaces the rejection reason", () => {
	const rendered = renderResult({
		messageStatus: "not_sent",
		reason: "target_unavailable",
		messageId: "message-two",
	}, false);
	assert.match(rendered, /not_sent/);
	assert.match(rendered, /target_unavailable/);
});

test("badges and reason lines use the delivered-message theme roles", () => {
	initTheme("dark");
	const calls: Array<[string, string]> = [];
	const recordingTheme = {
		fg: (color: string, text: string) => {
			calls.push([color, text]);
			return text;
		},
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	renderAgentMessageCall(
		{ operation: "send", targetAgentId, content: "Act now." },
		recordingTheme,
		resolveLabel,
	).render(60);
	assert.ok(
		calls.some(([color, text]) => color === "customMessageLabel" && text === "[Send]"),
		"send badge must use the customMessageLabel role",
	);

	calls.length = 0;
	renderAgentMessageResult(
		{
			content: [],
			details: {
				messageStatus: "not_sent",
				reason: "target_unavailable",
				messageId: "message-two",
			},
		},
		{ expanded: false, isPartial: false },
		recordingTheme,
	).render(60);
	assert.ok(
		calls.some(([color, text]) => color === "error" && text === "target_unavailable"),
		"not_sent reason must use the error role",
	);

	calls.length = 0;
	renderAgentMessageResult(
		{
			content: [],
			details: {
				messageStatus: "unknown",
				reason: "confirmation_lost",
				messageId: "message-three",
			},
		},
		{ expanded: false, isPartial: false },
		recordingTheme,
	).render(60);
	assert.ok(
		calls.some(([color, text]) => color === "warning" && text === "confirmation_lost"),
		"unknown reason must use the warning role",
	);
});
