import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { inspectStandaloneMessageDelivery } from "../src/protocol/message-delivery.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";

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
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
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
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
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

test("Agent Request Delivery exposes requestMessageId as its correlation identity", () => {
	const sessionManager = SessionManager.inMemory(process.cwd());
	const recipientAgentId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: recipientAgentId,
	});
	const source = {
		agentId: "requester-agent",
		entryId: "requester-entry",
		toolCallId: "requester-call",
	};
	const projection = {
		kind: "request" as const,
		requestMessageId: "request-message",
		fromAgentId: "requester-agent",
		question: "Which identity should the Answer correlate to?",
	};
	sessionManager.appendCustomMessageEntry(
		"agent-coordination.message-delivery",
		JSON.stringify({ messages: [projection] }),
		true,
		{ messages: [source] },
	);
	const delivery = sessionManager.getLeafEntry();
	assert.ok(delivery);

	assert.deepEqual(inspectStandaloneMessageDelivery({
		recipientAgentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
		source,
		expectedProjection: projection,
		subject: "Request request-message",
	}).deliveryEvidence, {
		agentId: recipientAgentId,
		entryId: delivery.id,
	});
});

test("host-authored Obligation Reminders do not become Agent Message evidence", () => {
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
		messageId: "message-before-reminder",
		fromAgentId: "sender-agent",
		content: "Preserve this Delivery proof.",
	};
	sessionManager.appendCustomMessageEntry(
		"agent-coordination.message-delivery",
		JSON.stringify({ messages: [projection] }),
		true,
		{ messages: [source] },
	);
	const delivery = sessionManager.getLeafEntry();
	assert.ok(delivery);
	sessionManager.appendCustomMessageEntry(
		"agent-coordination.obligation-reminder",
		JSON.stringify({
			requestMessageId: "request-1",
			requestSnippet: "Answer the pending Request.",
			guidance:
				"You still owe an Answer to this Request. Call agent_message with operation \"answer\" now. Unless another obligation or independent task remains, end the turn immediately afterward.",
		}),
		true,
	);

	assert.deepEqual(inspectStandaloneMessageDelivery({
		recipientAgentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
		source,
		expectedProjection: projection,
		subject: "Message message-before-reminder",
	}).deliveryEvidence, {
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
			transcript: transcriptFromSessionManager(sessionManager).inspect(),
			source,
			expectedProjection: projection,
			subject: "Message repeated-message",
		}),
		/Message Delivery repeats a source/,
	);
});
