import assert from "node:assert/strict";
import test from "node:test";

import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import {
	configureCoordinatedSession,
	createAutomaticReconciliationStream,
	type AutomaticGenerationReconciliationAdapter,
	type AutomaticReconciliationRejection,
} from "../src/pi-integration/automatic-reconciliation.ts";
import { createUnboundTestOwnerHost } from "./support/pi-host.ts";

const MODEL = {
	id: "reconciliation-test",
	name: "Reconciliation test",
	api: "faux",
	provider: "faux",
	baseUrl: "http://faux.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_384,
	maxTokens: 256,
} as Model<"faux">;
const CONTEXT: Context = { messages: [] };

test("an adapter-proven continuation completes one text-only generation without another provider request", async () => {
	let providerRequests = 0;
	const failed = fauxAssistantMessage("Partial", {
		stopReason: "error",
		errorMessage: "provider stream interrupted after a resumable cursor",
	});
	const provider: StreamFn = () => {
		providerRequests += 1;
		return messageStream(failed);
	};
	const continued = fauxAssistantMessage("Partial response completed.");
	const adapter: AutomaticGenerationReconciliationAdapter = {
		continueGeneration: async ({ generation }) => ({
			kind: "continued",
			generation,
			recipe: "provider_native_stream_resumption",
			message: continued,
		}),
	};
	const stream = createAutomaticReconciliationStream(provider, adapter);

	const response = await stream(MODEL, CONTEXT);
	const result = await response.result();

	assert.deepEqual(result, continued);
	assert.equal(providerRequests, 1);
});

const REJECTED_FAULTS: readonly AutomaticReconciliationRejection[] = [
	"ambiguous_connection_loss",
	"regenerated_prompt",
	"malformed_tool_call",
	"context_limit",
	"authentication",
	"policy",
	"quota",
	"invalid_request",
	"uncertain_external_effect",
	"exhausted",
	"indeterminate",
	"unavailable",
];

for (const reason of REJECTED_FAULTS) {
	test(`${reason} remains the original generation failure without provider regeneration`, async () => {
		let providerRequests = 0;
		const failed = fauxAssistantMessage("Uncommitted partial response", {
			stopReason: "error",
			errorMessage: reason,
		});
		const stream = createAutomaticReconciliationStream(
			() => {
				providerRequests += 1;
				return messageStream(failed);
			},
			{
				continueGeneration: async () => ({ kind: "rejected", reason }),
			},
		);

		const response = await stream(MODEL, CONTEXT);

		assert.equal(await response.result(), failed);
		assert.equal(providerRequests, 1);
	});
}

test("a faulted generation containing a tool call is ineligible before consulting an adapter", async () => {
	const failed = fauxAssistantMessage(
		fauxToolCall("external_effect", { value: "unknown" }, { id: "uncertain-tool" }),
		{
			stopReason: "error",
			errorMessage: "connection ended while receiving a tool call",
		},
	);
	let adapterCalls = 0;
	const stream = createAutomaticReconciliationStream(
		() => messageStream(failed),
		{
			continueGeneration: async ({ generation }) => {
				adapterCalls += 1;
				return {
					kind: "continued",
					generation,
					recipe: "provider_native_stream_resumption",
					message: fauxAssistantMessage("Unsafe continuation"),
				};
			},
		},
	);

	const response = await stream(MODEL, CONTEXT);

	assert.equal(await response.result(), failed);
	assert.equal(adapterCalls, 0);
});

test("regenerated or tool-producing continuation output cannot satisfy adapter proof", async () => {
	const failed = fauxAssistantMessage("Stable prefix", {
		stopReason: "error",
		errorMessage: "resumable fault",
	});
	const unsafeMessages = [
		fauxAssistantMessage("Different regenerated output"),
		fauxAssistantMessage(
			[
				{ type: "text", text: "Stable prefix" },
				fauxToolCall("external_effect", {}, { id: "continued-tool" }),
			],
			{ stopReason: "toolUse" },
		),
	];
	for (const message of unsafeMessages) {
		const stream = createAutomaticReconciliationStream(
			() => messageStream(failed),
			{
				continueGeneration: async ({ generation }) => ({
					kind: "continued",
					generation,
					recipe: "provider_native_stream_resumption",
					message,
				}),
			},
		);
		const response = await stream(MODEL, CONTEXT);
		assert.equal(await response.result(), failed);
	}
});

test("continuation preserves streamed text even when the terminal provider error omits it", async () => {
	const failed = fauxAssistantMessage([], {
		stopReason: "error",
		errorMessage: "provider omitted its streamed prefix from the terminal error",
	});
	const observed = fauxAssistantMessage("Stable streamed prefix", {
		stopReason: "pending",
	});
	const provider: StreamFn = () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...observed, content: [] } });
			stream.push({
				type: "text_end",
				contentIndex: 0,
				content: "Stable streamed prefix",
				partial: observed,
			});
			stream.push({ type: "error", reason: "error", error: failed });
		});
		return stream;
	};
	const stream = createAutomaticReconciliationStream(provider, {
		continueGeneration: async ({ generation }) => ({
			kind: "continued",
			generation,
			recipe: "provider_native_stream_resumption",
			message: fauxAssistantMessage("Different regenerated output"),
		}),
	});

	const response = await stream(MODEL, CONTEXT);

	assert.equal(await response.result(), failed);
});

test("adapter errors and stale generation proof preserve the original failure", async () => {
	const failed = fauxAssistantMessage("Stable prefix", {
		stopReason: "error",
		errorMessage: "resumable fault",
	});
	const throwing = createAutomaticReconciliationStream(
		() => messageStream(failed),
		{
			continueGeneration: async () => {
				throw new Error("adapter unavailable");
			},
		},
	);
	const throwingResponse = await throwing(MODEL, CONTEXT);
	assert.equal(await throwingResponse.result(), failed);

	const stale = createAutomaticReconciliationStream(
		() => messageStream(failed),
		{
			continueGeneration: async ({ generation }) => ({
				kind: "continued",
				generation: Object.freeze({ run: {}, sequence: generation.sequence }),
				recipe: "provider_native_stream_resumption",
				message: fauxAssistantMessage("Stable prefix completed."),
			}),
		},
	);
	const staleResponse = await stale(MODEL, CONTEXT);
	assert.equal(await staleResponse.result(), failed);
});

test("coordinated sessions disable regenerated-prompt recovery without persisting user settings", async () => {
	const host = await createUnboundTestOwnerHost(() => undefined);
	host.services.settingsManager.applyOverrides({
		compaction: { enabled: true },
		transport: "auto",
		retry: {
			enabled: true,
			maxRetries: 4,
			provider: { maxRetries: 5 },
		},
	});
	const currentModel = host.session.model;
	assert.ok(currentModel);
	host.session.agent.state.model = {
		...currentModel,
		api: "openai-codex-responses",
	};

	configureCoordinatedSession(host.session);

	assert.equal(host.services.settingsManager.getCompactionEnabled(), false);
	assert.deepEqual(host.services.settingsManager.getRetrySettings(), {
		enabled: false,
		maxRetries: 0,
		baseDelayMs: 2000,
	});
	assert.equal(
		host.services.settingsManager.getProviderRetrySettings().maxRetries,
		0,
	);
	assert.equal(host.session.agent.transport, "sse");
	await host.runtime.dispose();
});

function messageStream(message: AssistantMessage): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const partial = { ...message, stopReason: "pending" as const };
		stream.push({ type: "start", partial });
		let terminal: AssistantMessageEvent;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			terminal = { type: "error", reason: message.stopReason, error: message };
		} else {
			if (message.stopReason === "pending") {
				throw new Error("Test stream requires a terminal Assistant Message");
			}
			terminal = { type: "done", reason: message.stopReason, message };
		}
		stream.push(terminal);
	});
	return stream;
}
