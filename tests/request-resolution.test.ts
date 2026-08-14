import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import type { Message } from "../src/protocol/message.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import {
	answerSourceDeliveryRequestId,
	answerSourceResultRequestId,
	findAuthoredAgentMessageSources,
	inspectCanonicalRequestResolution,
} from "../src/protocol/request-resolution.ts";

test("Answer result and Delivery cannot correlate one source to different Requests", () => {
	const responderAgentId = "answer-correlation-responder";
	const responder = SessionManager.inMemory(process.cwd(), { id: responderAgentId });
	responder.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: responderAgentId,
	});
	const answerToolCallId = "answer-with-contradictory-delivery";
	const answerEntryId = responder.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "answer",
				answer: "One immutable Answer.",
			}, { id: answerToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const answerSource = {
		agentId: responderAgentId,
		entryId: answerEntryId,
		toolCallId: answerToolCallId,
	};
	const answerId = deriveMessageIdentity(answerSource);
	responder.appendMessage({
		role: "toolResult",
		toolCallId: answerToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Answer admitted." }],
		details: {
			messageId: answerId,
			requestMessageId: "request-a",
			messageStatus: "sent",
		},
		isError: false,
		timestamp: Date.now(),
	});
	const responderTranscript = transcriptFromSessionManager(responder).inspect();
	assert.equal(answerSourceResultRequestId({
		transcript: responderTranscript,
		source: answerSource,
	}), "request-a");

	const requesterAgentId = "answer-correlation-requester";
	const requester = SessionManager.inMemory(process.cwd(), { id: requesterAgentId });
	requester.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: requesterAgentId,
	});
	requester.appendCustomMessageEntry(
		"agent-coordination.message-delivery",
		JSON.stringify({
			messages: [{
				kind: "answer",
				answerId,
				requestMessageId: "request-b",
				fromAgentId: responderAgentId,
				answer: "One immutable Answer.",
			}],
		}),
		true,
		{ messages: [answerSource] },
	);
	const request: Extract<Message, { kind: "request" }> = {
		kind: "request",
		origin: "agent_message",
		messageId: "request-b",
		workflowId: "answer-correlation-workflow",
		fromAgentId: requesterAgentId,
		targetAgentId: responderAgentId,
		deliveryMode: "deferred",
		source: {
			agentId: requesterAgentId,
			entryId: "request-entry",
			toolCallId: "request-call",
		},
		question: "Which Request owns the Answer?",
	};
	assert.throws(
		() => inspectCanonicalRequestResolution({
			request,
			requesterTranscript: transcriptFromSessionManager(requester).inspect(),
			responderTranscript,
		}),
		/result and Delivery name different Requests/,
	);
});

test("Delivery-only Answer correlation skips another Request from the same requester", () => {
	const responderAgentId = "delivery-only-answer-responder";
	const responder = SessionManager.inMemory(process.cwd(), { id: responderAgentId });
	responder.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: responderAgentId,
	});
	const answerToolCallId = "delivery-only-answer";
	const answerEntryId = responder.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "answer",
				answer: "Delivery alone ratifies this Answer.",
			}, { id: answerToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const answerSource = {
		agentId: responderAgentId,
		entryId: answerEntryId,
		toolCallId: answerToolCallId,
	};
	const answerId = deriveMessageIdentity(answerSource);
	const requesterAgentId = "shared-answer-requester";
	const requester = SessionManager.inMemory(process.cwd(), { id: requesterAgentId });
	requester.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: requesterAgentId,
	});
	requester.appendCustomMessageEntry(
		"agent-coordination.message-delivery",
		JSON.stringify({
			messages: [{
				kind: "answer",
				answerId,
				requestMessageId: "request-b",
				fromAgentId: responderAgentId,
				answer: "Delivery alone ratifies this Answer.",
			}],
		}),
		true,
		{ messages: [answerSource] },
	);
	const request = (messageId: string): Extract<Message, { kind: "request" }> => ({
		kind: "request",
		origin: "agent_message",
		messageId,
		workflowId: "delivery-only-workflow",
		fromAgentId: requesterAgentId,
		targetAgentId: responderAgentId,
		deliveryMode: "deferred",
		source: {
			agentId: requesterAgentId,
			entryId: `${messageId}-entry`,
			toolCallId: `${messageId}-call`,
		},
		question: `Resolve ${messageId}.`,
	});
	const requesterTranscript = transcriptFromSessionManager(requester).inspect();
	const responderTranscript = transcriptFromSessionManager(responder).inspect();
	assert.deepEqual(inspectCanonicalRequestResolution({
		request: request("request-a"),
		requesterTranscript,
		responderTranscript,
	}), {});
	assert.equal(inspectCanonicalRequestResolution({
		request: request("request-b"),
		requesterTranscript,
		responderTranscript,
	}).answer?.requestId, "request-b");

	responder.appendMessage({
		role: "toolResult",
		toolCallId: answerToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Answer execution failed." }],
		details: {},
		isError: true,
		timestamp: Date.now(),
	});
	assert.throws(
		() => inspectCanonicalRequestResolution({
			request: request("request-b"),
			requesterTranscript,
			responderTranscript: transcriptFromSessionManager(responder).inspect(),
		}),
		/error result and Delivery/,
	);
});

test("native Answer Retrieval reconstructs result-less Answer correlation", () => {
	const requesterAgentId = "answer-retrieval-requester";
	const requester = SessionManager.inMemory(process.cwd(), { id: requesterAgentId });
	requester.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: requesterAgentId,
	});
	const answerSource = {
		agentId: "answer-retrieval-responder",
		entryId: "answer-source-entry",
		toolCallId: "answer-source-call",
	};
	requester.appendMessage({
		role: "toolResult",
		toolCallId: "retry-request-call",
		toolName: "agent_message",
		content: [{ type: "text", text: "Retrieved committed Answer." }],
		details: {
			disposition: "answer_delivered",
			requestMessageId: "retrieved-request",
			answerId: deriveMessageIdentity(answerSource),
			fromAgentId: answerSource.agentId,
			answer: "Recovered without an Answer author result.",
			answerSource,
		},
		isError: false,
		timestamp: Date.now(),
	});
	assert.equal(answerSourceDeliveryRequestId({
		requesterAgentId,
		transcript: transcriptFromSessionManager(requester).inspect(),
		source: answerSource,
	}), "retrieved-request");
});

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
