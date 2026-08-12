import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { InProcessHostedRuntime } from "../src/runtime/in-process-hosted-runtime.ts";
import type { HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";

const snapshot = {
	cwd: "/runtime/project",
	model: { provider: "test", modelId: "model" },
	thinking: "high" as const,
	tools: ["read"],
	skills: ["skill"],
	skillSources: [{ name: "skill", filePath: "/runtime/skill/SKILL.md" }],
	fileExtensionPaths: ["/runtime/extension.ts"],
	projectTrusted: true,
	sessionId: "runtime-session",
};

test("InProcessHostedRuntime translates Pi lifecycle and owns Pi intentions", async () => {
	const listeners = new Set<(event: unknown) => void>();
	const cancellation = new AbortController();
	const calls: string[] = [];
	const session = {
		isIdle: true,
		pendingMessageCount: 2,
		agent: { signal: cancellation.signal },
		subscribe(listener: (event: unknown) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		clearQueue() {
			calls.push("clear");
			return { steering: ["steer"], followUp: ["follow-up"] };
		},
		async abort() {
			calls.push("abort");
		},
		async waitForIdle() {
			calls.push("wait");
		},
		dispose() {
			calls.push("dispose");
		},
		getToolDefinition(name: string) {
			return name === "sequential" ? { executionMode: "sequential" } :
				name === "read" ? { executionMode: "parallel" } : undefined;
		},
		sendUserMessage: async () => undefined,
		sendCustomMessage: async () => undefined,
		_runAgentPrompt: async () => undefined,
	} as unknown as AgentSession;
	const projection = {
		sessionId: snapshot.sessionId,
		presentation: { render: () => [], invalidate() {} },
		physicalTerminal: {
			addOutputHandler: () => () => undefined,
			setAttached() {},
			pauseOutput() {},
			resumeOutput() {},
			async reinitializePresentation() {},
		},
		resize() {},
		dispatchInput() {},
		focusEditor() {},
		addChangeHandler: () => () => undefined,
		addFailureHandler: () => () => undefined,
		addExitRequestHandler: () => () => undefined,
		isProcessingInput: () => false,
		whenInputIdle: async () => undefined,
		ready: async () => undefined,
		cancelInitialization: () => undefined,
		dispose: async () => undefined,
	};
	const runtime = new InProcessHostedRuntime({
		session,
		projection,
		inspectSnapshot: () => snapshot,
	});
	const events: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => events.push(event));

	for (const listener of listeners) {
		listener({ type: "agent_start" });
		listener({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "error" }],
			willRetry: false,
		});
		listener({ type: "agent_settled" });
	}

	assert.deepEqual(events, [
		{ type: "state_changed" },
		{ type: "agent_end", outcome: "error", willRetry: false },
		{ type: "agent_settled" },
	]);
	assert.deepEqual(runtime.snapshot(), snapshot);
	assert.equal(runtime.workState(), "settled");
	assert.equal(runtime.queuedInputCount(), 2);
	assert.equal(runtime.classifyToolBatch(["read"]), "asynchronous");
	assert.equal(runtime.classifyToolBatch(["read", "sequential"]), "blocking");
	assert.equal(runtime.cancellationSignal(), cancellation.signal);
	assert.deepEqual(await runtime.clearQueue(), {
		steering: ["steer"],
		followUp: ["follow-up"],
	});
	await runtime.abort();
	await runtime.waitForIdle();
	await runtime.dispose();
	assert.deepEqual(calls, ["clear", "abort", "wait", "dispose"]);
});
