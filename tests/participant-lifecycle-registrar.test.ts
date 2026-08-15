import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent";

import {
	createAgentBoundExtension,
	createModeratorBoundExtension,
} from "../src/bootstrap/agent-extension.ts";
import type {
	ModeratorAgentCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "../src/coordination/workflow-coordinator.ts";
import {
	registerParticipantInputLifecycle,
	registerParticipantLifecycle,
	type ParticipantLifecycleHandlers,
} from "../src/pi-integration/participant-lifecycle.ts";

const lifecycleEventNames = [
	"agent_end",
	"agent_start",
	"input",
	"message_end",
	"tool_execution_start",
	"turn_end",
] as const;

const toolResultMessage: MessageEndEvent["message"] = {
	role: "toolResult",
	toolCallId: "human-tool-call",
	toolName: "ask_user_question",
	content: [{ type: "text", text: "Answer" }],
	isError: false,
	timestamp: 1,
};

test("participant lifecycle registrar routes the exact current Pi boundaries in order", async () => {
	const calls: unknown[] = [];
	const images = [{ type: "image", mimeType: "image/png", data: "image-data" }] as const;
	const handlers = lifecycleHandlers({
		async executionStarted() {
			calls.push("execution-started");
		},
		async humanInputSubmitted(input) {
			calls.push(["human-input", input]);
			return "continue";
		},
		async humanToolResultCommitting(input) {
			calls.push(["human-result", input]);
		},
		async toolExecutionStarted(input) {
			calls.push(["tool-started", input]);
		},
		async safeBoundaryReached() {
			calls.push("safe-boundary");
		},
		async executionEnded() {
			calls.push("execution-ended");
		},
	});
	const pi = new CapturedExtensionApi();
	registerParticipantLifecycle(pi.api, handlers);
	const context = createExtensionContext();

	assert.deepEqual([...pi.handlers.keys()].sort(), [...lifecycleEventNames].sort());
	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: "extension delivery",
			source: "extension",
		}, context),
		{ action: "continue" },
	);
	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: "queued continuation",
			source: "interactive",
			streamingBehavior: "followUp",
		}, context),
		{ action: "continue" },
	);
	assert.deepEqual(calls, []);

	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: "human input",
			images: [...images],
			source: "interactive",
		}, context),
		{ action: "continue" },
	);
	await pi.emit("agent_start", { type: "agent_start" }, context);
	assert.equal(
		await pi.emit("message_end", {
			type: "message_end",
			message: toolResultMessage,
		}, context),
		undefined,
	);
	await pi.emit("tool_execution_start", {
		type: "tool_execution_start",
		toolCallId: "tool-call-1",
		toolName: "read",
		args: { path: "README.md" },
	}, context);
	await pi.emit("turn_end", {
		type: "turn_end",
		turnIndex: 0,
		message: toolResultMessage,
		toolResults: [toolResultMessage],
	}, context);
	await pi.emit("agent_end", {
		type: "agent_end",
		messages: [toolResultMessage],
	}, context);

	assert.deepEqual(calls, [
		["human-input", { text: "human input", images: [...images] }],
		"execution-started",
		["human-result", { message: toolResultMessage }],
		["tool-started", { toolCallId: "tool-call-1", toolName: "read" }],
		"safe-boundary",
		"execution-ended",
	]);
});

test("ordinary and Moderator extensions preserve local lifecycle operation order", async (t) => {
	for (const role of ["ordinary", "moderator"] as const) {
		await t.test(role, async () => {
			const calls: unknown[] = [];
			const view = localLifecycleView(calls);
			const extension = role === "ordinary"
				? createAgentBoundExtension(
					() => view as unknown as OrdinaryAgentCoordinatorView,
				)
				: createModeratorBoundExtension(
					() => view as unknown as ModeratorAgentCoordinatorView,
				);
			const pi = new CapturedExtensionApi();
			await runExtension(extension, pi.api);
			const context = createExtensionContext();

			assert.deepEqual(
				await pi.emit("input", {
					type: "input",
					text: "resume locally",
					source: "interactive",
				}, context),
				{ action: "continue" },
			);
			await pi.emit("agent_start", { type: "agent_start" }, context);
			await pi.emit("message_end", {
				type: "message_end",
				message: toolResultMessage,
			}, context);
			await pi.emit("tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: "tool-call-2",
				toolName: "bash",
				args: { command: "true" },
			}, context);
			await pi.emit("turn_end", {
				type: "turn_end",
				turnIndex: 0,
				message: toolResultMessage,
				toolResults: [toolResultMessage],
			}, context);
			await pi.emit("agent_end", {
				type: "agent_end",
				messages: [toolResultMessage],
			}, context);

			assert.deepEqual(calls, [
				["resume-human", "resume locally", undefined],
				"begin-execution",
				["guard-human-result", toolResultMessage],
				"reconcile-human-results",
				"reconcile-committed-results",
				"ensure-execution",
				["begin-tool", "tool-call-2", "bash"],
				"reconcile-human-results",
				"reconcile-committed-results",
				"ensure-execution",
				"reach-safe-boundary",
				"reconcile-committed-results",
				"end-execution",
				"reconcile-human-results",
			]);
		});
	}
});

test("participant input registration can follow inherited extension preflights", async () => {
	let submitted = 0;
	const handlers = lifecycleHandlers({
		async humanInputSubmitted() {
			submitted += 1;
			return "continue";
		},
	});
	const pi = new CapturedExtensionApi();
	registerParticipantLifecycle(pi.api, handlers, { registerInput: false });
	assert.equal(pi.handlers.has("input"), false);

	registerParticipantInputLifecycle(pi.api, handlers);
	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: "submitted after inherited preflight",
			source: "interactive",
		}, createExtensionContext()),
		{ action: "continue" },
	);
	assert.equal(submitted, 1);
});

test("participant lifecycle registrar preserves native Human Answer recovery", async () => {
	const failure = new Error("human submission failed");
	const handlers = lifecycleHandlers({
		async humanInputSubmitted() {
			throw failure;
		},
		async humanInputMode() {
			return "answer";
		},
		async humanToolResultCommitting() {
			return {
				rejectedAnswer: "Rejected answer",
				reason: "the exact request ended",
			};
		},
	});
	const pi = new CapturedExtensionApi();
	registerParticipantLifecycle(pi.api, handlers);
	const context = createExtensionContext("newer draft");

	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: "Submitted answer",
			source: "interactive",
		}, context),
		{ action: "handled" },
	);
	assert.equal(context.ui.getEditorText(), "Submitted answer");
	assert.deepEqual(context.notifications, [{
		message: "Human Answer was not submitted: human submission failed",
		type: "error",
	}]);

	assert.equal(
		await pi.emit("message_end", {
			type: "message_end",
			message: toolResultMessage,
		}, context),
		undefined,
	);
	assert.equal(
		context.ui.getEditorText(),
		"Rejected answer\nSubmitted answer",
	);
	assert.deepEqual(context.notifications.at(-1), {
		message: "Human Answer was not committed: the exact request ended",
		type: "error",
	});
});

test("participant lifecycle registrar preserves fail-fast handler errors", async (t) => {
	const cases = [
		["agent_start", "executionStarted", { type: "agent_start" }],
		[
			"message_end",
			"humanToolResultCommitting",
			{ type: "message_end", message: toolResultMessage },
		],
		[
			"tool_execution_start",
			"toolExecutionStarted",
			{
				type: "tool_execution_start",
				toolCallId: "tool-call-failure",
				toolName: "read",
				args: {},
			},
		],
		[
			"turn_end",
			"safeBoundaryReached",
			{
				type: "turn_end",
				turnIndex: 0,
				message: toolResultMessage,
				toolResults: [toolResultMessage],
			},
		],
		[
			"agent_end",
			"executionEnded",
			{ type: "agent_end", messages: [toolResultMessage] },
		],
	] as const;
	for (const [eventName, handlerName, event] of cases) {
		await t.test(eventName, async () => {
			const failure = new Error(`exact ${handlerName} failure`);
			const pi = new CapturedExtensionApi();
			registerParticipantLifecycle(
				pi.api,
				lifecycleHandlers({
					[handlerName]: async () => {
						throw failure;
					},
				}),
			);
			await assert.rejects(
				pi.emit(eventName, event, createExtensionContext()),
				(error) => error === failure,
			);
		});
	}

	await t.test("human input mode lookup", async () => {
		const submissionFailure = new Error("submission failed");
		const modeFailure = new Error("exact mode lookup failure");
		const pi = new CapturedExtensionApi();
		registerParticipantLifecycle(pi.api, lifecycleHandlers({
			async humanInputSubmitted() {
				throw submissionFailure;
			},
			async humanInputMode() {
				throw modeFailure;
			},
		}));
		await assert.rejects(
			pi.emit("input", {
				type: "input",
				text: "answer",
				source: "interactive",
			}, createExtensionContext()),
			(error) => error === modeFailure,
		);
	});
});

function lifecycleHandlers(
	overrides: Partial<ParticipantLifecycleHandlers> = {},
): ParticipantLifecycleHandlers {
	return {
		async executionStarted() {},
		async humanInputSubmitted() {
			return "continue";
		},
		async humanInputMode() {
			return "agent";
		},
		async humanToolResultCommitting() {},
		async toolExecutionStarted() {},
		async safeBoundaryReached() {},
		async executionEnded() {},
		...overrides,
	};
}

function localLifecycleView(calls: unknown[]) {
	return {
		async resumeFromHuman(text: string, images: readonly unknown[] | undefined) {
			calls.push(["resume-human", text, images]);
			return "continue" as const;
		},
		agentActivity() {
			return { answerMode: false };
		},
		async beginExecution() {
			calls.push("begin-execution");
		},
		guardHumanToolResult(message: MessageEndEvent["message"]) {
			calls.push(["guard-human-result", message]);
		},
		reconcileHumanToolResults() {
			calls.push("reconcile-human-results");
		},
		reconcileCommittedToolResults() {
			calls.push("reconcile-committed-results");
		},
		async ensureExecution() {
			calls.push("ensure-execution");
		},
		beginToolExecution(toolCallId: string, toolName: string) {
			calls.push(["begin-tool", toolCallId, toolName]);
		},
		async reachSafeBoundary() {
			calls.push("reach-safe-boundary");
		},
		endExecution() {
			calls.push("end-execution");
		},
	};
}

type CapturedHandler = (event: never, context: ExtensionContext) => unknown;

class CapturedExtensionApi {
	readonly handlers = new Map<string, CapturedHandler[]>();
	readonly api = {
		on: (eventName: string, handler: CapturedHandler) => {
			const handlers = this.handlers.get(eventName) ?? [];
			handlers.push(handler);
			this.handlers.set(eventName, handlers);
		},
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
	} as unknown as ExtensionAPI;

	async emit(
		eventName: string,
		event: unknown,
		context: ExtensionContext,
	): Promise<unknown> {
		const handlers = this.handlers.get(eventName) ?? [];
		assert.equal(handlers.length, 1, eventName);
		return handlers[0]!(event as never, context);
	}
}

function createExtensionContext(initialEditorText = "") {
	let editorText = initialEditorText;
	const notifications: Array<{
		message: string;
		type?: "info" | "warning" | "error";
	}> = [];
	const ui = {
		setEditorText(text: string) {
			editorText = text;
		},
		getEditorText() {
			return editorText;
		},
		notify(message: string, type?: "info" | "warning" | "error") {
			notifications.push({ message, type });
		},
	};
	return Object.assign(
		{ ui },
		{ notifications },
	) as unknown as ExtensionContext & { notifications: typeof notifications };
}

async function runExtension(extension: ExtensionFactory, pi: ExtensionAPI): Promise<void> {
	await extension(pi);
}
