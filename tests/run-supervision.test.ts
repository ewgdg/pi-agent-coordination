import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import {
	WorkflowCoordinator,
	type AgentMessageInput,
} from "../src/coordination/workflow-coordinator.ts";
import { HumanRequestSurface } from "../src/presentation/human-request-surface.ts";
import piAgentCoordination from "../src/index.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	WorkflowPolicyStore,
	parseWorkflowPolicy,
} from "../src/policy/workflow-policy.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

const MAX_CONDITION_POLL_ATTEMPTS = 100;

test("interruption holds one exact settled Run and blocks ordinary Message Delivery", async () => {
	const harness = await createRunSupervisionHarness();
	const child = await harness.spawnChild("spawn-held-child");
	await child.session.waitForIdle();

	const interrupted = await harness.control("interrupt-held-child", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	assert.deepEqual(interrupted, {
		agentId: child.agentId,
		disposition: "held",
	});
	assert.deepEqual(
		harness.ownerView.status(child.agentId).run.retentionReasons,
		[
			{ reason: "answer_owed", count: 1 },
			{ reason: "interruption_hold", count: 1 },
		],
	);

	const message = await harness.sendMessage(
		"message-admitted-while-held",
		child.agentId,
		"This ordinary Message must remain pending behind the Hold.",
	);
	assert.ok("delivery" in message);
	assert.equal(message.delivery, "pending");
	await harness.ownerView.reachSafeBoundary();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				String(entry.content).includes("This ordinary Message must remain pending"),
		),
		false,
	);
	assert.equal(child.session.isIdle, true);

	await harness.shutdown();
});

test("interruption preserves Message admission that wins the target lane first", async () => {
	const harness = await createRunSupervisionHarness();
	const child = await harness.spawnChild("spawn-interruption-order-child");
	await child.session.waitForIdle();
	let markGenerationStarted!: () => void;
	const generationStarted = new Promise<void>((resolve) => {
		markGenerationStarted = resolve;
	});
	let releaseGeneration!: () => void;
	const generationGate = new Promise<void>((resolve) => {
		releaseGeneration = resolve;
	});
	harness.host.model.setResponses([
		async () => {
			markGenerationStarted();
			await generationGate;
			return fauxAssistantMessage("The interrupted work reached settlement.");
		},
	]);
	const activeRun = child.session.prompt("Remain active through the admission race.");
	await generationStarted;

	const messageText = "Admission wins the lane, but Delivery waits behind the Hold.";
	const admitted = await harness.sendMessage(
		"admit-before-interruption",
		child.agentId,
		messageText,
	);
	assert.ok("delivery" in admitted);
	assert.equal(admitted.delivery, "pending");
	const interruption = harness.control("interrupt-after-admission", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	releaseGeneration();
	await activeRun;
	assert.deepEqual(await interruption, {
		agentId: child.agentId,
		disposition: "held",
	});
	assert.equal(
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				String(entry.content).includes(messageText),
		),
		false,
	);

	await harness.shutdown();
});

test("a Hold blocks admitted Request, Answer, and Cancellation Delivery", async () => {
	const harness = await createRunSupervisionHarness();
	const child = await harness.spawnChild("spawn-held-request-child");
	await child.session.waitForIdle();
	const owner = { session: harness.host.session, view: harness.ownerView };

	harness.host.model.setResponses([
		fauxAssistantMessage("The Owner retained the child's unanswered Request."),
	]);
	const outgoing = await harness.requestFromChild(
		child,
		"child-request-before-hold",
		"Keep this outgoing Request unresolved for the held Answer.",
	);
	assert.ok("requestId" in outgoing);
	await harness.host.session.waitForIdle();

	harness.host.model.setResponses([
		fauxAssistantMessage("The child retained the Owner's unanswered Request."),
	]);
	const incoming = await harness.requestAs(
		owner,
		"owner-request-before-hold",
		child.agentId,
		"Keep this incoming Request unresolved for held Cancellation.",
	);
	assert.ok("requestId" in incoming);
	await child.session.waitForIdle();
	await harness.control("interrupt-request-child", {
		operation: "interrupt",
		agentId: child.agentId,
	});

	const heldRequestText = "This Request must wait behind the exact Hold.";
	const heldAnswerText = "This Answer must wait behind the exact Hold.";
	const heldCancellationText = "This Cancellation must wait behind the exact Hold.";
	const heldRequest = await harness.messageAs(owner, "request-admitted-while-held", {
		operation: "request",
		targetAgentId: child.agentId,
		question: heldRequestText,
	});
	const heldAnswer = await harness.messageAs(owner, "answer-admitted-while-held", {
		operation: "answer",
		requestId: outgoing.requestId,
		answer: heldAnswerText,
	});
	const heldCancellation = await harness.messageAs(
		owner,
		"cancellation-admitted-while-held",
		{
			operation: "cancel",
			requestId: incoming.requestId,
			reason: heldCancellationText,
		},
	);
	for (const receipt of [heldRequest, heldAnswer, heldCancellation]) {
		assert.ok("delivery" in receipt);
		assert.equal(receipt.delivery, "pending");
	}
	await harness.ownerView.reachSafeBoundary();
	await new Promise<void>((resolve) => setImmediate(resolve));
	const childEntries = child.session.sessionManager.getEntries();
	for (const blockedText of [heldRequestText, heldAnswerText, heldCancellationText]) {
		assert.equal(
			childEntries.some(
				(entry) =>
					entry.type === "custom_message" &&
					String(entry.content).includes(blockedText),
			),
			false,
		);
	}
	assert.equal(child.session.isIdle, true);
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		true,
	);

	await harness.shutdown();
});

test("one Supervisory Resume Message commits alone before ordinary held backlog", async () => {
	const harness = await createRunSupervisionHarness();
	const child = await harness.spawnChild("spawn-resumed-child");
	await child.session.waitForIdle();
	await harness.control("interrupt-resumed-child", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	await harness.sendMessage(
		"ordinary-backlog-after-resume",
		child.agentId,
		"Run this ordinary backlog only after the isolated resume turn.",
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("The isolated supervisory resume turn completed."),
		fauxAssistantMessage("The ordinary held backlog followed settlement."),
	]);
	const resumed = await harness.control("resume-held-child", {
		operation: "resume",
		agentId: child.agentId,
		content: "Resume this exact held Run with explicit direction.",
	});
	assert.equal(resumed.agentId, child.agentId);
	assert.ok("delivery" in resumed && "messageId" in resumed);
	assert.equal(resumed.delivery, "pending");
	assert.equal(typeof resumed.messageId, "string");
	await child.session.waitForIdle();
	await waitForCondition(() =>
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) =>
						part.type === "text" &&
						part.text === "The ordinary held backlog followed settlement.",
				),
		),
	);

	const deliveries = child.session.sessionManager.getEntries().flatMap(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery"
				? [entry]
				: [],
	);
	const resumedIndex = deliveries.findIndex((entry) =>
		String(entry.content).includes("Resume this exact held Run"),
	);
	const backlogIndex = deliveries.findIndex((entry) =>
		String(entry.content).includes("Run this ordinary backlog"),
	);
	assert.equal(resumedIndex >= 0, true);
	assert.equal(backlogIndex > resumedIndex, true);
	assert.deepEqual(
		JSON.parse(String(deliveries[resumedIndex]!.content)).messages,
		[{
			kind: "message",
			messageId: resumed.messageId,
			fromAgentId: harness.host.session.sessionId,
			content: "Resume this exact held Run with explicit direction.",
		}],
	);
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		false,
	);

	await harness.shutdown();
});

test("a failed Supervisory Resume dispatch leaves its exact Hold retryable", async () => {
	const harness = await createRunSupervisionHarness();
	const child = await harness.spawnChild("spawn-failed-supervisory-resume-child");
	await child.session.waitForIdle();
	await harness.control("interrupt-before-failed-supervisory-resume", {
		operation: "interrupt",
		agentId: child.agentId,
	});

	const nativeSendCustomMessage = child.session.sendCustomMessage;
	let rejectNextDispatch = true;
	child.session.sendCustomMessage = (message, options) => {
		if (rejectNextDispatch) {
			rejectNextDispatch = false;
			return Promise.reject(new Error("supervisory resume dispatch failed"));
		}
		return nativeSendCustomMessage.call(child.session, message, options);
	};
	await assert.rejects(
		() => harness.control("failed-supervisory-resume", {
			operation: "resume",
			agentId: child.agentId,
			content: "This dispatch fails before transcript commitment.",
		}),
		/supervisory resume dispatch failed/,
	);
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		true,
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("The retry resumed the still-held exact Run."),
	]);
	const retried = await harness.control("retry-supervisory-resume", {
		operation: "resume",
		agentId: child.agentId,
		content: "Retry the exact Hold after dispatch recovery.",
	});
	assert.ok("delivery" in retried);
	assert.equal(retried.delivery, "pending");
	await child.session.waitForIdle();
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		false,
	);

	child.session.sendCustomMessage = nativeSendCustomMessage;
	await harness.shutdown();
});

test("a native human editor Message clears its exact Hold for one isolated turn", async () => {
	const harness = await createRunSupervisionHarness();
	const child = await harness.spawnChild("spawn-human-resumed-child");
	await child.session.waitForIdle();
	await harness.control("interrupt-human-resumed-child", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	await harness.sendMessage(
		"ordinary-backlog-after-human-resume",
		child.agentId,
		"Deliver this only after the human-resumed turn settles.",
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("The isolated native human turn completed."),
		fauxAssistantMessage("The backlog followed the native human turn."),
	]);
	await child.session.prompt("Resume this exact Hold from the native editor.");
	await child.session.waitForIdle();
	await waitForCondition(() =>
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) =>
						part.type === "text" &&
						part.text === "The backlog followed the native human turn.",
				),
		),
	);

	const entries = child.session.sessionManager.getEntries();
	const humanIndex = entries.findIndex(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "user" &&
			Array.isArray(entry.message.content) &&
			entry.message.content.some(
				(part) =>
					part.type === "text" &&
					part.text === "Resume this exact Hold from the native editor.",
			),
	);
	const backlogIndex = entries.findIndex(
		(entry) =>
			entry.type === "custom_message" &&
			String(entry.content).includes("Deliver this only after the human-resumed turn"),
	);
	assert.equal(humanIndex >= 0, true);
	assert.equal(backlogIndex > humanIndex, true);
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		false,
	);

	await harness.shutdown();
});

test("a failed native human resume dispatch leaves its exact Hold retryable", async () => {
	const harness = await createRunSupervisionHarness();
	const child = await harness.spawnChild("spawn-failed-human-resume-child");
	await child.session.waitForIdle();
	await harness.control("interrupt-before-failed-human-resume", {
		operation: "interrupt",
		agentId: child.agentId,
	});

	const nativeSendUserMessage = child.session.sendUserMessage;
	let rejectNextDispatch = true;
	child.session.sendUserMessage = (content, options) => {
		if (rejectNextDispatch) {
			rejectNextDispatch = false;
			return Promise.reject(new Error("human resume dispatch failed"));
		}
		return nativeSendUserMessage.call(child.session, content, options);
	};
	await child.session.prompt("This human resume fails before commitment.");
	assert.equal(
		harness.host.ui.notifications.some(
			({ message, type }) =>
				type === "error" && message.includes("human resume dispatch failed"),
		),
		true,
	);
	assert.equal(
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes(
					"This human resume fails before commitment.",
				),
		),
		false,
	);
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		true,
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("The human retry resumed the still-held exact Run."),
	]);
	await child.session.prompt("Retry the native human resume against the exact Hold.");
	await child.session.waitForIdle();
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		false,
	);

	child.session.sendUserMessage = nativeSendUserMessage;
	await harness.shutdown();
});

test("supervisory interruption settles an active Human Request through its error result", async () => {
	const harness = await createRunSupervisionHarness();
	const child = await harness.spawnChild("spawn-human-request-child");
	await child.session.waitForIdle();
	const toolCallId = "human-request-before-supervisor-interrupt";
	harness.host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				{
					questions: [{
						kind: "text",
						header: "Interrupt",
						prompt: "The supervisor will interrupt this exact Run.",
						multiline: false,
					}],
				},
				{ id: toolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("This continuation must not run before explicit resumption."),
	]);
	const waitingRun = child.session.prompt("Open a Human Request for interruption.");
	await waitForCondition(() => {
		const run = harness.ownerView.status(child.agentId).run;
		return "attention" in run && run.attention === "input_required";
	});

	const interrupted = await harness.control("interrupt-active-human-request", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	await waitingRun;
	assert.deepEqual(interrupted, {
		agentId: child.agentId,
		disposition: "held",
	});
	const result = child.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(result && result.type === "message" && result.message.role === "toolResult");
	assert.equal(result.message.isError, true);
	assert.equal(
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) =>
						part.type === "text" &&
						part.text === "This continuation must not run before explicit resumption.",
				),
		),
		false,
	);
	const run = harness.ownerView.status(child.agentId).run;
	assert.equal("attention" in run && run.attention, "none");
	assert.equal(
		run.retentionReasons.some(({ reason }) => reason === "interruption_hold"),
		true,
	);

	await harness.shutdown();
});

test("termination discards exact-Run backlog, reports residual Requests, and permits a successor", async () => {
	const harness = await createRunSupervisionHarness();
	const child = await harness.spawnChild("spawn-terminated-child");
	await child.session.waitForIdle();

	harness.host.model.setResponses([
		fauxAssistantMessage("The Owner received the child's residual Request."),
	]);
	const outgoingRequest = await harness.requestFromChild(
		child,
		"child-request-before-termination",
		"This outgoing Request must remain residual after termination.",
	);
	assert.ok("requestId" in outgoingRequest);
	await harness.host.session.waitForIdle();
	await harness.control("interrupt-before-termination", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	await harness.sendMessage(
		"discard-this-held-backlog",
		child.agentId,
		"This uncommitted exact-Run backlog must be discarded.",
	);

	const terminated = await harness.control("terminate-held-child", {
		operation: "terminate",
		agentId: child.agentId,
	});
	assert.deepEqual(terminated, {
		agentId: child.agentId,
		disposition: "terminated",
		residualRequests: { incoming: 1, outgoing: 1 },
	});
	assert.deepEqual(harness.ownerView.status(child.agentId).run, {
		phase: "dormant",
		retentionReasons: [],
	});
	assert.equal(
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				String(entry.content).includes("This uncommitted exact-Run backlog"),
		),
		false,
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("A fresh successor Run received only later input."),
	]);
	await harness.sendMessage(
		"start-successor-after-termination",
		child.agentId,
		"Start a successor after exact Run termination.",
	);
	await waitForCondition(() =>
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) =>
						part.type === "text" &&
						part.text === "A fresh successor Run received only later input.",
				),
		),
	);

	await harness.shutdown();
});

test("authority follows only Owner descendants and immediate Direct-Spawner edges", async () => {
	const harness = await createRunSupervisionHarness();
	const parent = await harness.spawnChild("spawn-authority-parent");
	const sibling = await harness.spawnChild("spawn-authority-sibling");
	const grandchild = await harness.spawnChildFrom(
		parent,
		"spawn-authority-grandchild",
	);
	await Promise.all([
		parent.session.waitForIdle(),
		sibling.session.waitForIdle(),
		grandchild.session.waitForIdle(),
	]);

	assert.equal(
		harness.ownerView.status(grandchild.agentId).directSpawnerAgentId,
		parent.agentId,
	);
	assert.throws(
		() => parent.view.status(sibling.agentId),
		/unauthorized: Agent .* cannot observe/,
	);
	harness.host.model.setResponses([
		fauxAssistantMessage("The sibling received an ordinary Message without granting authority."),
	]);
	await harness.sendMessageAs(
		parent,
		"message-does-not-grant-authority",
		sibling.agentId,
		"Messaging this sibling must not grant Run control.",
	);
	await sibling.session.waitForIdle();
	await assert.rejects(
		() => harness.controlAs(parent, "unauthorized-sibling-interrupt", {
			operation: "interrupt",
			agentId: sibling.agentId,
		}),
		/unauthorized: Agent .* cannot control Agent Run/,
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("The grandchild retained the direct Spawner's Request obligation."),
	]);
	await harness.requestAs(
		parent,
		"direct-spawner-request-before-control",
		grandchild.agentId,
		"Remain live for the Direct Spawner's supervision check.",
	);
	await grandchild.session.waitForIdle();
	assert.equal(harness.ownerView.status(grandchild.agentId).run.phase, "live");
	const heldByDirectSpawner = await harness.controlAs(
		parent,
		"direct-spawner-interrupt",
		{ operation: "interrupt", agentId: grandchild.agentId },
	);
	assert.ok("disposition" in heldByDirectSpawner);
	assert.equal(heldByDirectSpawner.disposition, "held");
	const parentTermination = await harness.control("owner-terminates-parent-only", {
		operation: "terminate",
		agentId: parent.agentId,
	});
	assert.ok("disposition" in parentTermination);
	assert.equal(parentTermination.disposition, "terminated");
	assert.equal(harness.ownerView.status(parent.agentId).run.phase, "dormant");
	assert.equal(harness.ownerView.status(grandchild.agentId).run.phase, "live");
	assert.equal(
		harness.ownerView.status(grandchild.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		true,
	);

	await harness.shutdown();
});

test("the one resume reservation remains available when ordinary capacity is exhausted", async () => {
	const harness = await createRunSupervisionHarness({
		workflowPolicy: new WorkflowPolicyStore(
			parseWorkflowPolicy('{"maxPendingDeliveriesPerAgent": 1}'),
		),
	});
	const child = await harness.spawnChild("spawn-resume-capacity-child");
	await child.session.waitForIdle();
	await harness.control("interrupt-resume-capacity-child", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	const first = await harness.sendMessage(
		"fill-ordinary-held-capacity",
		child.agentId,
		"This Message occupies the only ordinary pending slot.",
	);
	assert.ok("delivery" in first);
	assert.equal(first.delivery, "pending");
	const exhausted = await harness.sendMessage(
		"exceed-ordinary-held-capacity",
		child.agentId,
		"This Message cannot enter ordinary pending capacity.",
	);
	assert.ok("delivery" in exhausted);
	assert.deepEqual(exhausted, {
		messageId: exhausted.messageId,
		delivery: "rejected",
		rejectionReason: "capacity_exhausted",
	});

	harness.host.model.setResponses([
		fauxAssistantMessage("The reserved resume ran despite ordinary exhaustion."),
		fauxAssistantMessage("The one admitted ordinary Message followed."),
	]);
	const resumed = await harness.control("resume-outside-ordinary-capacity", {
		operation: "resume",
		agentId: child.agentId,
		content: "Use the reserved resumption slot.",
	});
	assert.ok("delivery" in resumed);
	assert.equal(resumed.delivery, "pending");
	await child.session.waitForIdle();
	await waitForCondition(() =>
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) =>
						part.type === "text" &&
						part.text === "The one admitted ordinary Message followed.",
				),
		),
	);

	await harness.shutdown();
});

test("a resume bound to an earlier Hold becomes ordinary direction and cannot clear a later Hold", async () => {
	const harness = await createRunSupervisionHarness({ deferFirstResume: true });
	const child = await harness.spawnChild("spawn-stale-resume-child");
	await child.session.waitForIdle();
	await harness.control("interrupt-for-stale-resume", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	const stale = await harness.control("reserve-stale-resume", {
		operation: "resume",
		agentId: child.agentId,
		content: "This resume is bound only to the earlier Hold.",
	});
	assert.ok("delivery" in stale);
	assert.equal(stale.delivery, "pending");
	assert.equal(
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				String(entry.content).includes("bound only to the earlier Hold"),
		),
		false,
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("Human input cleared the earlier Hold first."),
	]);
	await child.session.prompt("Clear the earlier Hold with native human input.");
	await child.session.waitForIdle();
	await harness.control("interrupt-after-stale-resume", {
		operation: "interrupt",
		agentId: child.agentId,
	});
	await harness.releaseDeferredResume();
	assert.equal(
		harness.ownerView.status(child.agentId).run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		),
		true,
	);
	assert.equal(
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				String(entry.content).includes("bound only to the earlier Hold"),
		),
		false,
	);

	harness.host.model.setResponses([
		fauxAssistantMessage("The later exact Hold was resumed explicitly."),
		fauxAssistantMessage("The stale resume arrived afterward as ordinary direction."),
	]);
	const current = await harness.control("resume-later-exact-hold", {
		operation: "resume",
		agentId: child.agentId,
		content: "Resume the later exact Hold.",
	});
	assert.ok("delivery" in current);
	assert.equal(current.delivery, "pending");
	await child.session.waitForIdle();
	await waitForCondition(() =>
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) =>
						part.type === "text" &&
						part.text === "The stale resume arrived afterward as ordinary direction.",
				),
		),
	);
	const deliveries = child.session.sessionManager.getEntries().flatMap((entry) =>
		entry.type === "custom_message" &&
		entry.customType === "agent-coordination.message-delivery"
			? [String(entry.content)]
			: []
	);
	assert.equal(
		deliveries.findIndex((content) => content.includes("bound only to the earlier Hold")) >
			deliveries.findIndex((content) => content.includes("Resume the later exact Hold")),
		true,
	);

	await harness.shutdown();
});

test("the registered agent_control tool authenticates structural committed input", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("The tool-controlled child remains available."),
	]);
	const spawnInput = { request: "Remain available for registered Run control." };
	const spawnToolCallId = "spawn-tool-controlled-child";
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: spawnToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(spawn);
	const spawnResult = await spawn.execute(
		spawnToolCallId,
		spawnInput,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const childAgentId = (spawnResult.details as { agentId: string }).agentId;

	const toolCallId = "registered-agent-control-interrupt";
	const committedInput = { operation: "interrupt" as const, agentId: childAgentId };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", committedInput, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const control = host.session.getToolDefinition("agent_control");
	assert.ok(control);
	const result = await control.execute(
		toolCallId,
		{ agentId: childAgentId, operation: "interrupt" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(result.details, {
		agentId: childAgentId,
		disposition: "held",
	});
	const output = result.content[0];
	assert.ok(output?.type === "text");
	assert.deepEqual(JSON.parse(output.text), result.details);

	await host.runtime.dispose();
});

test("/agents selects live sessions, returns to Owner, and restores Owner for shutdown", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("The selectable child remains live."),
	]);
	const spawnInput = { request: "Remain live for native interactive selection." };
	const spawnToolCallId = "spawn-selectable-child";
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: spawnToolCallId }),
			{ stopReason: "toolUse" },
	),
	);
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(spawn);
	const spawnResult = await spawn.execute(
		spawnToolCallId,
		spawnInput,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const childAgentId = (spawnResult.details as { agentId: string }).agentId;

	host.ui.select = async (title, options) => {
		host.ui.agentViews.push({ title, options: [...options] });
		return options.find((option) => option.includes(childAgentId));
	};
	await host.session.prompt("/agents");
	assert.equal(host.runtime.session.sessionId, childAgentId);
	const observe = host.runtime.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const childStatus = await observe.execute(
		"observe-selected-child",
		{ operation: "status" },
		undefined,
		undefined,
		host.runtime.session.extensionRunner.createContext(),
	);
	assert.equal(
		(childStatus.details as {
			run: { retentionReasons: Array<{ reason: string }> };
		}).run.retentionReasons.some(({ reason }) => reason === "interactive_selection"),
		true,
	);

	host.ui.select = async (title, options) => {
		host.ui.agentViews.push({ title, options: [...options] });
		return options.find((option) => option.includes(host.session.sessionId));
	};
	await host.runtime.session.prompt("/agents");
	assert.equal(host.runtime.session.sessionId, host.session.sessionId);

	host.ui.select = async (title, options) => {
		host.ui.agentViews.push({ title, options: [...options] });
		return options.find((option) => option.includes(childAgentId));
	};
	await host.runtime.session.prompt("/agents");
	assert.equal(host.runtime.session.sessionId, childAgentId);
	await host.runtime.dispose();
	assert.equal(host.runtime.session.sessionId, host.session.sessionId);
});

async function createRunSupervisionHarness(options?: {
	workflowPolicy?: WorkflowPolicyStore;
	deferFirstResume?: boolean;
}) {
	let coordinator: WorkflowCoordinator;
	let deferredResumeRelease: (() => Promise<void>) | undefined;
	let didDeferResume = false;
	const childSessions = new Map<string, AgentSession>();
	const host = await createUnboundTestOwnerHost(() => undefined, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const ownerIdentity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	coordinator = new WorkflowCoordinator(host.runtime, ownerIdentity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		workflowPolicy: options?.workflowPolicy,
		messageBoundaryHooks: options?.deferFirstResume
			? {
				afterResumeReservation({ release }) {
					if (didDeferResume) return;
					didDeferResume = true;
					deferredResumeRelease = release;
					return "defer";
				},
			}
			: undefined,
		humanRequestPresentation: new HumanRequestSurface(host.ui),
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		spawnBoundaryHooks: {
			afterRunStart({ identity, session }) {
				childSessions.set(identity.agentId, session);
			},
		},
	});
	const ownerView = coordinator.forAgent(ownerIdentity.agentId);

	return {
		host,
		ownerView,
		async spawnChild(toolCallId: string) {
			host.model.setResponses([
				fauxAssistantMessage("The child is settled and ready for supervision."),
			]);
			host.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall(
						"agent_spawn",
						{ request: "Remain available for exact Run supervision." },
						{ id: toolCallId },
					),
					{ stopReason: "toolUse" },
				),
			);
			const receipt = await ownerView.spawn(toolCallId, {
				request: "Remain available for exact Run supervision.",
			});
			assert.ok("agentId" in receipt && typeof receipt.agentId === "string");
			const session = childSessions.get(receipt.agentId);
			if (!session) throw new Error("Spawned child session was not captured");
			return {
				agentId: receipt.agentId,
				session,
				view: coordinator.forAgent(receipt.agentId),
			};
		},
		async spawnChildFrom(
			parent: {
				agentId: string;
				session: AgentSession;
				view: ReturnType<WorkflowCoordinator["forAgent"]>;
			},
			toolCallId: string,
		) {
			host.model.setResponses([
				fauxAssistantMessage("The nested child is settled for supervision."),
			]);
			const input = { request: "Remain available as a nested supervised Agent." };
			parent.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall("agent_spawn", input, { id: toolCallId }),
					{ stopReason: "toolUse" },
				),
			);
			const receipt = await parent.view.spawn(toolCallId, input);
			assert.ok("agentId" in receipt && typeof receipt.agentId === "string");
			const session = childSessions.get(receipt.agentId);
			if (!session) throw new Error("Nested child session was not captured");
			return {
				agentId: receipt.agentId,
				session,
				view: coordinator.forAgent(receipt.agentId),
			};
		},
		async control(
			toolCallId: string,
			input:
				| { operation: "interrupt"; agentId: string }
				| { operation: "resume"; agentId: string; content: string }
				| { operation: "terminate"; agentId: string },
		) {
			host.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall("agent_control", input, { id: toolCallId }),
					{ stopReason: "toolUse" },
				),
			);
			return ownerView.control(toolCallId, input);
		},
		async sendMessage(toolCallId: string, targetAgentId: string, content: string) {
			const input = { operation: "send" as const, targetAgentId, content };
			host.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall("agent_message", input, { id: toolCallId }),
					{ stopReason: "toolUse" },
				),
			);
			return ownerView.message(toolCallId, input);
		},
		async sendMessageAs(
			caller: {
				session: AgentSession;
				view: ReturnType<WorkflowCoordinator["forAgent"]>;
			},
			toolCallId: string,
			targetAgentId: string,
			content: string,
		) {
			const input = { operation: "send" as const, targetAgentId, content };
			caller.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall("agent_message", input, { id: toolCallId }),
					{ stopReason: "toolUse" },
				),
			);
			return caller.view.message(toolCallId, input);
		},
		async messageAs(
			caller: {
				session: AgentSession;
				view: ReturnType<WorkflowCoordinator["forAgent"]>;
			},
			toolCallId: string,
			input: AgentMessageInput,
		) {
			caller.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall("agent_message", input, { id: toolCallId }),
					{ stopReason: "toolUse" },
				),
			);
			return caller.view.message(toolCallId, input);
		},
		async controlAs(
			caller: {
				session: AgentSession;
				view: ReturnType<WorkflowCoordinator["forAgent"]>;
			},
			toolCallId: string,
			input:
				| { operation: "interrupt"; agentId: string }
				| { operation: "resume"; agentId: string; content: string }
				| { operation: "terminate"; agentId: string },
		) {
			caller.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall("agent_control", input, { id: toolCallId }),
					{ stopReason: "toolUse" },
				),
			);
			return caller.view.control(toolCallId, input);
		},
		async requestFromChild(
			child: { agentId: string; session: AgentSession },
			toolCallId: string,
			question: string,
		) {
			const input = {
				operation: "request" as const,
				targetAgentId: ownerIdentity.agentId,
				question,
			};
			child.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall("agent_message", input, { id: toolCallId }),
					{ stopReason: "toolUse" },
				),
			);
			return coordinator.forAgent(child.agentId).message(toolCallId, input);
		},
		async requestAs(
			caller: {
				session: AgentSession;
				view: ReturnType<WorkflowCoordinator["forAgent"]>;
			},
			toolCallId: string,
			targetAgentId: string,
			question: string,
		) {
			const input = { operation: "request" as const, targetAgentId, question };
			caller.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall("agent_message", input, { id: toolCallId }),
					{ stopReason: "toolUse" },
				),
			);
			return caller.view.message(toolCallId, input);
		},
		async releaseDeferredResume() {
			if (!deferredResumeRelease) {
				throw new Error("No deferred resume reservation was captured");
			}
			await deferredResumeRelease();
		},
		shutdown: () => coordinator.shutdown(async () => host.runtime.dispose()),
	};
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected Run supervision condition was not reached");
}
