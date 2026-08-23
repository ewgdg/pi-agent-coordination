import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	type Context,
} from "@earendil-works/pi-ai";

import piAgentCoordination from "../src/index.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

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
	host.session.subscribe((event) => {
		if (event.type === "agent_end") lifecycle.push("agent_end");
		if (event.type === "agent_settled") lifecycle.push("agent_settled");
		if (event.type === "compaction_start") compactionStarts += 1;
	});
	const requestMarker = "OWNER_PARK_CREATION_REQUEST";
	const request = `${requestMarker} ${"retained context ".repeat(30_000)}`;
	const answerCallId = "answer-owner-parked-request";
	const routeResponse = async (context: Context) => {
		const serialized = JSON.stringify(context.messages);
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
			if (!serialized.includes("The background result is ready.")) {
				return fauxAssistantMessage("No independent work remains in this turn.");
			}
			return fauxAssistantMessage("The Owner received the background result.");
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
		content: "Store this next-turn context without waking parking.",
		display: false,
	}, { triggerTurn: true, deliverAs: "nextTurn" });
	await host.session.sendCustomMessage({
		customType: "owner-parking-non-triggering-probe",
		content: "Store this non-triggering context without waking parking.",
		display: false,
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
	assert.equal(host.session.agent.hasQueuedMessages(), false);
	assert.deepEqual(lifecycle, ["agent_end"]);

	releaseAnswer();
	await withTimeout(prompt, 5_000, "Owner did not resume after Answer Delivery");
	await host.session.waitForIdle();
	assert.equal(host.session.isIdle, true);
	assert.equal(compactionStarts > 0, true);
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
