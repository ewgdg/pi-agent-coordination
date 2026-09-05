import assert from "node:assert/strict";
import test from "node:test";

import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import type {
	PiChildProcessLaunch,
	PiChildProcessRuntime,
	PiChildRuntimeEvent,
} from "../src/process-runtime/pi-child-process-runtime.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import type { HostedRuntimeEvent } from "../src/runtime/hosted-agent-runtime.ts";

test("an authenticated native child lifecycle adopts its transport identity without a dispatched cycle", async () => {
	const { runtime, emit } = createFakeRuntime();
	const hostedEvents: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => hostedEvents.push(event));
	await runtime.ready;

	emit(controlEvent("agent.start", {
		runId: "native-run-1",
		queuedInputCount: 0,
	}));
	assert.equal(runtime.workState(), "active");
	emit(controlEvent("agent.end", {
		runId: "native-run-1",
		outcome: "completed",
		willRetry: false,
		queuedInputCount: 0,
	}));
	emit(controlEvent("agent.settled", {
		runId: "native-run-1",
		outcome: "completed",
		queuedInputCount: 0,
	}));

	assert.equal(runtime.workState(), "settled");
	assert.deepEqual(hostedEvents, [
		{ type: "state_changed" },
		{ type: "agent_end", outcome: "completed", willRetry: false },
		{ type: "state_changed" },
		{ type: "agent_settled" },
	]);
	await runtime.dispose();
});

test("a post-admission child Runtime fault terminally fences its hosted Run once", async () => {
	const { runtime, emit } = createFakeRuntime();
	const hostedEvents: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => hostedEvents.push(event));
	await runtime.ready;
	const completion = runtime.deliver({ kind: "user", content: "Start the Run." }).completion;
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

test("child exit fences the hosted Run before its projection reports failure", async () => {
	const { runtime, settleExit } = createFakeRuntime();
	const ordering: string[] = [];
	runtime.subscribe((event) => {
		if (event.type === "agent_end") ordering.push("runtime fenced");
	});
	runtime.projection.addFailureHandler(() => ordering.push("projection failed"));
	await runtime.ready;
	const completion = runtime.deliver({ kind: "user", content: "Observe exit order." }).completion;
	void completion.catch(() => undefined);

	settleExit({ exitCode: 1, signal: 0 });
	await assert.rejects(completion, /child_runtime_unexpected_exit/);
	assert.deepEqual(ordering.slice(0, 2), ["runtime fenced", "projection failed"]);
	await runtime.dispose();
});

test("failed process Runtime cleanup does not repeat intentions over dead Control", async () => {
	const { runtime, emit, requestedMethods } = createFakeRuntime();
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "failed-process-runtime",
		startSession: async () => ({ runtime, ready: runtime.ready }),
	});
	await host.lane.run(() => host.startInLane());
	const delivery = host.deliverInLane({ kind: "user", content: "Fail this Run." });
	emit(controlEvent("agent.start", {
		runId: "hosted-run-1",
		queuedInputCount: 0,
	}));
	emit(controlEvent("runtime.fault", {
		code: "dead_control",
		message: "Control is already unavailable",
	}));
	await assert.rejects(delivery.completion, /dead_control/);

	await host.lane.run(() => host.discardAndEndInLane("failure"));
	assert.equal(host.observe().phase, "dormant");
	assert.deepEqual(requestedMethods, ["message.deliver"]);
});

test("cleanup does not duplicate a Runtime fault that wins an in-flight intention", async () => {
	const harness = createFakeRuntime({ holdQueueClear: true });
	const host = AgentRuntimeSupervisor.createChild({
		agentId: "failing-cleanup-runtime",
		startSession: async () => ({ runtime: harness.runtime, ready: harness.runtime.ready }),
	});
	await host.lane.run(() => host.startInLane());
	const delivery = host.deliverInLane({ kind: "user", content: "Race cleanup with failure." });
	void delivery.completion.catch(() => undefined);
	harness.emit(controlEvent("agent.start", {
		runId: "hosted-run-1",
		queuedInputCount: 0,
	}));

	const cleanup = host.lane.run(() => host.discardAndEndInLane("shutdown"));
	await harness.queueClearStarted;
	harness.emit(controlEvent("runtime.fault", {
		code: "control_lost_during_cleanup",
		message: "The Runtime fault owns this terminal transition",
	}));
	harness.rejectQueueClear(new Error("control_channel_closed: channel closed"));

	await cleanup;
	assert.equal(host.observe().phase, "dormant");
	assert.deepEqual(harness.requestedMethods, ["message.deliver", "queue.clear"]);
});

test("a stale child lifecycle event terminally fences the exact hosted Run once", async () => {
	const { runtime, emit } = createFakeRuntime();
	const hostedEvents: HostedRuntimeEvent[] = [];
	runtime.subscribe((event) => hostedEvents.push(event));
	await runtime.ready;
	const completion = runtime.deliver({ kind: "user", content: "Start the exact Run." }).completion;
	emit(controlEvent("agent.start", {
		runId: "hosted-run-1",
		queuedInputCount: 0,
	}));
	emit(controlEvent("agent.end", {
		runId: "stale-hosted-run",
		outcome: "completed",
		willRetry: false,
		queuedInputCount: 0,
	}));

	assert.equal(runtime.workState(), "unavailable");
	await assert.rejects(completion, /stale_run.*stale-hosted-run.*hosted-run-1/);
	assert.equal(
		hostedEvents.filter((event) => event.type === "agent_settled").length,
		1,
	);
	await runtime.dispose();
});

function createFakeRuntime(options: Readonly<{
	holdQueueClear?: boolean;
}> = {}): Readonly<{
	runtime: PiChildHostedRuntime;
	requestedMethods: string[];
	queueClearStarted: Promise<void>;
	rejectQueueClear(error: unknown): void;
	emit(event: PiChildRuntimeEvent): void;
	settleExit(exit: Readonly<{ exitCode: number; signal: number }>): void;
}> {
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	const requestedMethods: string[] = [];
	let settleExit!: (exit: Readonly<{ exitCode: number; signal: number }>) => void;
	const exited = new Promise<Readonly<{ exitCode: number; signal: number }>>((resolve) => {
		settleExit = resolve;
	});
	let markQueueClearStarted!: () => void;
	const queueClearStarted = new Promise<void>((resolve) => {
		markQueueClearStarted = resolve;
	});
	let rejectQueueClear!: (error: unknown) => void;
	const queueClear = new Promise<never>((_resolve, reject) => {
		rejectQueueClear = reject;
	});
	void queueClear.catch(() => undefined);
	const admitted = {
		snapshot: {
			cwd: "/runtime",
			model: { provider: "test", modelId: "model" },
			thinking: "off",
			tools: [],
			skills: [],
			skillSources: [],
			extensions: [],
			toolExecutionModes: [],
			projectTrusted: true,
			sessionId: "fault-runtime",
			sessionPath: "/sessions/fault-runtime.jsonl",
			systemPrompt: null,
			loadContextFiles: true,
		},
		channel: {
			onClose: () => () => undefined,
			async request(method: string) {
				requestedMethods.push(method);
				if (method === "queue.clear" && options.holdQueueClear) {
					markQueueClearStarted();
					return await queueClear;
				}
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
		exited,
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
	return {
		runtime: new PiChildHostedRuntime(launch, []),
		requestedMethods,
		queueClearStarted,
		rejectQueueClear,
		emit(event) {
			for (const handler of eventHandlers) handler(event);
		},
		settleExit,
	};
}

function controlEvent(
	event: PiChildRuntimeEvent["event"],
	payload: unknown,
): PiChildRuntimeEvent {
	return { event, payload } as PiChildRuntimeEvent;
}
