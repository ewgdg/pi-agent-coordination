import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { inspectStandaloneMessageDelivery } from "../src/protocol/message-delivery.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";

test("each Message in one ordered batch has independent Delivery proof", () => {
	const sessionManager = SessionManager.inMemory(process.cwd());
	const recipientAgentId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: recipientAgentId,
	});
	const firstSource = {
		agentId: "sender-agent",
		entryId: "sender-entry-one",
		toolCallId: "sender-call-one",
	};
	const secondSource = {
		agentId: "sender-agent",
		entryId: "sender-entry-two",
		toolCallId: "sender-call-two",
	};
	sessionManager.appendCustomMessageEntry(
		"agent-coordination.message-delivery",
		JSON.stringify({
			messages: [
				{
					kind: "message",
					messageId: "message-one",
					fromAgentId: "sender-agent",
					content: "First admitted direction.",
				},
				{
					kind: "message",
					messageId: "message-two",
					fromAgentId: "sender-agent",
					content: "Second admitted direction.",
				},
			],
		}),
		true,
		{ messages: [firstSource, secondSource] },
	);
	const delivery = sessionManager.getLeafEntry();
	assert.ok(delivery);

	const first = inspectStandaloneMessageDelivery({
		recipientAgentId,
		sessionManager,
		source: firstSource,
		expectedProjection: {
			kind: "message",
			messageId: "message-one",
			fromAgentId: "sender-agent",
			content: "First admitted direction.",
		},
		subject: "Message message-one",
	});
	const second = inspectStandaloneMessageDelivery({
		recipientAgentId,
		sessionManager,
		source: secondSource,
		expectedProjection: {
			kind: "message",
			messageId: "message-two",
			fromAgentId: "sender-agent",
			content: "Second admitted direction.",
		},
		subject: "Message message-two",
	});

	assert.deepEqual(first.deliveryEvidence, {
		agentId: recipientAgentId,
		entryId: delivery.id,
	});
	assert.deepEqual(second.deliveryEvidence, {
		agentId: recipientAgentId,
		entryId: delivery.id,
	});
});

test("one Delivery batch cannot repeat a Message source", () => {
	const sessionManager = SessionManager.inMemory(process.cwd());
	const recipientAgentId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: recipientAgentId,
	});
	const source = {
		agentId: "sender-agent",
		entryId: "sender-entry",
		toolCallId: "sender-call",
	};
	const projection = {
		kind: "message" as const,
		messageId: "repeated-message",
		fromAgentId: "sender-agent",
		content: "This source must appear only once.",
	};
	sessionManager.appendCustomMessageEntry(
		"agent-coordination.message-delivery",
		JSON.stringify({ messages: [projection, projection] }),
		true,
		{ messages: [source, source] },
	);

	assert.throws(
		() => inspectStandaloneMessageDelivery({
			recipientAgentId,
			sessionManager,
			source,
			expectedProjection: projection,
			subject: "Message repeated-message",
		}),
		/Message Delivery repeats a source/,
	);
});
