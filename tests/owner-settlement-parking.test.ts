import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	type Context,
} from "@earendil-works/pi-ai";

import piAgentCoordination from "../src/index.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

test("primary Owner input preempts Agent Wait before the next model turn", {
	timeout: 10_000,
}, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	let releaseAnswer!: () => void;
	const answerGate = new Promise<void>((resolve) => {
		releaseAnswer = resolve;
	});
	const requestMarker = "OWNER_HUMAN_PREEMPT_REQUEST";
	const queuedFollowUp = "Handle this only after the current wait has ended.";
	const userDirection = "Change direction before the background Answer arrives.";
	const answerText = "The preserved background Answer arrived.";
	const spawnCallId = "spawn-before-owner-human-preemption";
	const waitCallId = "wait-before-owner-human-preemption";
	const stuckWaitCallId = "wait-reissued-before-owner-input-delivery";
	const answerCallId = "answer-after-owner-human-preemption";
	let ownerRanBeforeHumanInput = false;
	let preemptedResultReachedDirectedTurn = false;
	const routeResponse = async (context: Context) => {
		const serialized = JSON.stringify(context.messages);
		const isResponder = serialized.includes(requestMarker) &&
			serialized.includes("requestMessageId") &&
			!serialized.includes(spawnCallId);
		if (isResponder) {
			if (serialized.includes(answerCallId)) {
				return fauxAssistantMessage("The preserved Answer was committed.");
			}
			await answerGate;
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{ operation: "answer", answer: answerText },
					{ id: answerCallId },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (serialized.includes(answerText)) {
			return fauxAssistantMessage("The Owner later received the preserved Answer.");
		}
		if (serialized.includes(queuedFollowUp)) {
			return fauxAssistantMessage("The Owner processed the explicitly queued follow-up.");
		}
		if (serialized.includes(userDirection)) {
			preemptedResultReachedDirectedTurn = serialized.includes(
				'"disposition":"preempted"',
			);
			return fauxAssistantMessage("The Owner acted on the new human direction.");
		}
		if (serialized.includes('"disposition":"preempted"')) {
			ownerRanBeforeHumanInput = true;
			return fauxAssistantMessage(
				fauxToolCall("agent_wait", {}, { id: stuckWaitCallId }),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(spawnCallId)) {
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_spawn",
					{ request: requestMarker },
					{ id: spawnCallId },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (!serialized.includes(waitCallId)) {
			return fauxAssistantMessage(
				fauxToolCall("agent_wait", {}, { id: waitCallId }),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("The Owner is still waiting for human input.");
	};
	host.model.setResponses(Array.from({ length: 10 }, () => routeResponse));

	const initialPrompt = host.session.prompt(requestMarker);
	await waitUntil(() => host.session.sessionManager.getEntries().some((entry) =>
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some((part) =>
			part.type === "toolCall" && part.id === waitCallId
		)
	));
	const followUpPrompt = host.session.prompt(queuedFollowUp, {
		streamingBehavior: "followUp",
	});
	await waitUntil(() => host.session.pendingMessageCount === 1);
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const waitingStatus = await observe.execute(
		"observe-wait-after-explicit-follow-up",
		{ operation: "status" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.equal(
		(waitingStatus.details as { run: { attention: string } }).run.attention,
		"agent_wait",
	);
	assert.equal(host.session.sessionManager.getEntries().some((entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === waitCallId
	), false);

	const directedPrompt = host.session.prompt(userDirection, {
		streamingBehavior: "steer",
	});
	await waitUntil(() => ownerAssistantTexts(host).includes(
		"The Owner processed the explicitly queued follow-up.",
	));
	const ownerTexts = ownerAssistantTexts(host);
	assert.equal(
		ownerTexts.indexOf("The Owner acted on the new human direction.") <
			ownerTexts.indexOf("The Owner processed the explicitly queued follow-up."),
		true,
	);

	assert.equal(ownerRanBeforeHumanInput, false);
	assert.equal(preemptedResultReachedDirectedTurn, true);
	assert.equal(host.session.sessionManager.getEntries().some((entry) =>
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some((part) =>
			part.type === "toolCall" && part.id === stuckWaitCallId
		)
	), false);
	const waitResult = host.session.sessionManager.getEntries().find((entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === waitCallId
	);
	assert.ok(waitResult?.type === "message" && waitResult.message.role === "toolResult");
	assert.deepEqual(waitResult.message.details, { disposition: "preempted" });
	const status = await observe.execute(
		"observe-request-preserved-after-human-preemption",
		{ operation: "status" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(
		(status.details as { run: { retentionReasons: Array<{ reason: string }> } })
			.run.retentionReasons.some(({ reason }) => reason === "awaiting_answer"),
		true,
	);

	releaseAnswer();
	await withTimeout(
		Promise.all([initialPrompt, followUpPrompt, directedPrompt]).then(() => undefined),
		5_000,
		"Owner did not settle after its preserved Answer arrived",
	);
});

test("Owner and Herdr remain working until the Creation Request Answer arrives, then settle once", {
	timeout: 10_000,
}, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
		settings: {
			compaction: {
				enabled: true,
				reserveTokens: 16_000,
				keepRecentTokens: 1,
			},
		},
	});
	let releaseAnswer!: () => void;
	const answerGate = new Promise<void>((resolve) => {
		releaseAnswer = resolve;
	});
	// Herdr keeps the root pane working from agent_start until this exact native
	// agent_settled event. No project settlement projection may appear while parked.
	const lifecycle: string[] = [];
	let compactionStarts = 0;
	let explicitNextTurnSeenDuringContinuation = false;
	host.session.subscribe((event) => {
		if (event.type === "agent_end") lifecycle.push("agent_end");
		if (event.type === "agent_settled") lifecycle.push("agent_settled");
		if (event.type === "compaction_start") compactionStarts += 1;
	});
	const requestMarker = "OWNER_PARK_CREATION_REQUEST";
	const request = `${requestMarker} ${"retained context ".repeat(30_000)}`;
	const answerCallId = "answer-owner-parked-request";
	const explicitNextTurnProbe = "Store this only for a later fresh prompt.";
	const routeResponse = async (context: Context) => {
		const serialized = JSON.stringify(context.messages);
		if (serialized.includes(explicitNextTurnProbe)) {
			explicitNextTurnSeenDuringContinuation = true;
		}
		if (
			serialized.includes(requestMarker) &&
			serialized.includes("requestMessageId") &&
			!serialized.includes("spawn-owner-parked-request")
		) {
			if (!serialized.includes(answerCallId)) {
				await answerGate;
				return fauxAssistantMessage(
					fauxToolCall(
						"agent_message",
						{ operation: "answer", answer: "The background result is ready." },
						{ id: answerCallId },
					),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("The Answer was committed.");
		}
		if (serialized.includes(requestMarker)) {
			if (!serialized.includes("spawn-owner-parked-request")) {
				return fauxAssistantMessage(
					fauxToolCall(
						"agent_spawn",
						{ request },
						{ id: "spawn-owner-parked-request" },
					),
					{ stopReason: "toolUse" },
				);
			}
			if (serialized.includes("The background result is ready.")) {
				return fauxAssistantMessage("The Owner received the background result.");
			}
			return fauxAssistantMessage("No independent work remains in this turn.");
		}
		return fauxAssistantMessage("No coordination action was needed.");
	};
	host.model.setResponses(Array.from({ length: 8 }, () => routeResponse));

	const prompt = host.session.prompt(request);
	await waitUntil(() => ownerAssistantTexts(host).includes(
		"No independent work remains in this turn.",
	));
	assert.equal(host.session.isIdle, false);
	assert.equal(compactionStarts, 0);
	assert.deepEqual(lifecycle, ["agent_end"]);

	await host.session.sendCustomMessage({
		customType: "owner-parking-next-turn-probe",
		content: explicitNextTurnProbe,
		display: false,
	}, { triggerTurn: true, deliverAs: "nextTurn" });
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(lifecycle, ["agent_end"]);

	releaseAnswer();
	await withTimeout(prompt, 5_000, "Owner did not resume after Answer Delivery");
	await host.session.waitForIdle();
	assert.equal(host.session.isIdle, true);
	assert.equal(compactionStarts > 0, true);
	assert.equal(explicitNextTurnSeenDuringContinuation, false);
	assert.equal(lifecycle.filter((event) => event === "agent_end").length >= 2, true);
	assert.equal(lifecycle.filter((event) => event === "agent_settled").length, 1);

	const entries = host.session.sessionManager.getEntries();
	assert.equal(
		entries.some((entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some((part) =>
				part.type === "toolCall" && part.name === "agent_wait"
			)
		),
		false,
	);
});

test("native custom input wakes a parked working Owner and remains in model context", {
	timeout: 10_000,
}, async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
	let releaseAnswer!: () => void;
	const answerGate = new Promise<void>((resolve) => {
		releaseAnswer = resolve;
	});
	const lifecycle: string[] = [];
	host.session.subscribe((event) => {
		if (event.type === "agent_end") lifecycle.push("agent_end");
		if (event.type === "agent_settled") lifecycle.push("agent_settled");
	});
	const requestMarker = "OWNER_NATIVE_CUSTOM_WAKE_REQUEST";
	const customProbe = "Process this custom input using native active-Agent semantics.";
	const routeResponse = async (context: Context) => {
		const serialized = JSON.stringify(context.messages);
		if (
			serialized.includes(requestMarker) &&
			serialized.includes("requestMessageId") &&
			!serialized.includes("spawn-native-custom-wake")
		) {
			if (!serialized.includes("answer-native-custom-wake")) {
				await answerGate;
				return fauxAssistantMessage(
					fauxToolCall(
						"agent_message",
						{ operation: "answer", answer: "Native custom wake test complete." },
						{ id: "answer-native-custom-wake" },
					),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("The child Answer was committed.");
		}
		if (!serialized.includes("spawn-native-custom-wake")) {
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_spawn",
					{ request: requestMarker },
					{ id: "spawn-native-custom-wake" },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (serialized.includes("Native custom wake test complete.")) {
			return fauxAssistantMessage("The Owner received the final Answer.");
		}
		if (serialized.includes(customProbe)) {
			return fauxAssistantMessage("The parked Owner processed native custom input.");
		}
		return fauxAssistantMessage("The Owner is parked with background work outstanding.");
	};
	host.model.setResponses(Array.from({ length: 8 }, () => routeResponse));

	const prompt = host.session.prompt(requestMarker);
	await waitUntil(() => ownerAssistantTexts(host).includes(
		"The Owner is parked with background work outstanding.",
	));
	assert.equal(host.session.isIdle, false);
	assert.deepEqual(lifecycle, ["agent_end"]);

	await host.session.sendCustomMessage({
		customType: "owner-parking-native-custom-wake",
		content: customProbe,
		display: false,
	});
	await waitUntil(() => ownerAssistantTexts(host).includes(
		"The parked Owner processed native custom input.",
	));
	assert.equal(host.session.isIdle, false);
	assert.equal(lifecycle.includes("agent_settled"), false);
	assert.equal(
		host.session.sessionManager.getEntries().some((entry) =>
			entry.type === "custom_message" && entry.content === customProbe
		),
		true,
	);

	releaseAnswer();
	await withTimeout(prompt, 5_000, "Owner did not settle after the final Answer");
	assert.equal(lifecycle.filter((event) => event === "agent_settled").length, 1);
});

function ownerAssistantTexts(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
): string[] {
	return host.session.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return [];
		return entry.message.content.flatMap((part) =>
			part.type === "text" ? [part.text] : []
		);
	});
}

async function withTimeout(
	operation: Promise<void>,
	milliseconds: number,
	message: string,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Expected Owner parking condition was not reached");
}
