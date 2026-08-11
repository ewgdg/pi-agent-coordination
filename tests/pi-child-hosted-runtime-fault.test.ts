import assert from "node:assert/strict";
import test from "node:test";

import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import type {
	PiChildProcessLaunch,
	PiChildProcessRuntime,
	PiChildRuntimeEvent,
} from "../src/process-runtime/pi-child-process-runtime.ts";
import type { HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";

test("a post-admission child Runtime fault terminally fences its hosted Run once", async () => {
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	const admitted = {
		snapshot: {
			cwd: "/runtime",
			model: { provider: "test", modelId: "model" },
			thinking: "off",
			tools: [],
			skills: [],
			extensions: [],
			projectTrusted: true,
			sessionId: "fault-runtime",
		},
		channel: {
			onClose: () => () => undefined,
			async request() {
				return {
					accepted: true,
					transcriptCommitted: true,
					modelCycleStarted: true,
					queuedInputCount: 0,
				};
			},
		},
	} as unknown as PiChildProcessRuntime;
	const launch = {
		exited: new Promise<never>(() => undefined),
		ready: async () => admitted,
		cancelInitialization: () => undefined,
		frame: () => ({
			columns: 80,
			rows: 24,
			lines: [],
			cursor: { row: 0, column: 0, visible: false, style: "block", blink: false },
		}),
		writeInput() {},
		resize() {},
		addChangeHandler: () => () => undefined,
		addFailureHandler: () => () => undefined,
		onEvent(handler: (event: PiChildRuntimeEvent) => void) {
			eventHandlers.add(handler);
			return () => eventHandlers.delete(handler);
		},
		dispose: async () => undefined,
	} as unknown as PiChildProcessLaunch;
	const runtime = new PiChildHostedRuntime(launch);
	const hostedEvents: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => hostedEvents.push(event));
	await runtime.ready;
	const completion = runtime.deliver({ kind: "user", content: "Start the Run." }).completion;
	const emit = (event: PiChildRuntimeEvent) => {
		for (const handler of eventHandlers) handler(event);
	};
	emit(controlEvent("agent.start", {
		runId: "hosted-run-1",
		queuedInputCount: 0,
	}));
	emit(controlEvent("runtime.fault", {
		code: "participant_lifecycle_failed",
		message: "Owner rejected the awaited boundary",
	}));

	assert.equal(runtime.workState(), "unavailable");
	assert.equal(runtime.cancellationSignal().aborted, true);
	await assert.rejects(completion, /participant_lifecycle_failed.*Owner rejected/);
	assert.deepEqual(hostedEvents.slice(-3), [
		{ type: "agent_end", outcome: "error", willRetry: false },
		{ type: "state_changed" },
		{ type: "agent_settled" },
	]);

	emit(controlEvent("runtime.fault", {
		code: "duplicate_fault",
		message: "must not settle twice",
	}));
	assert.equal(
		hostedEvents.filter((event) => event.type === "agent_settled").length,
		1,
	);
	await runtime.dispose();
});

function controlEvent(
	event: PiChildRuntimeEvent["event"],
	payload: unknown,
): PiChildRuntimeEvent {
	return { event, payload } as PiChildRuntimeEvent;
}
