import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import type {
	AgentMessageReceipt,
	MessageBoundaryHooks,
} from "../src/coordination/workflow-coordinator.ts";
import piAgentCoordination from "../src/index.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

test("an authenticated Agent authors and polls one immutable Deferred Message through recipient proof", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Wait for direct coordination." },
				{ id: "spawn-message-recipient" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The recipient is ready."),
		fauxAssistantMessage("I am waiting for direct coordination."),
	]);
	await host.session.prompt("Create a recipient Agent.");
	await host.session.waitForIdle();

	const childId = findSpawnedAgentId(host.session.sessionManager);
	const sourceInput = {
		operation: "send" as const,
		targetAgentId: childId,
		content: "Inspect the first-proof-wins boundary.",
	};
	const toolCallId = "send-deferred-message";
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", sourceInput, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const sourceEntry = host.session.sessionManager.getLeafEntry();
	assert.ok(sourceEntry);
	const source = {
		agentId: host.session.sessionId,
		entryId: sourceEntry.id,
		toolCallId,
	};
	const expectedMessageId = createHash("sha256")
		.update(
			[
				"agent-coordination",
				"message",
				source.agentId,
				source.entryId,
				source.toolCallId,
			].join("\0"),
			"utf8",
		)
		.digest("base64url");

	host.model.setResponses([
		fauxAssistantMessage("I received the direct Deferred Message."),
	]);
	const agentMessage = host.session.getToolDefinition("agent_message");
	assert.ok(agentMessage);
	const result = await agentMessage.execute(
		toolCallId,
		sourceInput,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(result.details, {
		messageId: expectedMessageId,
		delivery: "pending",
	});
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(host, childId);
	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			(entry.details as { messages?: unknown } | undefined)?.messages !== undefined,
	);
	const deliveries = entries.filter(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [source] }),
	);
	assert.equal(deliveries.length, 1);
	const delivery = deliveries[0];
	assert.ok(delivery && delivery.type === "custom_message");
	assert.deepEqual(JSON.parse(delivery.content as string), {
		messages: [
			{
				kind: "message",
				messageId: expectedMessageId,
				fromAgentId: host.session.sessionId,
				content: sourceInput.content,
			},
		],
	});

	const pollToolCallId = "poll-delivered-message";
	const pollInput = { operation: "poll" as const, messageId: expectedMessageId };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", pollInput, { id: pollToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const pollResult = await agentMessage.execute(
		pollToolCallId,
		{ messageId: expectedMessageId, operation: "poll" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(pollResult.details, {
		disposition: "delivered",
		messageId: expectedMessageId,
		deliveryEvidence: { agentId: childId, entryId: delivery.id },
	});
	const retryToolCallId = "retry-delivered-message";
	const retryInput = { operation: "retry" as const, messageId: expectedMessageId };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const retryResult = await agentMessage.execute(
		retryToolCallId,
		{ messageId: expectedMessageId, operation: "retry" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(retryResult.details, {
		disposition: "delivered",
		messageId: expectedMessageId,
		deliveryEvidence: { agentId: childId, entryId: delivery.id },
	});

	await host.runtime.dispose();
});

test("poll reports an all-branch watermark for canonical absence and indeterminate for an unresolved source", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Wait while Message evidence is inspected." },
				{ id: "spawn-poll-recipient" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The polling recipient exists."),
		fauxAssistantMessage("I am waiting while Message evidence is inspected."),
	]);
	await host.session.prompt("Create a polling recipient.");
	await host.session.waitForIdle();

	const childId = findSpawnedAgentId(host.session.sessionManager);
	const childSessionFile = await waitForChildSessionFile(host, childId);
	const agentMessage = host.session.getToolDefinition("agent_message");
	assert.ok(agentMessage);
	const absentInput = {
		operation: "send" as const,
		targetAgentId: childId,
		content: "This canonical Message is deliberately not scheduled.",
	};
	const absentToolCallId = "author-not-observed-message";
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", absentInput, { id: absentToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const absentSourceEntry = host.session.sessionManager.getLeafEntry();
	assert.ok(absentSourceEntry);
	const absentMessageId = createHash("sha256")
		.update(
			[
				"agent-coordination",
				"message",
				host.session.sessionId,
				absentSourceEntry.id,
				absentToolCallId,
			].join("\0"),
			"utf8",
		)
		.digest("base64url");
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: absentToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Message scheduling was rejected." }],
		details: {
			messageId: absentMessageId,
			delivery: "rejected",
			rejectionReason: "target_unavailable",
		},
		isError: false,
		timestamp: Date.now(),
	});

	const pollAbsentId = "poll-not-observed-message";
	const pollAbsentInput = { operation: "poll" as const, messageId: absentMessageId };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", pollAbsentInput, { id: pollAbsentId }),
			{ stopReason: "toolUse" },
		),
	);
	const notObserved = await agentMessage.execute(
		pollAbsentId,
		pollAbsentInput,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const recipientTail = SessionManager.open(childSessionFile).getEntries().at(-1);
	assert.ok(recipientTail);
	assert.deepEqual(notObserved.details, {
		disposition: "not_observed",
		messageId: absentMessageId,
		inspectedThrough: { agentId: childId, entryId: recipientTail.id },
	});

	const unresolvedToolCallId = "author-unresolved-message";
	const unresolvedInput = {
		operation: "send" as const,
		targetAgentId: childId,
		content: "This source has neither author result nor recipient Delivery.",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", unresolvedInput, { id: unresolvedToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const unresolvedSourceEntry = host.session.sessionManager.getLeafEntry();
	assert.ok(unresolvedSourceEntry);
	const unresolvedMessageId = createHash("sha256")
		.update(
			[
				"agent-coordination",
				"message",
				host.session.sessionId,
				unresolvedSourceEntry.id,
				unresolvedToolCallId,
			].join("\0"),
			"utf8",
		)
		.digest("base64url");
	const pollUnresolvedId = "poll-unresolved-message";
	const pollUnresolvedInput = {
		operation: "poll" as const,
		messageId: unresolvedMessageId,
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", pollUnresolvedInput, { id: pollUnresolvedId }),
			{ stopReason: "toolUse" },
		),
	);
	const indeterminate = await agentMessage.execute(
		pollUnresolvedId,
		pollUnresolvedInput,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(indeterminate.details, {
		disposition: "indeterminate",
		messageId: unresolvedMessageId,
		reason: "inspection_incomplete",
	});

	await host.runtime.dispose();
});

test("racing same-identity retries coalesce while the recipient is busy and commit one Delivery", async () => {
	let releaseRecipient!: () => void;
	const recipientGate = new Promise<void>((resolve) => {
		releaseRecipient = resolve;
	});
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	const routeRecipientResponse = async (context: { messages: Array<{ role: string }> }) => {
		if (context.messages.at(-1)?.role === "custom") {
			await recipientGate;
			return fauxAssistantMessage("The recipient processed one Deferred input.");
		}
		return fauxAssistantMessage("The busy recipient is running.");
	};
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Remain busy until the retry race is admitted." },
				{ id: "spawn-busy-recipient" },
			),
			{ stopReason: "toolUse" },
		),
		routeRecipientResponse,
		routeRecipientResponse,
		routeRecipientResponse,
		routeRecipientResponse,
	]);
	await host.session.prompt("Create a recipient and leave its first turn active.");
	await host.session.waitForIdle();

	const childId = findSpawnedAgentId(host.session.sessionManager);
	const childSessionFile = await waitForChildSessionFile(host, childId);
	const agentMessage = host.session.getToolDefinition("agent_message");
	assert.ok(agentMessage);
	const sendToolCallId = "send-before-racing-retries";
	const sendInput = {
		operation: "send" as const,
		targetAgentId: childId,
		content: "Deliver this identity exactly once after the active work settles.",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", sendInput, { id: sendToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const sourceEntry = host.session.sessionManager.getLeafEntry();
	assert.ok(sourceEntry);
	const source = {
		agentId: host.session.sessionId,
		entryId: sourceEntry.id,
		toolCallId: sendToolCallId,
	};
	const messageId = createHash("sha256")
		.update(
			[
				"agent-coordination",
				"message",
				source.agentId,
				source.entryId,
				source.toolCallId,
			].join("\0"),
			"utf8",
		)
		.digest("base64url");
	const sendResult = await agentMessage.execute(
		sendToolCallId,
		sendInput,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: sendToolCallId,
		toolName: "agent_message",
		content: sendResult.content,
		details: sendResult.details,
		isError: false,
		timestamp: Date.now(),
	});

	const retryInputs = ["retry-race-a", "retry-race-b"].map((toolCallId) => {
		const input = { operation: "retry" as const, messageId };
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_message", input, { id: toolCallId }),
				{ stopReason: "toolUse" },
			),
		);
		return { toolCallId, input };
	});
	const retryResults = await Promise.all(
		retryInputs.map(({ toolCallId, input }) =>
			agentMessage.execute(
				toolCallId,
				input,
				undefined,
				undefined,
				host.session.extensionRunner.createContext(),
			),
		),
	);
	assert.deepEqual(
		retryResults.map(({ details }) => details),
		[
			{ disposition: "pending", messageId },
			{ disposition: "pending", messageId },
		],
	);

	releaseRecipient();
	const entries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [source] }),
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const deliveries = entries.filter(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [source] }),
	);
	assert.equal(deliveries.length, 1);

	await host.runtime.dispose();
});

test("a Message to a dormant child starts a successor Run and releases it after Delivery settles", async () => {
	const host = await createUnboundTestOwnerHost(() => undefined, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		spawnBoundaryHooks: {
			beforeDeliveryAdmission: () => "confirmed_failure",
		},
	});
	const view = coordinator.forAgent(identity.agentId);
	const spawnToolCallId = "spawn-dormant-message-recipient";
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "This Creation Request remains unscheduled." },
				{ id: spawnToolCallId },
			),
			{ stopReason: "toolUse" },
		),
	);
	const spawn = await view.spawn(spawnToolCallId, {
		request: "This Creation Request remains unscheduled.",
	});
	assert.equal(spawn.disposition, "created_unscheduled");
	if (!("agentId" in spawn)) throw new Error("Spawn receipt has no child identity");
	assert.deepEqual(view.status(spawn.agentId).run, {
		phase: "dormant",
		retentionReasons: [],
	});

	host.model.setResponses([
		fauxAssistantMessage("The successor Run received its Deferred Message."),
	]);
	const sendToolCallId = "message-starts-successor";
	const input = {
		operation: "send" as const,
		targetAgentId: spawn.agentId,
		content: "Start a successor and inspect this Message.",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: sendToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const sourceEntry = host.session.sessionManager.getLeafEntry();
	assert.ok(sourceEntry);
	const source = {
		agentId: identity.agentId,
		entryId: sourceEntry.id,
		toolCallId: sendToolCallId,
	};
	const receipt = await view.message(sendToolCallId, input);
	assert.equal("delivery" in receipt && receipt.delivery, "pending");
	if (!("messageId" in receipt)) throw new Error("Message receipt has no identity");
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: sendToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});

	const childSessionFile = await waitForChildSessionFile(host, spawn.agentId);
	await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			JSON.stringify(entry.details) === JSON.stringify({ messages: [source] }),
	);
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (view.status(spawn.agentId).run.phase === "dormant") break;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.equal(view.status(spawn.agentId).run.phase, "dormant");

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("the recipient lane resolves delivery-first, close-first, and stale close candidates against exact Runs", async () => {
	const releaseCandidates: Array<{
		context: { agentId: string; runSequence: number };
		evaluate: () => void;
	}> = [];
	const messageBoundaryHooks: MessageBoundaryHooks = {
		scheduleReleaseEvaluation: (context, evaluate) => {
			releaseCandidates.push({ context, evaluate });
		},
	};
	const harness = await createDormantChildHarness(messageBoundaryHooks);

	harness.host.model.setResponses([
		fauxAssistantMessage("The first successor turn settled."),
	]);
	const first = await authorMessage(
		harness,
		"delivery-first-setup",
		"Establish a settled live Run before the ordering race.",
	);
	await waitForDelivery(harness, first.source);
	await waitForCondition(() => releaseCandidates.length === 1);
	const originalCandidate = releaseCandidates[0];
	assert.ok(originalCandidate);
	assert.equal(harness.view.status(harness.childId).run.phase, "live");

	let releaseDeliveryFirst!: () => void;
	const deliveryFirstGate = new Promise<void>((resolve) => {
		releaseDeliveryFirst = resolve;
	});
	harness.host.model.setResponses([
		async () => {
			await deliveryFirstGate;
			return fauxAssistantMessage("Delivery won before the old close candidate.");
		},
	]);
	const deliveryFirst = await authorMessage(
		harness,
		"delivery-wins-current-run",
		"Retain and use the exact current Run.",
	);
	originalCandidate.evaluate();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(harness.view.status(harness.childId).run.phase, "live");
	releaseDeliveryFirst();
	await waitForDelivery(harness, deliveryFirst.source);
	await waitForCondition(() => releaseCandidates.length === 2);
	const currentRunCandidate = releaseCandidates[1];
	assert.ok(currentRunCandidate);
	assert.equal(
		currentRunCandidate.context.runSequence,
		originalCandidate.context.runSequence,
	);

	currentRunCandidate.evaluate();
	await waitForCondition(() => harness.view.status(harness.childId).run.phase === "dormant");
	let releaseSuccessor!: () => void;
	const successorGate = new Promise<void>((resolve) => {
		releaseSuccessor = resolve;
	});
	harness.host.model.setResponses([
		async () => {
			await successorGate;
			return fauxAssistantMessage("The successor ignored the stale close candidate.");
		},
	]);
	const closeFirst = await authorMessage(
		harness,
		"close-wins-successor-start",
		"Start a successor after the prior Run closes.",
	);
	assert.equal(harness.view.status(harness.childId).run.phase, "live");
	currentRunCandidate.evaluate();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(harness.view.status(harness.childId).run.phase, "live");
	releaseSuccessor();
	await waitForDelivery(harness, closeFirst.source);
	await waitForCondition(() => releaseCandidates.length === 3);
	assert.notEqual(
		releaseCandidates[2]?.context.runSequence,
		currentRunCandidate.context.runSequence,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("recipient Delivery ratifies a missing author result while an error result plus Delivery violates the crash table", async () => {
	const harness = await createDormantChildHarness({});
	harness.host.model.setResponses([
		fauxAssistantMessage("Delivery committed before author-result confirmation."),
	]);
	const ratified = await authorMessage(
		harness,
		"delivery-ratifies-author",
		"Let recipient proof ratify this Message.",
		{ appendResult: false },
	);
	await waitForDelivery(harness, ratified.source);
	const ratifiedMessageId = ratified.receipt.messageId;
	const ratifiedPollId = "poll-delivery-ratified-message";
	const ratifiedPollInput = {
		operation: "poll" as const,
		messageId: ratifiedMessageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", ratifiedPollInput, { id: ratifiedPollId }),
			{ stopReason: "toolUse" },
		),
	);
	const ratifiedPoll = await harness.view.message(ratifiedPollId, ratifiedPollInput);
	assert.equal("disposition" in ratifiedPoll && ratifiedPoll.disposition, "delivered");

	harness.host.model.setResponses([
		fauxAssistantMessage("The contradictory Message still reached the transcript."),
	]);
	const contradictory = await authorMessage(
		harness,
		"error-result-with-delivery",
		"This Delivery will contradict its author error result.",
		{ appendResult: false },
	);
	await waitForDelivery(harness, contradictory.source);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: contradictory.source.toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Scheduling failed." }],
		isError: true,
		timestamp: Date.now(),
	});
	const contradictionPollId = "poll-contradictory-message";
	const contradictionPollInput = {
		operation: "poll" as const,
		messageId: contradictory.receipt.messageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", contradictionPollInput, {
				id: contradictionPollId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	await assert.rejects(
		() => harness.view.message(contradictionPollId, contradictionPollInput),
		/error result and Delivery/,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("poll rejects malformed normal author-result evidence", async () => {
	const harness = await createDormantChildHarness({});
	harness.host.model.setResponses([
		fauxAssistantMessage("The Message reached the recipient transcript."),
	]);
	const sent = await authorMessage(
		harness,
		"malformed-normal-author-result",
		"Require exact normal author-result evidence.",
		{ appendResult: false },
	);
	await waitForDelivery(harness, sent.source);
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: sent.source.toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: "Malformed success." }],
		details: {
			messageId: sent.receipt.messageId,
			delivery: "pending",
			unexpected: true,
		},
		isError: false,
		timestamp: Date.now(),
	});
	const pollToolCallId = "poll-malformed-normal-author-result";
	const pollInput = {
		operation: "poll" as const,
		messageId: sent.receipt.messageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", pollInput, { id: pollToolCallId }),
			{ stopReason: "toolUse" },
		),
	);

	await assert.rejects(
		() => harness.view.message(pollToolCallId, pollInput),
		/author result has an invalid shape/,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("poll rejects malformed committed Agent Message source evidence", async () => {
	const harness = await createDormantChildHarness({});
	harness.host.model.setResponses([
		fauxAssistantMessage("The valid Message reached the recipient transcript."),
	]);
	const sent = await authorMessage(
		harness,
		"valid-message-before-malformed-source",
		"Reject malformed committed coordination sources during later inspection.",
	);
	await waitForDelivery(harness, sent.source);
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "send",
					targetAgentId: harness.childId,
					content: "",
				},
				{ id: "malformed-committed-agent-message-source" },
			),
			{ stopReason: "toolUse" },
		),
	);
	const pollToolCallId = "poll-after-malformed-agent-message-source";
	const pollInput = {
		operation: "poll" as const,
		messageId: sent.receipt.messageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", pollInput, { id: pollToolCallId }),
			{ stopReason: "toolUse" },
		),
	);

	await assert.rejects(
		() => harness.view.message(pollToolCallId, pollInput),
		/committed agent_message source .* is invalid/,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("poll rejects malformed Message Delivery evidence for another source", async () => {
	let injectedMalformedDelivery = false;
	const harness = await createDormantChildHarness({
		beforeRecipientInspection: ({ sessionManager }) => {
			if (injectedMalformedDelivery) return;
			injectedMalformedDelivery = true;
			sessionManager.appendCustomMessageEntry(
				"agent-coordination.message-delivery",
				JSON.stringify({
					messages: [
						{
							kind: "message",
							messageId: "another-message",
							fromAgentId: "another-agent",
							content: "Malformed because this field is not canonical.",
							unexpected: true,
						},
					],
				}),
				true,
				{
					messages: [
						{
							agentId: "another-agent",
							entryId: "another-entry",
							toolCallId: "another-call",
						},
					],
				},
			);
		},
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("The valid Message committed first."),
	]);
	const sent = await authorMessage(
		harness,
		"message-before-malformed-sibling-delivery",
		"Do not let malformed sibling evidence disappear during proof lookup.",
	);
	await waitForDelivery(harness, sent.source);
	const pollToolCallId = "poll-through-malformed-sibling-delivery";
	const pollInput = {
		operation: "poll" as const,
		messageId: sent.receipt.messageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", pollInput, { id: pollToolCallId }),
			{ stopReason: "toolUse" },
		),
	);

	await assert.rejects(
		() => harness.view.message(pollToolCallId, pollInput),
		/Message Delivery projection has an invalid shape/,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("poll rejects unknown current-scope coordination evidence", async () => {
	let injectedUnknownEvidence = false;
	const harness = await createDormantChildHarness({
		beforeRecipientInspection: ({ sessionManager }) => {
			if (injectedUnknownEvidence) return;
			injectedUnknownEvidence = true;
			sessionManager.appendCustomEntry("agent-coordination.unknown", {});
		},
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("The valid Message committed before unknown evidence."),
	]);
	const sent = await authorMessage(
		harness,
		"message-before-unknown-coordination-evidence",
		"Do not inspect through unknown coordination evidence.",
	);
	await waitForDelivery(harness, sent.source);
	const pollToolCallId = "poll-through-unknown-coordination-evidence";
	const pollInput = {
		operation: "poll" as const,
		messageId: sent.receipt.messageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", pollInput, { id: pollToolCallId }),
			{ stopReason: "toolUse" },
		),
	);

	await assert.rejects(
		() => harness.view.message(pollToolCallId, pollInput),
		/unexpected current-scope coordination entry agent-coordination.unknown/,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("poll rejects a hidden custom message as Delivery evidence", async () => {
	let injectedHiddenDelivery = false;
	const harness = await createDormantChildHarness({
		beforeRecipientInspection: ({ sessionManager }) => {
			if (injectedHiddenDelivery) return;
			injectedHiddenDelivery = true;
			sessionManager.appendCustomMessageEntry(
				"agent-coordination.message-delivery",
				JSON.stringify({
					messages: [
						{
							kind: "message",
							messageId: "hidden-message",
							fromAgentId: "another-agent",
							content: "This hidden entry is not model-visible Delivery proof.",
						},
					],
				}),
				false,
				{
					messages: [
						{
							agentId: "another-agent",
							entryId: "another-entry",
							toolCallId: "hidden-delivery-call",
						},
					],
				},
			);
		},
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("The valid model-visible Message committed."),
	]);
	const sent = await authorMessage(
		harness,
		"message-before-hidden-delivery-evidence",
		"Reject hidden custom messages during Delivery inspection.",
	);
	await waitForDelivery(harness, sent.source);
	const pollToolCallId = "poll-through-hidden-delivery-evidence";
	const pollInput = {
		operation: "poll" as const,
		messageId: sent.receipt.messageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", pollInput, { id: pollToolCallId }),
			{ stopReason: "toolUse" },
		),
	);

	await assert.rejects(
		() => harness.view.message(pollToolCallId, pollInput),
		/Message Delivery must be model-visible/,
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("only the original sender can poll a Message", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Receive a Message but do not impersonate its sender." },
				{ id: "spawn-poll-authorization-child" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The authorization child exists."),
		fauxAssistantMessage("I will not impersonate another sender."),
	]);
	await host.session.prompt("Create a child for poll authorization.");
	await host.session.waitForIdle();
	const childId = findSpawnedAgentId(host.session.sessionManager);
	const childSessionFile = await waitForChildSessionFile(host, childId);
	const sendToolCallId = "send-poll-authorization-message";
	const sendInput = {
		operation: "send" as const,
		targetAgentId: childId,
		content: "Only my sender identity may poll this Message.",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", sendInput, { id: sendToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const sourceEntry = host.session.sessionManager.getLeafEntry();
	assert.ok(sourceEntry);
	const messageId = createHash("sha256")
		.update(
			[
				"agent-coordination",
				"message",
				host.session.sessionId,
				sourceEntry.id,
				sendToolCallId,
			].join("\0"),
			"utf8",
		)
		.digest("base64url");
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{ operation: "poll", messageId },
				{ id: "child-polls-owner-message" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The poll was correctly rejected."),
	]);
	const agentMessage = host.session.getToolDefinition("agent_message");
	assert.ok(agentMessage);
	const sendResult = await agentMessage.execute(
		sendToolCallId,
		sendInput,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: sendToolCallId,
		toolName: "agent_message",
		content: sendResult.content,
		details: sendResult.details,
		isError: false,
		timestamp: Date.now(),
	});

	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === "child-polls-owner-message",
	);
	const unauthorized = childEntries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === "child-polls-owner-message",
	);
	assert.ok(
		unauthorized &&
			unauthorized.type === "message" &&
			unauthorized.message.role === "toolResult",
	);
	assert.equal(unauthorized.message.isError, true);
	assert.match(JSON.stringify(unauthorized.message.content), /wrong_participant/);

	await host.runtime.dispose();
});

test("Run failure discards uncommitted backlog and a successor receives only newly admitted work", async () => {
	const harness = await createDormantChildHarness({});
	let releaseFailure!: () => void;
	const failureGate = new Promise<void>((resolve) => {
		releaseFailure = resolve;
	});
	harness.host.model.setResponses([
		async () => {
			await failureGate;
			return fauxAssistantMessage("The Run failed after Delivery committed.", {
				stopReason: "error",
				errorMessage: "deterministic recipient failure",
			});
		},
		fauxAssistantMessage("Old backlog must never consume this response."),
	]);
	const deliveredBeforeFailure = await authorMessage(
		harness,
		"delivered-before-run-failure",
		"Commit this Delivery, then fail the exact Run.",
	);
	const discardedBacklog = await authorMessage(
		harness,
		"discarded-run-failure-backlog",
		"This volatile item must not transfer to a successor.",
	);
	releaseFailure();
	await waitForDelivery(harness, deliveredBeforeFailure.source);
	await waitForCondition(() => harness.view.status(harness.childId).run.phase === "dormant");
	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	let entries = SessionManager.open(childSessionFile).getEntries();
	assert.equal(hasDelivery(entries, discardedBacklog.source), false);

	harness.host.model.setResponses([
		fauxAssistantMessage("The successor received only newly admitted work."),
	]);
	const successorMessage = await authorMessage(
		harness,
		"new-work-after-run-failure",
		"Start a successor without recovering the discarded backlog.",
	);
	await waitForDelivery(harness, successorMessage.source);
	entries = SessionManager.open(childSessionFile).getEntries();
	assert.equal(hasDelivery(entries, discardedBacklog.source), false);
	assert.equal(hasDelivery(entries, successorMessage.source), true);
	assert.deepEqual(
		[deliveredBeforeFailure.receipt, discardedBacklog.receipt].map((receipt) =>
			"delivery" in receipt ? receipt.delivery : undefined),
		["pending", "pending"],
	);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Workflow shutdown discards admitted but uncommitted backlog", async () => {
	const harness = await createDormantChildHarness({});
	let releaseActiveRun!: () => void;
	const activeRunGate = new Promise<void>((resolve) => {
		releaseActiveRun = resolve;
	});
	let markActiveRunStarted!: () => void;
	const activeRunStarted = new Promise<void>((resolve) => {
		markActiveRunStarted = resolve;
	});
	harness.host.model.setResponses([
		async () => {
			markActiveRunStarted();
			await activeRunGate;
			return fauxAssistantMessage("The active Run ended during Workflow shutdown.");
		},
		fauxAssistantMessage("Discarded backlog must not consume this response."),
	]);
	const committedBeforeShutdown = await authorMessage(
		harness,
		"delivery-committed-before-workflow-shutdown",
		"Commit this Delivery before shutdown begins.",
	);
	await activeRunStarted;
	const discardedDuringShutdown = await authorMessage(
		harness,
		"delivery-discarded-by-workflow-shutdown",
		"Discard this admitted item before it commits.",
	);

	const shutdown = harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
	await new Promise<void>((resolve) => setImmediate(resolve));
	releaseActiveRun();
	await shutdown;

	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	const entries = SessionManager.open(childSessionFile).getEntries();
	assert.equal(hasDelivery(entries, committedBeforeShutdown.source), true);
	assert.equal(hasDelivery(entries, discardedDuringShutdown.source), false);
	assert.equal(
		"delivery" in discardedDuringShutdown.receipt &&
			discardedDuringShutdown.receipt.delivery,
		"pending",
	);
});

test("poll is indeterminate when authoritative recipient inspection cannot complete", async () => {
	const harness = await createDormantChildHarness({
		beforeRecipientInspection: () => "inspection_incomplete",
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("The Message committed despite later inspection loss."),
	]);
	const sent = await authorMessage(
		harness,
		"send-before-inspection-loss",
		"Commit this before the recipient transcript becomes unavailable.",
	);
	await waitForDelivery(harness, sent.source);
	const pollToolCallId = "poll-with-incomplete-inspection";
	const pollInput = {
		operation: "poll" as const,
		messageId: sent.receipt.messageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", pollInput, { id: pollToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const result = await harness.view.message(pollToolCallId, pollInput);
	assert.deepEqual(result, {
		disposition: "indeterminate",
		messageId: sent.receipt.messageId,
		reason: "inspection_incomplete",
	});

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("send reports indeterminate when admission confirmation is lost without cancelling Delivery", async () => {
	const harness = await createDormantChildHarness({
		afterDeliveryAdmission: ({ operation }) =>
			operation === "send" ? "confirmation_lost" : undefined,
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("The Message survived sender-side confirmation loss."),
	]);
	const sent = await authorMessage(
		harness,
		"send-with-lost-admission-confirmation",
		"Deliver even though admission confirmation is lost.",
		{ deliveryMode: "steer" },
	);

	assert.deepEqual(sent.receipt, {
		messageId: sent.receipt.messageId,
		delivery: "indeterminate",
	});
	await waitForDelivery(harness, sent.source);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("retry reports indeterminate when admission confirmation is lost without cancelling Delivery", async () => {
	const harness = await createDormantChildHarness({
		afterDeliveryAdmission: ({ operation }) =>
			operation === "retry" ? "confirmation_lost" : undefined,
	});
	let releaseActiveDelivery!: () => void;
	const activeDeliveryGate = new Promise<void>((resolve) => {
		releaseActiveDelivery = resolve;
	});
	let markActiveDeliveryStarted!: () => void;
	const activeDeliveryStarted = new Promise<void>((resolve) => {
		markActiveDeliveryStarted = resolve;
	});
	harness.host.model.setResponses([
		async () => {
			markActiveDeliveryStarted();
			await activeDeliveryGate;
			return fauxAssistantMessage("The first Message kept the recipient busy.");
		},
		fauxAssistantMessage("The retried Message survived confirmation loss."),
	]);
	await authorMessage(
		harness,
		"active-delivery-before-retry-confirmation-loss",
		"Keep the recipient busy while the next Message is retried.",
	);
	await activeDeliveryStarted;
	const retried = await authorMessage(
		harness,
		"send-before-retry-confirmation-loss",
		"Deliver after the active Message settles.",
		{ deliveryMode: "steer" },
	);
	const retryToolCallId = "retry-with-lost-admission-confirmation";
	const retryInput = {
		operation: "retry" as const,
		messageId: retried.receipt.messageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);

	const receipt = await harness.view.message(retryToolCallId, retryInput);
	assert.deepEqual(receipt, {
		disposition: "indeterminate",
		messageId: retried.receipt.messageId,
		reason: "confirmation_lost",
	});
	releaseActiveDelivery();
	await waitForDelivery(harness, retried.source);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("an authored Steer mode is accepted and retry remains mode-free", async () => {
	const harness = await createDormantChildHarness({});
	harness.host.model.setResponses([
		fauxAssistantMessage("The explicit Steer Message reached this dormant Agent."),
	]);
	const sent = await authorMessage(
		harness,
		"author-explicit-steer-message",
		"Redirect the next model turn at its safe boundary.",
		{ deliveryMode: "steer" },
	);
	assert.equal("delivery" in sent.receipt && sent.receipt.delivery, "pending");
	await waitForDelivery(harness, sent.source);

	const retryToolCallId = "retry-explicit-steer-message";
	const retryInput = {
		operation: "retry" as const,
		messageId: sent.receipt.messageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: retryToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const retry = await harness.view.message(retryToolCallId, retryInput);
	assert.equal("disposition" in retry && retry.disposition, "delivered");

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("recipient capacity counts distinct pending identities without evicting admitted work", async () => {
	const harness = await createDormantChildHarness({}, { pendingMessageLimit: 1 });
	let releaseActiveWork!: () => void;
	const activeWorkGate = new Promise<void>((resolve) => {
		releaseActiveWork = resolve;
	});
	let markActiveWorkStarted!: () => void;
	const activeWorkStarted = new Promise<void>((resolve) => {
		markActiveWorkStarted = resolve;
	});
	harness.host.model.setResponses([
		async () => {
			markActiveWorkStarted();
			await activeWorkGate;
			return fauxAssistantMessage("The recipient finished its existing work.");
		},
		fauxAssistantMessage("The admitted pending Message arrived first."),
		fauxAssistantMessage("The explicitly retried Message arrived later."),
	]);
	await authorMessage(
		harness,
		"start-active-work-before-capacity",
		"Start work so later Deferred Messages remain pending.",
	);
	await activeWorkStarted;

	const admitted = await authorMessage(
		harness,
		"admit-at-recipient-capacity",
		"Keep this admitted identity without eviction.",
		{ deliveryMode: "steer" },
	);
	const exhausted = await authorMessage(
		harness,
		"reject-over-recipient-capacity",
		"Preserve this canonical Message for explicit retry.",
	);
	assert.equal("delivery" in admitted.receipt && admitted.receipt.delivery, "pending");
	assert.deepEqual(exhausted.receipt, {
		messageId: exhausted.receipt.messageId,
		delivery: "rejected",
		rejectionReason: "capacity_exhausted",
	});

	const coalescedRetryId = "retry-admitted-identity-at-capacity";
	const coalescedRetryInput = {
		operation: "retry" as const,
		messageId: admitted.receipt.messageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", coalescedRetryInput, {
				id: coalescedRetryId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(
		await harness.view.message(coalescedRetryId, coalescedRetryInput),
		{ disposition: "pending", messageId: admitted.receipt.messageId },
	);

	releaseActiveWork();
	await waitForDelivery(harness, admitted.source);
	const exhaustedSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	assert.equal(
		hasDelivery(SessionManager.open(exhaustedSessionFile).getEntries(), exhausted.source),
		false,
	);

	const retryExhaustedId = "retry-after-recipient-capacity-frees";
	const retryExhaustedInput = {
		operation: "retry" as const,
		messageId: exhausted.receipt.messageId,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryExhaustedInput, {
				id: retryExhaustedId,
			}),
			{ stopReason: "toolUse" },
		),
	);
	assert.deepEqual(
		await harness.view.message(retryExhaustedId, retryExhaustedInput),
		{ disposition: "pending", messageId: exhausted.receipt.messageId },
	);
	await waitForDelivery(harness, exhausted.source);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Steer freezes an ordered batch after active generation and before the next model turn", async () => {
	const harness = await createDormantChildHarness({});
	let releaseGeneration!: () => void;
	const generationGate = new Promise<void>((resolve) => {
		releaseGeneration = resolve;
	});
	let markGenerationStarted!: () => void;
	const generationStarted = new Promise<void>((resolve) => {
		markGenerationStarted = resolve;
	});
	let markContinuationObserved!: () => void;
	const continuationObserved = new Promise<void>((resolve) => {
		markContinuationObserved = resolve;
	});
	let continuationError: unknown;
	harness.host.model.setResponses([
		async () => {
			markGenerationStarted();
			await generationGate;
			return fauxAssistantMessage("The original generation reached its safe boundary.");
		},
		(context) => {
			try {
				assert.deepEqual(findLatestModelDelivery(context.messages), [
						{
							kind: "message",
							messageId: first.receipt.messageId,
							fromAgentId: harness.host.session.sessionId,
							content: "Apply the first redirect.",
						},
						{
							kind: "message",
							messageId: second.receipt.messageId,
							fromAgentId: harness.host.session.sessionId,
							content: "Then apply the second redirect.",
						},
				]);
			} catch (error) {
				continuationError = error;
			} finally {
				markContinuationObserved();
			}
			return fauxAssistantMessage("Both Steer directions were visible together.");
		},
	]);
	await authorMessage(
		harness,
		"start-generation-before-steer",
		"Begin one active generation.",
	);
	await generationStarted;

	const first = await authorMessage(
		harness,
		"admit-first-steer",
		"Apply the first redirect.",
		{ deliveryMode: "steer" },
	);
	const second = await authorMessage(
		harness,
		"admit-second-steer",
		"Then apply the second redirect.",
		{ deliveryMode: "steer" },
	);
	releaseGeneration();

	await waitForDelivery(harness, first.source);
	await waitForDelivery(harness, second.source);
	await continuationObserved;
	if (continuationError) throw continuationError;
	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	const deliveries = SessionManager.open(childSessionFile)
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				(deliveryContainsSource(entry.details, first.source) ||
					deliveryContainsSource(entry.details, second.source)),
		);
	assert.equal(deliveries.length, 1);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("a Steer Message admitted after freeze waits for the following safe boundary", async () => {
	let admitAfterFreeze: (() => void) | undefined;
	const harness = await createDormantChildHarness({
		afterSteerFreeze: () => admitAfterFreeze?.(),
	});
	const lateToolCallId = "admit-steer-after-freeze";
	const lateInput = {
		operation: "send" as const,
		targetAgentId: harness.childId,
		content: "Wait for the following safe boundary.",
		deliveryMode: "steer" as const,
	};
	harness.host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", lateInput, { id: lateToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const lateSourceEntry = harness.host.session.sessionManager.getLeafEntry();
	assert.ok(lateSourceEntry);
	const lateSource = {
		agentId: harness.host.session.sessionId,
		entryId: lateSourceEntry.id,
		toolCallId: lateToolCallId,
	};
	let lateAdmission: Promise<AgentMessageReceipt> | undefined;
	admitAfterFreeze = () => {
		admitAfterFreeze = undefined;
		lateAdmission = harness.view.message(lateToolCallId, lateInput);
	};

	let releaseFirstGeneration!: () => void;
	const firstGenerationGate = new Promise<void>((resolve) => {
		releaseFirstGeneration = resolve;
	});
	let markFirstGenerationStarted!: () => void;
	const firstGenerationStarted = new Promise<void>((resolve) => {
		markFirstGenerationStarted = resolve;
	});
	let releaseSecondGeneration!: () => void;
	const secondGenerationGate = new Promise<void>((resolve) => {
		releaseSecondGeneration = resolve;
	});
	let markSecondGenerationStarted!: () => void;
	const secondGenerationStarted = new Promise<void>((resolve) => {
		markSecondGenerationStarted = resolve;
	});
	let secondGenerationError: unknown;
	harness.host.model.setResponses([
		async () => {
			markFirstGenerationStarted();
			await firstGenerationGate;
			return fauxAssistantMessage("The first generation reached its boundary.");
		},
		async (context) => {
			markSecondGenerationStarted();
			try {
				assert.deepEqual(findLatestModelDelivery(context.messages), [
					{
						kind: "message",
						messageId: first.receipt.messageId,
						fromAgentId: harness.host.session.sessionId,
						content: "Enter the first frozen batch.",
					},
				]);
			} catch (error) {
				secondGenerationError = error;
			}
			await secondGenerationGate;
			return fauxAssistantMessage("The first Steer batch completed.");
		},
		(context) => {
			assert.deepEqual(findLatestModelDelivery(context.messages), [
				{
					kind: "message",
					messageId: lateReceipt?.messageId,
					fromAgentId: harness.host.session.sessionId,
					content: "Wait for the following safe boundary.",
				},
			]);
			return fauxAssistantMessage("The post-freeze Steer arrived later.");
		},
	]);
	await authorMessage(
		harness,
		"start-generation-before-freeze-race",
		"Begin the generation that establishes the first freeze.",
	);
	await firstGenerationStarted;
	const first = await authorMessage(
		harness,
		"admit-steer-before-freeze",
		"Enter the first frozen batch.",
		{ deliveryMode: "steer" },
	);
	releaseFirstGeneration();
	await waitForCondition(() => lateAdmission !== undefined);
	const lateReceipt = await lateAdmission;
	assert.ok(lateReceipt);
	assert.deepEqual(lateReceipt, {
		messageId: lateReceipt.messageId,
		delivery: "pending",
	});
	harness.host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: lateToolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(lateReceipt) }],
		details: lateReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	await secondGenerationStarted;
	if (secondGenerationError) throw secondGenerationError;
	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	let entries = SessionManager.open(childSessionFile).getEntries();
	assert.equal(hasDelivery(entries, first.source), true);
	assert.equal(hasDelivery(entries, lateSource), false);

	releaseSecondGeneration();
	await waitForDelivery(harness, lateSource);
	entries = SessionManager.open(childSessionFile).getEntries();
	assert.equal(hasDelivery(entries, lateSource), true);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Steer waits for an already-issued parallel tool batch even when tools finish in reverse", async (t) => {
	let releaseSlowTool!: () => void;
	const slowToolGate = new Promise<void>((resolve) => {
		releaseSlowTool = resolve;
	});
	let releaseFastTool!: () => void;
	const fastToolGate = new Promise<void>((resolve) => {
		releaseFastTool = resolve;
	});
	let markSlowToolStarted!: () => void;
	const slowToolStarted = new Promise<void>((resolve) => {
		markSlowToolStarted = resolve;
	});
	let markFastToolStarted!: () => void;
	const fastToolStarted = new Promise<void>((resolve) => {
		markFastToolStarted = resolve;
	});
	const toolRegistryKey = Symbol.for("pi-agent-coordination.test.reverse-tools");
	const testGlobals = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
	testGlobals[toolRegistryKey] = {
		async slow() {
			markSlowToolStarted();
			await slowToolGate;
		},
		async fast() {
			markFastToolStarted();
			await fastToolGate;
		},
	};
	t.after(() => {
		delete testGlobals[toolRegistryKey];
	});
	const harness = await createDormantChildHarness({}, {
		additionalExtensionPaths: [
			fileURLToPath(new URL("./support/reverse-boundary-tools.ts", import.meta.url)),
		],
	});
	let markContinuationObserved!: () => void;
	const continuationObserved = new Promise<void>((resolve) => {
		markContinuationObserved = resolve;
	});
	let continuationError: unknown;
	harness.host.model.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("slow_boundary_tool", {}, { id: "slow-tool-call" }),
				fauxToolCall("fast_boundary_tool", {}, { id: "fast-tool-call" }),
			],
			{ stopReason: "toolUse" },
		),
		(context) => {
			const messages = context.messages as unknown as Array<{
				role: string;
				toolCallId?: string;
			}>;
			try {
				assert.deepEqual(
					messages
						.filter(({ role }) => role === "toolResult")
						.slice(-2)
						.map(({ toolCallId }) => toolCallId),
					["slow-tool-call", "fast-tool-call"],
				);
				assert.deepEqual(findLatestModelDelivery(context.messages), [
					{
						kind: "message",
						messageId: steer.receipt.messageId,
						fromAgentId: harness.host.session.sessionId,
						content: "Apply this only after both issued tools finish.",
					},
				]);
			} catch (error) {
				continuationError = error;
			} finally {
				markContinuationObserved();
			}
			return fauxAssistantMessage("Steer arrived only after both tool results.");
		},
	]);
	await authorMessage(
		harness,
		"start-parallel-tools-before-steer",
		"Run both boundary tools.",
	);
	await Promise.all([slowToolStarted, fastToolStarted]);
	const steer = await authorMessage(
		harness,
		"steer-during-reverse-tool-completion",
		"Apply this only after both issued tools finish.",
		{ deliveryMode: "steer" },
	);

	releaseFastTool();
	await new Promise<void>((resolve) => setImmediate(resolve));
	const childSessionFile = await waitForChildSessionFile(harness.host, harness.childId);
	assert.equal(
		hasDelivery(SessionManager.open(childSessionFile).getEntries(), steer.source),
		false,
	);
	releaseSlowTool();
	await waitForDelivery(harness, steer.source);
	await continuationObserved;
	if (continuationError) throw continuationError;

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Steer takes the next model turn before an earlier Deferred Message", async () => {
	const harness = await createDormantChildHarness({});
	let releaseActiveGeneration!: () => void;
	const activeGenerationGate = new Promise<void>((resolve) => {
		releaseActiveGeneration = resolve;
	});
	let markActiveGenerationStarted!: () => void;
	const activeGenerationStarted = new Promise<void>((resolve) => {
		markActiveGenerationStarted = resolve;
	});
	const observedDeliveryIds: string[] = [];
	let markBothContinuationsObserved!: () => void;
	const bothContinuationsObserved = new Promise<void>((resolve) => {
		markBothContinuationsObserved = resolve;
	});
	harness.host.model.setResponses([
		async () => {
			markActiveGenerationStarted();
			await activeGenerationGate;
			return fauxAssistantMessage("The active generation reached its boundary.");
		},
		(context) => {
			const delivery = findLatestModelDelivery(context.messages) as Array<{
				messageId: string;
			}>;
			observedDeliveryIds.push(...delivery.map(({ messageId }) => messageId));
			return fauxAssistantMessage("The Steer direction ran first.");
		},
		(context) => {
			const delivery = findLatestModelDelivery(context.messages) as Array<{
				messageId: string;
			}>;
			observedDeliveryIds.push(...delivery.map(({ messageId }) => messageId));
			markBothContinuationsObserved();
			return fauxAssistantMessage("The Deferred Message ran afterward.");
		},
	]);
	await authorMessage(
		harness,
		"start-generation-before-priority",
		"Begin active work before both delivery modes arrive.",
	);
	await activeGenerationStarted;
	const deferred = await authorMessage(
		harness,
		"admit-deferred-before-steer",
		"Wait until the Steer direction completes.",
	);
	const steer = await authorMessage(
		harness,
		"admit-steer-after-deferred",
		"Take the next safe model turn.",
		{ deliveryMode: "steer" },
	);
	releaseActiveGeneration();

	await waitForDelivery(harness, steer.source);
	await waitForDelivery(harness, deferred.source);
	await bothContinuationsObserved;
	assert.deepEqual(observedDeliveryIds, [
		steer.receipt.messageId,
		deferred.receipt.messageId,
	]);

	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

function findSpawnedAgentId(sessionManager: SessionManager): string {
	const result = sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "agent_spawn",
		);
	assert.ok(result && result.type === "message" && result.message.role === "toolResult");
	const agentId = (result.message.details as { agentId?: unknown }).agentId;
	if (typeof agentId !== "string") throw new Error("Spawn receipt has no Agent identity");
	return agentId;
}

async function waitForChildSessionFile(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
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

async function createDormantChildHarness(
	messageBoundaryHooks: MessageBoundaryHooks,
	options: {
		pendingMessageLimit?: number;
		additionalExtensionPaths?: string[];
	} = {},
) {
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionPaths: options.additionalExtensionPaths,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		spawnBoundaryHooks: {
			beforeDeliveryAdmission: () => "confirmed_failure",
		},
		messageBoundaryHooks,
		pendingMessageLimit: options.pendingMessageLimit,
	});
	const view = coordinator.forAgent(identity.agentId);
	const spawnToolCallId = "spawn-ordering-recipient";
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Remain dormant until an ordering probe arrives." },
				{ id: spawnToolCallId },
			),
			{ stopReason: "toolUse" },
		),
	);
	const spawn = await view.spawn(spawnToolCallId, {
		request: "Remain dormant until an ordering probe arrives.",
	});
	const childId = "agentId" in spawn ? spawn.agentId : undefined;
	if (typeof childId !== "string") throw new Error("Spawn receipt has no child identity");
	assert.equal(view.status(childId).run.phase, "dormant");
	return {
		host,
		coordinator,
		view,
		childId,
	};
}

async function authorMessage(
	harness: Awaited<ReturnType<typeof createDormantChildHarness>>,
	toolCallId: string,
	content: string,
	options: {
		appendResult?: boolean;
		deliveryMode?: "deferred" | "steer";
	} = {},
) {
	const input = {
		operation: "send" as const,
		targetAgentId: harness.childId,
		content,
		...(options.deliveryMode === undefined
			? {}
			: { deliveryMode: options.deliveryMode }),
	};
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
	const receipt = await harness.view.message(toolCallId, input);
	if (options.appendResult !== false) {
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
	return { source, receipt };
}

async function waitForDelivery(
	harness: Awaited<ReturnType<typeof createDormantChildHarness>>,
	source: { agentId: string; entryId: string; toolCallId: string },
): Promise<void> {
	const childSessionFile = await waitForChildSessionFile(
		harness.host,
		harness.childId,
	);
	await waitForEntry(
		childSessionFile,
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			deliveryContainsSource(entry.details, source),
	);
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected condition was not reached");
}

function hasDelivery(
	entries: ReturnType<SessionManager["getEntries"]>,
	source: { agentId: string; entryId: string; toolCallId: string },
): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery" &&
			deliveryContainsSource(entry.details, source),
	);
}

function deliveryContainsSource(
	details: unknown,
	source: { agentId: string; entryId: string; toolCallId: string },
): boolean {
	if (typeof details !== "object" || details === null || !("messages" in details)) {
		return false;
	}
	const messages = (details as { messages?: unknown }).messages;
	return Array.isArray(messages) &&
		messages.some((candidate) => JSON.stringify(candidate) === JSON.stringify(source));
}

function findLatestModelDelivery(messages: readonly unknown[]): unknown[] {
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
		let parsed: unknown;
		try {
			parsed = JSON.parse(text.text);
		} catch {
			continue;
		}
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"messages" in parsed &&
			Array.isArray(parsed.messages)
		) {
			return parsed.messages;
		}
	}
	assert.fail(`No model-visible Message Delivery in ${JSON.stringify(messages.slice(-6))}`);
}
