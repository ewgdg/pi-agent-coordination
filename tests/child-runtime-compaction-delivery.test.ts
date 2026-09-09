import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createChildRuntimeBinding } from "../src/process-runtime/child-runtime-bridge.ts";
import { NativeInputSubmissionIdentity } from "../src/process-runtime/native-input-submission-identity.ts";
import { TerminalInputSubmissionAcknowledger } from "../src/process-runtime/terminal-input-submission-acknowledger.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import type { WorkingZonePreparation } from "../src/runtime/agent-runtime-host.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const preparation: WorkingZonePreparation = {
	intent: { workScale: "large", contextDependence: "low" },
	prospectiveRequest: {
		kind: "request",
		requestMessageId: "prepared-request",
		fromAgentId: "requester",
		question: "Continue the prepared Request.",
	},
};
const deliveryMessage = createMessageDelivery([{
	source: { agentId: "requester", entryId: "source-entry", toolCallId: "source-call" },
	projection: preparation.prospectiveRequest,
}]);
const replacementType = "test.compaction-replacement";

for (const path of [
	{ name: "optional working zone", tokens: 120_000, preparation },
	{ name: "mandatory working zone", tokens: 190_000, preparation },
	{ name: "native threshold", tokens: 190_000, preparation: undefined },
]) {
	test(`${path.name} commits queued Delivery without waiting for the replacement turn`, {
		timeout: 5_000,
	}, async (t) => {
		let context!: ExtensionContext;
		let manualSignal: AbortSignal | undefined;
		let manualAttempts = 0;
		let finishReplacement!: () => void;
		const replacementGate = new Promise<void>((resolve) => { finishReplacement = resolve; });
		t.after(finishReplacement);
		let requestSeen!: () => void;
		const requestInModel = new Promise<void>((resolve) => { requestSeen = resolve; });
		const host = await createTestOwnerHost(t, (pi) => {
			pi.on("session_start", (_event, ctx) => { context = ctx; });
			pi.on("session_before_compact", (event) => {
				if (event.reason === "manual") {
					manualAttempts += 1;
					manualSignal = event.signal;
				}
				return { cancel: true };
			});
			pi.on("session_compact_failed", (event) => {
				if (event.reason !== "manual" || !event.aborted || manualSignal?.aborted) return;
				// Extensions may replace compaction with an ordinary model turn.
				pi.sendMessage({
					customType: replacementType,
					content: "Save checkpoint notes and continue.",
					display: true,
				}, { triggerTurn: true, deliverAs: "steer" });
			});
		}, {
			settings: { compaction: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 24 } },
		});
		const session = host.session;
		for (let index = 0; index < 3; index += 1) {
			session.sessionManager.appendMessage({
				role: "user", content: "Prior context. ".repeat(200), timestamp: Date.now(),
			});
			session.sessionManager.appendMessage(fauxAssistantMessage("Prior response."));
		}
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
		session.getContextUsage = () => ({
			tokens: path.tokens, contextWindow: 200_000, percent: path.tokens / 2_000,
		});
		const respond: FauxResponseStep = async (modelContext) => {
			if (JSON.stringify(modelContext.messages).includes(preparation.prospectiveRequest.question)) {
				requestSeen();
				await replacementGate;
			}
			return fauxAssistantMessage("Checkpoint and Request processed.");
		};
		host.model.setResponses([respond, respond]);

		type ControlState = Parameters<typeof createChildRuntimeBinding>[0];
		const events: Array<{ event: string; payload: unknown }> = [];
		// Keep transport outside this focused binding test; Pi and bridge lifecycle are real.
		const channel = {
			async sendEvent(event: string, payload: unknown) { events.push({ event, payload }); },
		} as unknown as ControlState["channel"];
		const inputSubmissionAcknowledger = new TerminalInputSubmissionAcknowledger(() => {});
		const state: ControlState = {
			channel,
			waitProgressHandlers: new Map(),
			currentRunOutcome: "completed",
			nativeRunSequence: 0,
			queueIntentionTail: Promise.resolve(),
			shutdownStarted: false,
			inputSubmissionAcknowledger,
			nativeInputIdentity: new NativeInputSubmissionIdentity(),
		};
		const binding = createChildRuntimeBinding(
			state, host.runtime, context, () => {}, "recipient",
			inputSubmissionAcknowledger.bind(), () => {}, () => {},
		);
		state.currentBinding = binding;
		try {
			const receipt = await binding.handleOwnerRequest({
				method: "message.deliver",
				payload: {
					runId: "prepared-run",
					delivery: {
						kind: "custom",
						message: { ...deliveryMessage, details: { messages: [...deliveryMessage.details.messages] } },
						triggerTurn: true,
						...(path.preparation ? { workingZonePreparation: path.preparation } : {}),
					},
				},
				signal: new AbortController().signal,
			});
			assert.deepEqual(receipt, {
				accepted: true, transcriptCommitted: true, modelCycleStarted: true, queuedInputCount: 0,
			});
			await requestInModel;
			assert.equal(session.isIdle, false);
			assert.equal(manualAttempts, 1);
			assert.equal(manualSignal?.aborted, false);
			assert.deepEqual(host.ui.notifications, []);
			assert.deepEqual(events.filter(({ event }) => event === "runtime.fault"), []);
			const committed = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
			assert.deepEqual(committed.map((entry) => entry.customType), [
				replacementType, deliveryMessage.customType,
			]);
			assert.equal(committed[1]?.content, deliveryMessage.content);
			assert.equal(events.some(({ event }) => event === "agent.settled"), false);

			finishReplacement();
			await session.waitForIdle();
			assert.deepEqual(events.filter(({ event }) => event === "agent.settled"), [{
				event: "agent.settled",
				payload: { runId: "prepared-run", outcome: "completed", queuedInputCount: 0 },
			}]);
			assert.deepEqual(events.filter(({ event }) => event === "runtime.fault"), []);
		} finally {
			finishReplacement();
			await session.waitForIdle();
			binding.dispose();
		}
	});
}
