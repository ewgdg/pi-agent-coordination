import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { inspectCommittedAgentWaitResult } from "../src/protocol/agent-wait.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import {
	inspectAgentMessageAuthorResult,
	type Message,
} from "../src/protocol/message.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import {
	answerCallTargetAgentId,
	answerSourceDeliveryRequestId,
	answerSourceResultRequestId,
	findAuthoredAgentMessageSources,
	inspectCanonicalRequestResolution,
} from "../src/protocol/request-resolution.ts";

test("an Answer call resolves its target from the correlated delivered Request", () => {
	const responderAgentId = "answer-render-responder";
	const requesterAgentId = "answer-render-requester";
	const responder = SessionManager.inMemory(process.cwd(), { id: responderAgentId });
	responder.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: responderAgentId });
	const requestSource = {
		agentId: requesterAgentId,
		entryId: "request-entry",
		toolCallId: "request-call",
	};
	responder.appendCustomMessageEntry(
		"agent-coordination.message-delivery",
		JSON.stringify({
			messages: [{
				kind: "request",
				requestMessageId: deriveMessageIdentity(requestSource),
				fromAgentId: requesterAgentId,
				question: "Return the rendered Answer.",
			}],
		}),
		true,
		{ messages: [requestSource] },
	);
	const answerToolCallId = "rendered-answer-call";
	responder.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "answer",
				answer: "The rendered Answer.",
			}, { id: answerToolCallId }),
			{ stopReason: "toolUse" },
		),
	);

	assert.equal(answerCallTargetAgentId({
		responderAgentId,
		transcript: transcriptFromSessionManager(responder).inspect(),
		toolCallId: answerToolCallId,
	}), requesterAgentId);
});

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

test("Agent Wait result is requester-side Delivery proof for each returned Answer", () => {
	const requesterAgentId = "wait-result-requester";
	const requester = SessionManager.inMemory(process.cwd(), { id: requesterAgentId });
	requester.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: requesterAgentId,
	});
	const answerSource = {
		agentId: "wait-result-responder",
		entryId: "wait-answer-entry",
		toolCallId: "wait-answer-call",
	};
	const requestToolCallId = "request-before-agent-wait";
	const requestEntryId = requester.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "request",
				targetAgent: answerSource.agentId,
				question: "Return one Answer through Agent Wait.",
			}, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestMessageId = deriveMessageIdentity({
		agentId: requesterAgentId,
		entryId: requestEntryId,
		toolCallId: requestToolCallId,
	});
	const waitToolCallId = "agent-wait-call";
	requester.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_wait", {}, { id: waitToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const waitResult = {
		answers: [{
			disposition: "answer_delivered",
			requestMessageId,
			answerId: deriveMessageIdentity(answerSource),
			fromAgentId: answerSource.agentId,
			answer: "Recovered through the aggregate wait result.",
			answerSource,
		}],
	};
	requester.appendMessage({
		role: "toolResult",
		toolCallId: waitToolCallId,
		toolName: "agent_wait",
		content: [{ type: "text", text: JSON.stringify(waitResult) }],
		details: waitResult,
		isError: false,
		timestamp: Date.now(),
	});

	assert.equal(answerSourceDeliveryRequestId({
		requesterAgentId,
		transcript: transcriptFromSessionManager(requester).inspect(),
		source: answerSource,
	}), requestMessageId);
});

test("a completed Agent Wait rejects a Request authored after its call", () => {
	const requesterAgentId = "forged-wait-result-requester";
	const requester = SessionManager.inMemory(process.cwd(), { id: requesterAgentId });
	requester.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId: requesterAgentId });
	const waitToolCallId = "wait-before-forged-request";
	requester.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_wait", {}, { id: waitToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const laterRequestToolCallId = "request-after-wait";
	const laterRequestEntryId = requester.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "request",
				targetAgent: "later-responder",
				question: "This Request is outside the prior Wait snapshot.",
			}, { id: laterRequestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const laterRequestMessageId = deriveMessageIdentity({
		agentId: requesterAgentId,
		entryId: laterRequestEntryId,
		toolCallId: laterRequestToolCallId,
	});
	const answerSource = {
		agentId: "later-responder",
		entryId: "later-answer-entry",
		toolCallId: "later-answer-call",
	};
	const forgedResult = {
		answers: [{
			disposition: "answer_delivered",
			requestMessageId: laterRequestMessageId,
			answerId: deriveMessageIdentity(answerSource),
			fromAgentId: answerSource.agentId,
			answer: "This later Answer cannot belong to the earlier Wait.",
			answerSource,
		}],
	};
	requester.appendMessage({
		role: "toolResult",
		toolCallId: waitToolCallId,
		toolName: "agent_wait",
		content: [{ type: "text", text: JSON.stringify(forgedResult) }],
		details: forgedResult,
		isError: false,
		timestamp: Date.now(),
	});

	assert.throws(
		() => inspectCommittedAgentWaitResult({
			agentId: requesterAgentId,
			transcript: transcriptFromSessionManager(requester).inspect(),
			toolCallId: waitToolCallId,
		}),
		/outstanding Request snapshot order/,
	);
});

test("a preempted Agent Wait is a non-error result without Answer Delivery proof", () => {
	const requesterAgentId = "preempted-wait-requester";
	const requester = SessionManager.inMemory(process.cwd(), { id: requesterAgentId });
	requester.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: requesterAgentId,
	});
	const waitToolCallId = "preempted-agent-wait-call";
	requester.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_wait", {}, { id: waitToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const preempted = { disposition: "preempted" as const };
	requester.appendMessage({
		role: "toolResult",
		toolCallId: waitToolCallId,
		toolName: "agent_wait",
		content: [{ type: "text", text: JSON.stringify(preempted) }],
		details: preempted,
		isError: false,
		timestamp: Date.now(),
	});

	const transcript = transcriptFromSessionManager(requester).inspect();
	assert.deepEqual(inspectCommittedAgentWaitResult({
		agentId: requesterAgentId,
		transcript,
		toolCallId: waitToolCallId,
	}), {
		state: "preempted",
		resultEntryId: requester.getLeafEntry()?.id,
	});
	assert.equal(answerSourceDeliveryRequestId({
		requesterAgentId,
		transcript,
		source: {
			agentId: "unanswered-responder",
			entryId: "unanswered-entry",
			toolCallId: "unanswered-call",
		},
	}), undefined);
});

test("a schema-invalid Agent Message authors no protocol evidence before or after native rejection", () => {
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
	assert.deepEqual(findAuthoredAgentMessageSources({
		authorAgentId: agentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
	}), []);
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

test("a successful result cannot turn a malformed Agent Message into authored evidence", () => {
	const sessionManager = SessionManager.inMemory(process.cwd());
	const agentId = sessionManager.getSessionId();
	const toolCallId = "malformed-message-with-success";
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId });
	sessionManager.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_message", { operation: "status" }, { id: toolCallId }),
		{ stopReason: "toolUse" },
	));
	sessionManager.appendMessage({
		role: "toolResult", toolCallId, toolName: "agent_message",
		content: [{ type: "text", text: "Message sent." }],
		details: {}, isError: false, timestamp: Date.now(),
	});
	assert.throws(() => findAuthoredAgentMessageSources({
		authorAgentId: agentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
	}), /committed agent_message source .* is invalid/);
});

test("an answer-required rejection does not author a retryable Message", () => {
	const agentId = "answer-required-message-author";
	const toolCallId = "send-provisional-answer";
	const input = {
		operation: "send" as const,
		targetAgent: "requester-agent",
		content: "This provisional finding must remain local.",
	};
	const sessionManager = SessionManager.inMemory(process.cwd(), { id: agentId });
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId });
	const entryId = sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Answer required." }],
		details: {
			disposition: "rejected",
			reason: "answer_required",
			requestMessageId: "active-request",
		},
		isError: false,
		timestamp: Date.now(),
	});

	assert.equal(inspectAgentMessageAuthorResult({
		authorAgentId: agentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
		source: { agentId, entryId, toolCallId },
		input,
		resolvedTargetAgentId: input.targetAgent,
	}), "not_created");
});

test("selector-authored Message inspection accepts its resolved target identity", () => {
	const agentId = "selector-message-author";
	const targetAgentId = "agent-research-983c81e3";
	const toolCallId = "send-by-label";
	const input = {
		operation: "send" as const,
		targetAgent: "Researcher",
		content: "Inspect the canonical target binding.",
	};
	const sessionManager = SessionManager.inMemory(process.cwd(), { id: agentId });
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, { agentId });
	const entryId = sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const source = { agentId, entryId, toolCallId };
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Message admitted." }],
		details: {
			messageId: deriveMessageIdentity(source),
			targetAgentId,
			messageStatus: "sent",
		},
		isError: false,
		timestamp: Date.now(),
	});

	assert.equal(inspectAgentMessageAuthorResult({
		authorAgentId: agentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
		source,
		input,
		resolvedTargetAgentId: targetAgentId,
	}), "canonical");
});
