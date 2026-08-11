import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	createAgentBoundExtension,
	createModeratorBoundExtension,
} from "../src/bootstrap/agent-extension.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import type { MessageBoundaryHooks } from "../src/coordination/workflow-coordinator.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import type { AgentRunState } from "../src/runtime/agent-runtime-supervisor.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

test("Request commitment retains its requester and Delivery obligates its responder", async () => {
	const harness = await createDormantChildHarness();
	assert.equal(harness.view.status(harness.childId).run.phase, "dormant");

	const input = {
		operation: "request" as const,
		targetAgentId: harness.childId,
		question: "Which exact transcript fact proves the release handoff?",
	};
	const toolCallId = "request-release-proof";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const sourceEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(sourceEntry);
	const source = {
		agentId: harness.host.session.sessionId,
		entryId: sourceEntry.id,
		toolCallId,
	};
	const requestId = deriveMessageId(source);

	harness.host.model.setResponses([
		fauxAssistantMessage("I received the correlated Request."),
	]);
	const receipt = await harness.view.message(toolCallId, input);
	assert.deepEqual(receipt, {
		messageId: requestId,
		requestId,
		delivery: "pending",
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});
	assert.equal(retentionCount(harness.view.status().run, "awaiting_answer"), 2);

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const deliveryEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [source] }),
	);
	const delivery = deliveryEntries.find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [source] }),
	);
	assert.ok(delivery && delivery.type === "custom_message");
	assert.deepEqual(JSON.parse(delivery.content as string), {
		messages: [
			{
				kind: "request",
				requestId,
				fromAgentId: harness.host.session.sessionId,
				question: input.question,
			},
		],
	});
	await waitForCondition(() =>
		retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 1,
	);
	const retryToolCallId = "retry-delivered-unanswered-request";
	const retryInput = { operation: "retry" as const, messageId: requestId };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(await harness.view.message(retryToolCallId, retryInput), {
		disposition: "request_delivered",
		messageId: requestId,
		requestId,
		deliveryEvidence: {
			agentId: harness.childId,
			entryId: delivery.id,
		},
	});

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("status reports exact Request retention multiplicity", async () => {
	const harness = await createDormantChildHarness({
		beforeDeliveryAdmission: () => "confirmed_failure",
	});
	assert.equal(retentionCount(harness.view.status().run, "awaiting_answer"), 1);

	const requestIds: string[] = [];
	for (const suffix of ["first", "second"]) {
		const toolCallId = `request-retention-${suffix}`;
		const input = {
			operation: "request" as const,
			targetAgentId: harness.childId,
			question: `Retain the ${suffix} exact Request.`,
		};
		harness.host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_message", input, { id: toolCallId }),
				{ stopReason: "toolUse" },
			),
		);
		const receipt = await harness.view.message(toolCallId, input);
		assert.ok("requestId" in receipt);
		requestIds.push(receipt.requestId);
		harness.host.session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "agent_message",
			content: [{ type: "text", text: JSON.stringify(receipt) }],
			details: receipt,
			isError: false,
			timestamp: Date.now(),
		});
	}
	assert.equal(retentionCount(harness.view.status().run, "awaiting_answer"), 3);

	const requestId = requestIds[0];
	assert.ok(requestId);
	const cancelToolCallId = "cancel-one-of-several-retained-requests";
	const cancelInput = {
		operation: "cancel" as const,
		requestId,
		reason: "Resolve only this exact Request relationship.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellation = await harness.view.message(cancelToolCallId, cancelInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});
	assert.equal(retentionCount(harness.view.status().run, "awaiting_answer"), 2);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Request retry reports indeterminate when admission confirmation is lost", async () => {
	const harness = await createDormantChildHarness({
		beforeDeliveryAdmission: ({ operation }) =>
			operation === "send" ? "confirmed_failure" : undefined,
		afterDeliveryAdmission: ({ operation }) =>
			operation === "retry" ? "confirmation_lost" : undefined,
	});
	const requestToolCallId = "request-before-lost-retry-confirmation";
	const requestInput = {
		operation: "request" as const,
		targetAgentId: harness.childId,
		question: "Retry this same Request after its initial admission fails.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const request = await harness.view.message(requestToolCallId, requestInput);
	assert.ok("requestId" in request);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(request) }],
		details: request,
		isError: false,
		timestamp: Date.now(),
	});

	harness.host.model.setResponses([
		fauxAssistantMessage("The retried Request reached its responder."),
	]);
	const retryToolCallId = "retry-with-lost-admission-confirmation";
	const retryInput = {
		operation: "retry" as const,
		messageId: request.requestId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(await harness.view.message(retryToolCallId, retryInput), {
		disposition: "indeterminate",
		messageId: request.requestId,
		reason: "confirmation_lost",
	});

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("only the fixed responder may Answer and only the requester may cancel", async () => {
	const harness = await createDormantChildHarness();
	const requestInput = {
		operation: "request" as const,
		targetAgentId: harness.childId,
		question: "Keep participant authority fixed by this Request.",
	};
	const requestToolCallId = "request-participant-authority";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const unauthorizedCancelCallId = "responder-cannot-cancel-request";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "cancel",
					requestId,
					reason: "A responder cannot abandon the requester's wait.",
				},
				{ id: unauthorizedCancelCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Participant authority remains unchanged."),
	]);
	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === unauthorizedCancelCallId,
	);
	const unauthorizedCancellation = entries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === unauthorizedCancelCallId,
	);
	if (
		!unauthorizedCancellation ||
		unauthorizedCancellation.type !== "message" ||
		unauthorizedCancellation.message.role !== "toolResult"
	) {
		throw new Error("Unauthorized Cancellation result did not commit");
	}
	assert.equal(unauthorizedCancellation.message.isError, true);
	assert.match(
		JSON.stringify(unauthorizedCancellation.message.content),
		/wrong_participant/,
	);

	const unauthorizedAnswerCallId = "requester-cannot-answer-own-request";
	const unauthorizedAnswerInput = {
		operation: "answer" as const,
		requestId,
		answer: "The requester cannot impersonate the responder.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", unauthorizedAnswerInput, {
				id: unauthorizedAnswerCallId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	await assert.rejects(
		harness.view.message(unauthorizedAnswerCallId, unauthorizedAnswerInput),
		/wrong_participant/,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("only the responder's first Answer becomes canonical and resolves its exact obligation", async () => {
	const harness = await createDormantChildHarness({
		afterDeliveryAdmission: ({ operation }) =>
			operation === "answer" ? "confirmation_lost" : undefined,
	});
	const requestInput = {
		operation: "request" as const,
		targetAgentId: harness.childId,
		question: "Report the first canonical Answer only.",
	};
	const requestToolCallId = "request-one-answer";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const firstAnswerCallId = "answer-first";
	const secondAnswerCallId = "answer-second";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"agent_message",
					{
						operation: "answer",
						requestId,
						answer: "The first committed Answer is authoritative.",
					},
					{ id: firstAnswerCallId },
				),
				fauxToolCall(
					"agent_message",
					{
						operation: "answer",
						requestId,
						answer: "A racing Answer must not become another Message.",
					},
					{ id: secondAnswerCallId },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The requester received the canonical Answer."),
		fauxAssistantMessage("The responder observed the first-Answer result."),
	]);

	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === secondAnswerCallId,
	);
	const answerSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === firstAnswerCallId,
			),
	);
	assert.ok(answerSourceEntry);
	const answerId = deriveMessageId({
		agentId: harness.childId,
		entryId: answerSourceEntry.id,
		toolCallId: firstAnswerCallId,
	});
	const firstResult = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === firstAnswerCallId,
	);
	const secondResult = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === secondAnswerCallId,
	);
	if (
		!firstResult ||
		firstResult.type !== "message" ||
		firstResult.message.role !== "toolResult"
	) {
		throw new Error("First Answer result did not commit");
	}
	if (
		!secondResult ||
		secondResult.type !== "message" ||
		secondResult.message.role !== "toolResult"
	) {
		throw new Error("Second Answer result did not commit");
	}
	assert.deepEqual(firstResult.message.details, {
		messageId: answerId,
		requestId,
		delivery: "indeterminate",
	});
	assert.deepEqual(secondResult.message.details, {
		disposition: "already_answered",
		messageId: answerId,
		requestId,
		answerId,
	});
	await waitForCondition(
		() => retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 0,
	);
	assert.equal(
		retentionCount(harness.view.status().run, "awaiting_answer"),
		1,
		"the unresolved Creation Request must keep the requester retained",
	);
	await waitForCondition(() =>
		harness.host.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({
						messages: [
							{
								agentId: harness.childId,
								entryId: answerSourceEntry.id,
								toolCallId: firstAnswerCallId,
							},
						],
					}),
		),
	);
	const lateCancelCallId = "cancel-after-answer-delivery";
	const lateCancelInput = {
		operation: "cancel" as const,
		requestId,
		reason: "This cancellation lost the requester-lane race.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", lateCancelInput, { id: lateCancelCallId }),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(
		await harness.view.message(lateCancelCallId, lateCancelInput),
		{
			disposition: "already_answered",
			messageId: answerId,
			answerId,
			requestId,
		},
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Request retry retrieves a committed Answer whose Delivery was lost", async () => {
	const harness = await createDormantChildHarness({
		beforeDeliveryAdmission: ({ operation }) =>
			operation === "answer" ? "confirmed_failure" : undefined,
	});
	const requestInput = {
		operation: "request" as const,
		targetAgentId: harness.childId,
		question: "Return the committed Answer through Request retry.",
	};
	const requestToolCallId = "request-lost-answer";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const answerToolCallId = "answer-with-lost-delivery";
	const answerText = "The responder committed this immutable Answer.";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "answer", requestId, answer: answerText },
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The Answer remains committed after scheduling failure."),
	]);
	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	const answerSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === answerToolCallId,
			),
	);
	assert.ok(answerSourceEntry);
	const answerSource = {
		agentId: harness.childId,
		entryId: answerSourceEntry.id,
		toolCallId: answerToolCallId,
	};
	const answerId = deriveMessageId(answerSource);
	const answerResult = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	if (
		!answerResult ||
		answerResult.type !== "message" ||
		answerResult.message.role !== "toolResult"
	) {
		throw new Error("Answer result did not commit");
	}
	assert.deepEqual(answerResult.message.details, {
		messageId: answerId,
		requestId,
		delivery: "rejected",
		rejectionReason: "target_unavailable",
	});

	const retryToolCallId = "retrieve-lost-answer";
	const retryInput = { operation: "retry" as const, messageId: requestId };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const retrieval = await harness.view.message(retryToolCallId, retryInput);
	assert.deepEqual(retrieval, {
		disposition: "answer_delivered",
		messageId: requestId,
		requestId,
		answerId,
		fromAgentId: harness.childId,
		answer: answerText,
		answerSource,
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: retryToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(retrieval) }],
		details: retrieval,
		isError: false,
		timestamp: Date.now(),
	});
	const retrievalEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(retrievalEntry);
	await harness.view.reachSafeBoundary();

	const repeatedRetryCallId = "observe-retrieved-answer";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: repeatedRetryCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const repeated = await harness.view.message(repeatedRetryCallId, retryInput);
	assert.deepEqual(repeated, {
		disposition: "answer_already_delivered",
		messageId: requestId,
		requestId,
		answerId,
		deliveryEvidence: {
			agentId: harness.host.session.sessionId,
			entryId: retrievalEntry.id,
		},
	});

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("requester Cancellation suppresses an undelivered Request without reviving it", async () => {
	const harness = await createDormantChildHarness({
		beforeDeliveryAdmission: ({ operation }) =>
			operation === "send" ? "confirmed_failure" : undefined,
		afterDeliveryAdmission: ({ operation }) =>
			operation === "cancel" ? "confirmation_lost" : undefined,
	});
	const requestInput = {
		operation: "request" as const,
		targetAgentId: harness.childId,
		question: "This Request will be abandoned before Delivery.",
	};
	const requestToolCallId = "request-before-cancellation";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	assert.deepEqual(requestReceipt, {
		messageId: requestId,
		requestId,
		delivery: "rejected",
		rejectionReason: "target_unavailable",
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});

	const cancelToolCallId = "cancel-undelivered-request";
	const cancelInput = {
		operation: "cancel" as const,
		requestId,
		reason: "The result is no longer needed.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellationEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(cancellationEntry);
	const cancellationSource = {
		agentId: harness.host.session.sessionId,
		entryId: cancellationEntry.id,
		toolCallId: cancelToolCallId,
	};
	const cancellationId = deriveMessageId(cancellationSource);
	harness.host.model.setResponses([
		fauxAssistantMessage("I received only the Request Cancellation."),
	]);
	const cancellation = await harness.view.message(cancelToolCallId, cancelInput);
	assert.deepEqual(cancellation, {
		messageId: cancellationId,
		cancellationId,
		requestId,
		delivery: "indeterminate",
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) ===
				JSON.stringify({ messages: [cancellationSource] }),
	);
	const cancellationDelivery = entries.find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) ===
				JSON.stringify({ messages: [cancellationSource] }),
	);
	assert.ok(cancellationDelivery && cancellationDelivery.type === "custom_message");
	assert.deepEqual(JSON.parse(cancellationDelivery.content as string), {
		messages: [
			{
				kind: "request_cancellation",
				cancellationId,
				requestId,
				fromAgentId: harness.host.session.sessionId,
				reason: cancelInput.reason,
			},
		],
	});
	assert.equal(
		entries.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({
						messages: [
							{
								agentId: harness.host.session.sessionId,
								entryId: requestEntry.id,
								toolCallId: requestToolCallId,
							},
						],
					}),
		),
		false,
	);

	const retryToolCallId = "retry-cancelled-request";
	const retryInput = { operation: "retry" as const, messageId: requestId };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(await harness.view.message(retryToolCallId, retryInput), {
		disposition: "rejected",
		messageId: requestId,
		rejectionReason: "policy_rejected",
	});

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Cancellation delivered to a busy responder suppresses its queued Request", async () => {
	const harness = await createDormantChildHarness();
	let markActiveGenerationStarted!: () => void;
	const activeGenerationStarted = new Promise<void>((resolve) => {
		markActiveGenerationStarted = resolve;
	});
	let releaseActiveGeneration!: () => void;
	const activeGenerationGate = new Promise<void>((resolve) => {
		releaseActiveGeneration = resolve;
	});
	harness.host.model.setResponses([
		async () => {
			markActiveGenerationStarted();
			await activeGenerationGate;
			return fauxAssistantMessage("The existing work reached its safe boundary.");
		},
		fauxAssistantMessage("The Cancellation arrived without the queued Request."),
	]);

	const workInput = {
		operation: "send" as const,
		targetAgentId: harness.childId,
		content: "Start active work before the Request is admitted.",
	};
	const workCallId = "start-work-before-cancellation";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", workInput, { id: workCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const workReceipt = await harness.view.message(workCallId, workInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: workCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(workReceipt) }],
		details: workReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await activeGenerationStarted;

	const requestInput = {
		operation: "request" as const,
		targetAgentId: harness.childId,
		question: "This queued Request must be suppressed.",
	};
	const requestCallId = "queue-request-before-cancellation";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestSource = {
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestCallId,
	};
	const requestId = deriveMessageId(requestSource);
	const requestReceipt = await harness.view.message(requestCallId, requestInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});

	const cancelInput = {
		operation: "cancel" as const,
		requestId,
		reason: "Suppress this queued work before Delivery.",
	};
	const cancelCallId = "cancel-queued-request";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellationEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(cancellationEntry);
	const cancellationSource = {
		agentId: harness.host.session.sessionId,
		entryId: cancellationEntry.id,
		toolCallId: cancelCallId,
	};
	const cancellation = await harness.view.message(cancelCallId, cancelInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});
	releaseActiveGeneration();

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) ===
				JSON.stringify({ messages: [cancellationSource] }),
	);
	await waitForCondition(
		() => harness.view.status(harness.childId).run.phase === "dormant",
	);
	assert.equal(
		entries.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({ messages: [requestSource] }),
		),
		false,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Cancellation Delivery wins the responder lane before a later Answer", async () => {
	const harness = await createDormantChildHarness();
	const requestInput = {
		operation: "request" as const,
		targetAgentId: harness.childId,
		question: "Wait until Cancellation arrives before attempting an Answer.",
	};
	const requestToolCallId = "request-before-delivered-cancellation";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I will wait with the Answer obligation unresolved."),
	]);
	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await waitForCondition(() =>
		retentionCount(harness.view.status(harness.childId).run, "answer_owed") === 1,
	);

	const cancelToolCallId = "deliver-cancellation-before-answer";
	const cancelInput = {
		operation: "cancel" as const,
		requestId,
		reason: "Stop before authoring the Answer.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellationEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(cancellationEntry);
	const cancellationId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: cancellationEntry.id,
		toolCallId: cancelToolCallId,
	});
	const losingAnswerCallId = "answer-after-delivered-cancellation";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "answer",
					requestId,
					answer: "This Answer must not become canonical.",
				},
				{ id: losingAnswerCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The delivered Cancellation won the responder lane."),
	]);
	const cancellation = await harness.view.message(cancelToolCallId, cancelInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === losingAnswerCallId,
	);
	const losingAnswer = entries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === losingAnswerCallId,
	);
	if (
		!losingAnswer ||
		losingAnswer.type !== "message" ||
		losingAnswer.message.role !== "toolResult"
	) {
		throw new Error("Losing Answer result did not commit");
	}
	assert.deepEqual(losingAnswer.message.details, {
		disposition: "already_cancelled",
		messageId: cancellationId,
		requestId,
		cancellationId,
	});
	await waitForCondition(
		() => harness.view.status(harness.childId).run.phase === "dormant",
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Answer commit and Cancellation commit remain canonical across crossed Deliveries", async () => {
	const harness = await createDormantChildHarness({
		beforeDeliveryAdmission: ({ operation }) =>
			operation === "answer" ? "confirmed_failure" : undefined,
	});
	const requestInput = {
		operation: "request" as const,
		targetAgentId: harness.childId,
		question: "Commit an Answer before its return Delivery is available.",
	};
	const requestToolCallId = "request-crossed-deliveries";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", requestInput, { id: requestToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const requestEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(requestEntry);
	const requestId = deriveMessageId({
		agentId: harness.host.session.sessionId,
		entryId: requestEntry.id,
		toolCallId: requestToolCallId,
	});
	const answerToolCallId = "answer-before-cancellation-delivery";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "answer",
					requestId,
					answer: "The Answer committed before Cancellation Delivery.",
				},
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The initial Answer Delivery was unavailable."),
	]);
	const requestReceipt = await harness.view.message(
		requestToolCallId,
		requestInput,
	);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: requestToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(requestReceipt) }],
		details: requestReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const answeredEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	const answerSourceEntry = answeredEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === answerToolCallId,
			),
	);
	assert.ok(answerSourceEntry);
	const answerSource = {
		agentId: harness.childId,
		entryId: answerSourceEntry.id,
		toolCallId: answerToolCallId,
	};
	const answerId = deriveMessageId(answerSource);

	const cancelToolCallId = "cancel-before-answer-delivery";
	const cancelInput = {
		operation: "cancel" as const,
		requestId,
		reason: "Abandon the wait while the committed Answer is undelivered.",
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", cancelInput, { id: cancelToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const cancellationEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(cancellationEntry);
	const cancellationSource = {
		agentId: harness.host.session.sessionId,
		entryId: cancellationEntry.id,
		toolCallId: cancelToolCallId,
	};
	const cancellationId = deriveMessageId(cancellationSource);
	const answerRetryCallId = "retry-answer-after-cancellation";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "retry", messageId: answerId },
				{ id: answerRetryCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The late Answer Delivery did not revive the wait."),
		fauxAssistantMessage("Both committed facts remain visible."),
	]);
	const cancellation = await harness.view.message(cancelToolCallId, cancelInput);
	assert.deepEqual(cancellation, {
		messageId: cancellationId,
		cancellationId,
		requestId,
		delivery: "pending",
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: cancelToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(cancellation) }],
		details: cancellation,
		isError: false,
		timestamp: Date.now(),
	});

	await waitForCondition(() =>
		harness.host.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({ messages: [answerSource] }),
		),
	);
	const crossedEntries = SessionManager.open(childSessionFile).getEntries();
	assert.equal(
		crossedEntries.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				JSON.stringify(entry.details) ===
					JSON.stringify({ messages: [cancellationSource] }),
		),
		true,
	);

	const retryRequestCallId = "retry-locally-cancelled-after-answer-delivery";
	const retryRequestInput = {
		operation: "retry" as const,
		messageId: requestId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryRequestInput, {
				id: retryRequestCallId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(
		await harness.view.message(retryRequestCallId, retryRequestInput),
		{
			disposition: "rejected",
			messageId: requestId,
			rejectionReason: "policy_rejected",
		},
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("a created-unscheduled Creation Request uses ordinary retry and Answer behavior", async () => {
	const harness = await createDormantChildHarness();
	const requestId = harness.creationRequestId;
	const answerToolCallId = "answer-creation-request";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "answer",
					requestId,
					answer: "The Creation Request completed through the ordinary protocol.",
				},
				{ id: answerToolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The Creation Request Answer reached its requester."),
		fauxAssistantMessage("The child finished its Answer turn."),
	]);

	const retryToolCallId = "retry-creation-request";
	const retryInput = { operation: "retry" as const, messageId: requestId };
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const retry = await harness.view.message(retryToolCallId, retryInput);
	assert.deepEqual(retry, {
		disposition: "request_pending",
		messageId: requestId,
		requestId,
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: retryToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(retry) }],
		details: retry,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === answerToolCallId,
	);
	await waitForCondition(
		() => retentionCount(harness.view.status().run, "awaiting_answer") === 0,
	);
	await waitForCondition(
		() => harness.view.status(harness.childId).run.phase === "dormant",
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Answer Delivery starts a successor Run for a dormant requester", async () => {
	const harness = await createDormantChildHarness();
	const childRequestCallId = "child-request-before-run-failure";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "request",
					targetAgentId: harness.host.session.sessionId,
					question: "Answer after this exact requester Run has failed.",
				},
				{ id: childRequestCallId },
			),
			{ stopReason: "toolUse" },
		),
		(context) => requesterFailureOrResponderReceipt(context.messages),
		(context) => requesterFailureOrResponderReceipt(context.messages),
	]);
	const wakeInput = {
		operation: "send" as const,
		targetAgentId: harness.childId,
		content: "Start the requester Run.",
	};
	const wakeCallId = "wake-dormant-requester";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", wakeInput, { id: wakeCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const wakeReceipt = await harness.view.message(wakeCallId, wakeInput);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: wakeCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(wakeReceipt) }],
		details: wakeReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === childRequestCallId,
	);
	const requestSourceEntry = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === childRequestCallId,
			),
	);
	assert.ok(requestSourceEntry);
	const requestId = deriveMessageId({
		agentId: harness.childId,
		entryId: requestSourceEntry.id,
		toolCallId: childRequestCallId,
	});
	await waitForCondition(
		() => harness.view.status(harness.childId).run.phase === "dormant",
	);
	await waitForCondition(
		() => retentionCount(harness.view.status().run, "answer_owed") === 1,
	);

	const answerInput = {
		operation: "answer" as const,
		requestId,
		answer: "This Answer starts the requester's successor Run.",
	};
	const answerCallId = "answer-dormant-requester";
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", answerInput, { id: answerCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const answerEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(answerEntry);
	const answerSource = {
		agentId: harness.host.session.sessionId,
		entryId: answerEntry.id,
		toolCallId: answerCallId,
	};
	harness.host.model.setResponses([
		fauxAssistantMessage("The successor requester Run received its Answer."),
	]);
	const answer = await harness.view.message(answerCallId, answerInput);
	assert.equal("delivery" in answer ? answer.delivery : undefined, "pending");
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: answerCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(answer) }],
		details: answer,
		isError: false,
		timestamp: Date.now(),
	});
	await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) ===
				JSON.stringify({ messages: [answerSource] }),
	);
	await waitForCondition(
		() => harness.view.status(harness.childId).run.phase === "dormant",
	);
	assert.equal(
		retentionCount(harness.view.status().run, "answer_owed"),
		0,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

async function createDormantChildHarness(
	messageBoundaryHooks: MessageBoundaryHooks = {},
) {
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		// This suite parks unanswered work to probe Request semantics. Suppress live
		// Moderator Runs so incidental stall handling does not consume scripted replies.
		incidentBoundaryHooks: {
			beforeModeratorRunStart: () => "confirmed_failure",
		},
		spawnBoundaryHooks: {
			beforeDeliveryAdmission: () => "confirmed_failure",
		},
		messageBoundaryHooks,
	});
	const view = coordinator.forAgent(identity.agentId);
	const spawnToolCallId = "spawn-request-responder";
	const spawnInput = {
		request: "Remain dormant until a correlated Request arrives.",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: spawnToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const spawn = await view.spawn(spawnToolCallId, spawnInput);
	assert.equal(spawn.disposition, "created_unscheduled");
	if (!("agentId" in spawn) || !("requestId" in spawn)) {
		throw new Error("Spawn receipt has no child or Creation Request identity");
	}
	return {
		host,
		coordinator,
		view,
		childId: spawn.agentId,
		creationRequestId: spawn.requestId,
	};
}

function deriveMessageId(source: {
	agentId: string;
	entryId: string;
	toolCallId: string;
}): string {
	return deriveMessageIdentity(source);
}

function retentionCount(
	run: AgentRunState,
	reason: "awaiting_answer" | "answer_owed",
): number {
	return run.retentionReasons.find((retention) => retention.reason === reason)?.count ?? 0;
}

async function waitForChildSessionFile(
	host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>>,
	childId: string,
): Promise<string> {
	const workflowDirectory = join(
		host.session.sessionManager.getSessionDir(),
		"pi-agent-coordination",
		Buffer.from(host.session.sessionId, "utf8").toString("base64url"),
	);
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const sessions = await SessionManager.list(host.cwd, workflowDirectory);
		const child = sessions.find(({ id }) => id === childId);
		if (child) return child.path;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Child Pi session file was not created");
}

async function waitForEntry(
	sessionFile: string,
	predicate: (entry: ReturnType<SessionManager["getEntries"]>[number]) => boolean,
) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const entries = SessionManager.open(sessionFile).getEntries();
		if (entries.some(predicate)) return entries;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected child transcript entry did not commit");
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected condition was not reached");
}

function requesterFailureOrResponderReceipt(messages: readonly unknown[]) {
	const delivery = findLatestModelDelivery(messages);
	return delivery.some(({ kind }) => kind === "request")
		? fauxAssistantMessage("The responder retained the delivered Request.")
		: fauxAssistantMessage("The requester Run fails after committing its Request.", {
			stopReason: "error",
			errorMessage: "deterministic requester failure",
		});
}

function findLatestModelDelivery(
	messages: readonly unknown[],
): Array<{ kind?: string }> {
	for (const message of [...messages as Array<{
		role?: string;
		content?: unknown;
	}>].reverse()) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		const text = message.content.find(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string",
		);
		if (!text) continue;
		try {
			const parsed = JSON.parse(text.text) as { messages?: unknown };
			if (Array.isArray(parsed.messages)) {
				return parsed.messages as Array<{ kind?: string }>;
			}
		} catch {
			continue;
		}
	}
	return [];
}
