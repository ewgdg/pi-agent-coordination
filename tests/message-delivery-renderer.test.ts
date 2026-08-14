import assert from "node:assert/strict";
import test from "node:test";

import {
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import type { OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import {
	MESSAGE_DELIVERY_CUSTOM_TYPE,
	type ModelVisibleMessage,
} from "../src/protocol/message-delivery.ts";
import { renderMessageDelivery } from "../src/tools/message-delivery-renderer.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("collapsed Message Delivery shows type, sender, and a two-line body snippet", () => {
	initTheme("dark");
	const fullBody = [
		"Context ".repeat(10),
		"second-line evidence. ",
		"More detail. ".repeat(20),
		"Distinctive ending.",
	].join("");
	const rendered = renderMessageDelivery(
		customDelivery([{
			kind: "message",
			messageId: "message-one",
			fromAgentId: "sender-agent",
			content: fullBody,
		}]),
		{ expanded: false, outputPad: 1 },
		plainTheme,
	).render(60).join("\n");

	assert.match(rendered, /Message/);
	assert.match(rendered, /from sender-agent/);
	assert.match(rendered, /second-line evidence/);
	assert.match(rendered, /…/);
	assert.doesNotMatch(rendered, /Distinctive ending/);
	assert.doesNotMatch(rendered, /\{"messages"/);
	assert.equal(
		rendered.split("\n").filter((line) => line.trim().length > 0).length,
		3,
	);
});

test("expanded Message Delivery shows each human-readable type and complete body", () => {
	initTheme("dark");
	const projections: ModelVisibleMessage[] = [
		{
			kind: "request",
			requestMessageId: "request-one",
			fromAgentId: "requester-agent",
			question: "Review the complete request body, including this final clause.",
		},
		{
			kind: "answer",
			answerId: "answer-one",
			requestMessageId: "request-one",
			fromAgentId: "responder-agent",
			answer: "The complete answer is available, including this final clause.",
		},
		{
			kind: "request_cancellation",
			cancellationId: "cancellation-one",
			requestMessageId: "request-two",
			fromAgentId: "cancelling-agent",
			reason: "The complete cancellation reason ends with this final clause.",
		},
	];
	const rendered = renderMessageDelivery(
		customDelivery(projections),
		{ expanded: true, outputPad: 1 },
		plainTheme,
	).render(120).join("\n");

	assert.match(rendered, /Request.*from requester-agent/s);
	assert.match(rendered, /Answer.*from responder-agent/s);
	assert.match(rendered, /Request cancellation.*from cancelling-agent/s);
	assert.match(rendered, /complete request body, including this final clause/);
	assert.match(rendered, /complete answer is available, including this final clause/);
	assert.match(rendered, /complete cancellation reason ends with this final clause/);
	assert.doesNotMatch(rendered, /requestMessageId|fromAgentId|\{"messages"/);
});

test("Owner and participant extensions register the Message Delivery renderer", async (t) => {
	const unavailableView = () => {
		throw new Error("Renderer registration does not execute coordination behavior");
	};
	const hosts = [
		await createTestOwnerHost(t, piAgentCoordination),
		await createTestOwnerHost(
			t,
			createAgentBoundExtension(
				unavailableView as () => OrdinaryAgentCoordinatorView,
			),
		),
	];

	for (const host of hosts) {
		assert.equal(
			typeof host.session.extensionRunner.getMessageRenderer(
				MESSAGE_DELIVERY_CUSTOM_TYPE,
			),
			"function",
		);
		await host.runtime.dispose();
	}
});

function customDelivery(projections: readonly ModelVisibleMessage[]) {
	return {
		role: "custom" as const,
		customType: MESSAGE_DELIVERY_CUSTOM_TYPE,
		content: JSON.stringify({ messages: projections }),
		display: true,
		details: {
			messages: projections.map((_, index) => ({
				agentId: "sender-agent",
				entryId: `entry-${index}`,
				toolCallId: `call-${index}`,
			})),
		},
		timestamp: 0,
	};
}
