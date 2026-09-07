import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import {
	renderAgentWaitCall,
	renderAgentWaitResult,
} from "../src/tools/coordination-renderers.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const labels = new Map([
	["a2", "Researcher"],
	["a3", "Reviewer"],
]);
const resolveAgentLabel = (agentId: string) => labels.get(agentId);

function renderContext() {
	return {
		args: {},
		toolCallId: "render-agent-wait",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		executionStarted: true,
	};
}

test("Agent Wait rendering shows snapshot responders, then their Answers", () => {
	const context = renderContext();
	const call = renderAgentWaitCall({}, plainTheme).render(120).join("\n");
	assert.equal(call.trim(), "wait");

	const progress = {
		waitingFor: [
			{ requestMessageId: "request-research", responderAgentId: "a2" },
			{ requestMessageId: "request-review", responderAgentId: "a3" },
		],
	};
	const waiting = renderAgentWaitResult(
		{ content: [{ type: "text", text: "waiting" }], details: progress },
		{ expanded: false, isPartial: true },
		plainTheme,
		context,
		resolveAgentLabel,
	).render(120).join("\n");
	assert.equal(
		waiting.split("\n").map((line) => line.trimEnd()).join("\n"),
		[
			"waiting for 2 Answers…",
			"• Researcher · a2",
			"• Reviewer · a3",
		].join("\n"),
	);
	assert.doesNotMatch(waiting, /request-research/);

	const answers = {
		answers: [
			{
				disposition: "answer_delivered" as const,
				requestMessageId: "request-research",
				answerId: "answer-research",
				fromAgentId: "a2",
				answer: "The implementation is viable.",
				answerSource: {
					workflowId: "workflow",
					agentId: "a2",
					entryId: "answer-entry-research",
					toolCallId: "answer-call-research",
				},
			},
			{
				disposition: "answer_delivered" as const,
				requestMessageId: "request-review",
				answerId: "answer-review",
				fromAgentId: "a3",
				answer: "The race handling is sound.",
				answerSource: {
					workflowId: "workflow",
					agentId: "a3",
					entryId: "answer-entry-review",
					toolCallId: "answer-call-review",
				},
			},
		],
	};
	const completed = renderAgentWaitResult(
		{ content: [{ type: "text", text: JSON.stringify(answers) }], details: answers },
		{ expanded: false, isPartial: false },
		plainTheme,
		context,
		resolveAgentLabel,
	).render(120).join("\n");
	assert.match(completed, /2 Answers/);
	assert.match(
		completed,
		/\[Answer\] from Researcher · a2\s*\nThe implementation is viable\./,
	);
	assert.match(
		completed,
		/\[Answer\] from Reviewer · a3\s*\nThe race handling is sound\./,
	);
	assert.doesNotMatch(
		completed,
		/Researcher · a2[^\n]*The implementation is viable\./,
	);
	assert.doesNotMatch(completed, /answerSource/);
});
