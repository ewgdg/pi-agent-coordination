import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import {
	PiChildProcessRuntime,
	type PiChildProcessLaunch,
	type PiChildRuntimeEvent,
} from "../src/process-runtime/pi-child-process-runtime.ts";
import type { OwnerParticipantRequestHandlers } from "../src/process-runtime/remote-participant-control.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import {
	PROCESS_RUNTIME_TEST_MODEL,
	PROCESS_RUNTIME_TEST_PROVIDER,
} from "./fixtures/process-runtime-child-extension.ts";

const TEST_TIMEOUT_MS = 30_000;
const CHILD_EXTENSION = fileURLToPath(
	new URL("./fixtures/process-runtime-child-extension.ts", import.meta.url),
);

test("the common Runtime Host supervises one real Control-backed Pi child Runtime", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-hosted-runtime-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000201";
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });

	const launch = await PiChildProcessRuntime.launch({
		workflowId: "hosted-runtime-test-workflow",
		agentId: "hosted-runtime-test-agent",
		role: "ordinary",
		expectedSessionId,
		sessionPath,
		configuration: {
			cwd,
			model: {
				provider: PROCESS_RUNTIME_TEST_PROVIDER,
				modelId: PROCESS_RUNTIME_TEST_MODEL,
			},
			thinking: "off",
			tools: [],
			skills: [],
			extensions: [CHILD_EXTENSION],
		},
		skillPaths: [],
		agentsFiles: [],
		projectTrusted: true,
		ownerEnvironment: {
			...process.env,
			PI_SKIP_VERSION_CHECK: "1",
			PROCESS_RUNTIME_RESPONSE_DELAY_MS: "300",
		},
		runtimeDirectory: root,
		columns: 80,
		rows: 24,
		ownerRequestHandlers: ordinaryOwnerHandlers(),
	});
	const pid = launch.pid;
	const bootstrapPath = launch.bootstrapPath;
	const runtime = new PiChildHostedRuntime(launch);
	const host = AgentRuntimeSupervisor.createChild({
		agentId: expectedSessionId,
		startSession: async () => ({ runtime, ready: runtime.ready }),
	});
	const settlements: string[] = [];
	host.addSettledHandler((_handle, settlement) => settlements.push(settlement));

	try {
		const handle = await host.lane.run(() => host.startInLane());
		assert.deepEqual(host.effectiveRuntimeSnapshot(), {
			cwd,
			model: {
				provider: PROCESS_RUNTIME_TEST_PROVIDER,
				modelId: PROCESS_RUNTIME_TEST_MODEL,
			},
			thinking: "off",
			tools: [],
			skills: [],
			fileExtensionPaths: [CHILD_EXTENSION],
			projectTrusted: true,
			sessionId: expectedSessionId,
		});
		assert.equal(host.currentProjection(), runtime.projection);
		assert.equal(host.currentWorkState(), "settled");
		assert.equal(host.classifyToolBatch([]), "asynchronous");
		assert.throws(
			() => host.classifyToolBatch(["missing-tool"]),
			/invariant_violation: tool definition missing-tool is unavailable/,
		);

		const handled = host.deliverInLane(
			{ kind: "user", content: "PROCESS_RUNTIME_HANDLED_INPUT" },
			{ inspectCommit: () => false },
		);
		assert.equal(await handled.transcriptCommit, false);
		assert.equal(await Promise.race([
			handled.completion.then(() => "completed" as const),
			new Promise<"timed_out">((resolve) =>
				setTimeout(() => resolve("timed_out"), 1_000)
			),
		]), "completed");
		assert.equal(host.currentWorkState(), "settled");
		assert.deepEqual(await runtime.clearQueue(), { steering: [], followUp: [] });
		await runtime.abort();

		const customMessage = createMessageDelivery([{
			source: {
				agentId: "hosted-runtime-sender",
				entryId: "hosted-runtime-source-entry",
				toolCallId: "hosted-runtime-source-call",
			},
			projection: {
				kind: "message",
				messageId: "hosted-runtime-source-call",
				fromAgentId: "hosted-runtime-sender",
				content: "Commit this custom Delivery before settlement.",
			},
		}]);
		const delivery = host.deliverInLane(
			{ kind: "custom", message: customMessage, triggerTurn: true },
			{
				inspectCommit: () => {
					const tail = SessionManager.open(sessionPath).getEntries().at(-1);
					return tail?.type === "custom_message" &&
						tail.customType === customMessage.customType &&
						tail.content === customMessage.content;
				},
			},
		);
		let deliveryCompleted = false;
		void delivery.completion.then(() => deliveryCompleted = true);
		assert.equal(await delivery.transcriptCommit, true);
		assert.equal(deliveryCompleted, false);
		assert.equal(host.currentWorkState(), "active");
		const cancellation = host.exactRunCancellationSignal(handle);
		assert.equal(cancellation.aborted, false);
		await delivery.completion;
		assert.equal(cancellation.aborted, false);

		const activeContent = [{ type: "text" as const, text: "Interrupt this model cycle." }];
		const activeDelivery = host.deliverInLane(
			{ kind: "user", content: activeContent },
			{
				inspectCommit: () => {
					const tail = SessionManager.open(sessionPath).getEntries().at(-1);
					return tail?.type === "message" &&
						tail.message.role === "user" &&
						JSON.stringify(tail.message.content) === JSON.stringify(activeContent);
				},
			},
		);
		assert.equal(await activeDelivery.transcriptCommit, true);
		assert.equal(host.exactRunCancellationSignal(handle), cancellation);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const queued = host.deliverInLane({
			kind: "user",
			content: "Preserve this queued direction across the Hold.",
			deliverAs: "steer",
		});
		assert.equal(
			await host.lane.run(() => host.interruptCurrentRunInLane()),
			"held",
		);
		await Promise.all([activeDelivery.completion, queued.completion]);
		assert.equal(cancellation.aborted, true);
		assert.equal(host.currentWorkState(), "settled");
		assert.equal(host.queuedInputCount(), 1);
		assert.deepEqual(settlements, ["settled", "settled"]);
		assert.deepEqual(host.observe(), {
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [{ reason: "interruption_hold", count: 1 }],
		});

		await host.lane.run(() => host.discardAndEndInLane("termination"));
		assert.equal(host.observe().phase, "dormant");
		assert.throws(() => process.kill(pid, 0), hasCode("ESRCH"));
		await assert.rejects(lstat(bootstrapPath), hasCode("ENOENT"));
	} finally {
		await launch.dispose();
	}
});

test("retry and normal agent-end boundaries do not falsely cancel the exact hosted Run", async () => {
	const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
	const admitted = {
		snapshot: {
			cwd: "/runtime",
			model: { provider: "test", modelId: "model" },
			thinking: "off",
			tools: ["parallel-tool", "sequential-tool"],
			skills: [],
			skillSources: [],
			extensions: [],
			toolExecutionModes: [
				{ name: "parallel-tool", executionMode: "parallel" },
				{ name: "sequential-tool", executionMode: "sequential" },
			],
			projectTrusted: true,
			sessionId: "retry-runtime",
			sessionPath: "/sessions/retry-runtime.jsonl",
			projectContext: null,
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
	await runtime.ready;
	assert.equal(runtime.classifyToolBatch(["parallel-tool"]), "asynchronous");
	assert.equal(
		runtime.classifyToolBatch(["parallel-tool", "sequential-tool"]),
		"blocking",
	);
	assert.throws(
		() => runtime.classifyToolBatch(["missing-tool"]),
		/invariant_violation: tool definition missing-tool is unavailable/,
	);
	const completion = runtime.deliver({ kind: "user", content: "Retry this Run." }).completion;
	const emit = (event: PiChildRuntimeEvent) => {
		for (const handler of eventHandlers) handler(event);
	};

	emit(controlEvent("agent.start", { runId: "hosted-run-1", queuedInputCount: 0 }));
	const cancellation = runtime.cancellationSignal();
	emit(controlEvent("agent.end", {
		runId: "hosted-run-1",
		outcome: "failed",
		willRetry: true,
		queuedInputCount: 0,
		error: "retryable",
	}));
	assert.equal(cancellation.aborted, false);
	emit(controlEvent("agent.start", { runId: "hosted-run-1", queuedInputCount: 0 }));
	assert.equal(runtime.cancellationSignal(), cancellation);
	emit(controlEvent("agent.end", {
		runId: "hosted-run-1",
		outcome: "completed",
		willRetry: false,
		queuedInputCount: 0,
	}));
	assert.equal(cancellation.aborted, false);
	emit(controlEvent("agent.settled", {
		runId: "hosted-run-1",
		outcome: "completed",
		queuedInputCount: 0,
	}));
	await completion;
	await runtime.dispose();
});

for (const failure of ["channel_loss", "process_kill"] as const) {
	test(`an unexpected real child ${failure} terminally fails the common hosted Run`, {
		timeout: TEST_TIMEOUT_MS,
		skip: process.platform === "win32",
	}, async () => {
		const harness = await createFailureHarness(failure);
		const settlements: string[] = [];
		harness.host.addSettledHandler((_handle, settlement) => settlements.push(settlement));
		try {
			const delivery = harness.host.deliverInLane(
				{ kind: "user", content: `Fail during ${failure}.` },
				{
					inspectCommit: () => SessionManager.open(harness.sessionPath)
						.getEntries()
						.some((entry) =>
							entry.type === "message" &&
							entry.message.role === "user"
						),
				},
			);
			assert.equal(await delivery.transcriptCommit, true);
			const cancellation = harness.host.exactRunCancellationSignal(harness.handle);
			if (failure === "channel_loss") {
				await (await harness.launch.ready()).channel.close();
			} else {
				process.kill(harness.launch.pid, "SIGKILL");
			}
			await waitUntil(() => settlements.length === 1);
			await assert.rejects(delivery.completion);
			assert.deepEqual(settlements, ["failed"]);
			assert.equal(cancellation.aborted, true);
			assert.equal(harness.host.currentRunFailed(), true);
			assert.equal(harness.host.currentWorkState(), "unavailable");
			const failedRunState = harness.host.observe();
			assert.equal("work" in failedRunState && failedRunState.work, "settled");
			await harness.launch.exited;
			await waitUntil(async () => {
				try {
					await lstat(harness.contextArtifactPath);
					return false;
				} catch (error) {
					return hasCode("ENOENT")(error);
				}
			});
			await harness.host.lane.run(() =>
				harness.host.discardAndEndInLane("failure")
			).catch(() => undefined);
			assert.equal(harness.host.observe().phase, "dormant");
			assert.throws(() => process.kill(harness.launch.pid, 0), hasCode("ESRCH"));
		} finally {
			await harness.launch.dispose();
		}
	});
}

function ordinaryOwnerHandlers(): OwnerParticipantRequestHandlers<"ordinary"> {
	return {
		presentation: {
			snapshot: () => ({
				live: [], dormant: [], selectedAgentId: "hosted-child",
				humanAttention: [], operationalAttention: [],
			}),
			async select() {},
		},
		lifecycle: {
			async executionStarted() {},
			async humanInputSubmitted() { return false; },
			async humanInputMode() { return "agent"; },
			async humanToolResultCommitting() { return undefined; },
			async toolExecutionStarted() {},
			async safeBoundaryReached() {},
			async executionEnded() {},
		},
		coordination: {
			async observe() { return { children: [] }; },
			async message() { return { messageId: "unused-message", delivery: "pending" }; },
			async control(_toolCallId, input) {
				return { agentId: input.agentId, disposition: "not_running" };
			},
			async spawn() { return { disposition: "not_created", failedStage: "identity_commit" }; },
			async askUserQuestion() { return { requestId: "unused-human", answer: "unused" }; },
		},
	};
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}

async function createFailureHarness(name: "channel_loss" | "process_kill") {
	const root = await mkdtemp(join(tmpdir(), `pi-child-hosted-${name}-`));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = name === "channel_loss"
		? "019a6b4d-1b22-7000-8000-000000000202"
		: "019a6b4d-1b22-7000-8000-000000000203";
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });
	const launch = await PiChildProcessRuntime.launch({
		workflowId: `hosted-${name}-workflow`,
		agentId: `hosted-${name}-agent`,
		role: "ordinary",
		expectedSessionId,
		sessionPath,
		configuration: {
			cwd,
			model: {
				provider: PROCESS_RUNTIME_TEST_PROVIDER,
				modelId: PROCESS_RUNTIME_TEST_MODEL,
			},
			thinking: "off",
			tools: [],
			skills: [],
			extensions: [CHILD_EXTENSION],
		},
		skillPaths: [],
		agentsFiles: [{
			path: "/project/AGENTS.md",
			content: `Hosted failure context for ${name}`,
		}],
		projectTrusted: true,
		ownerEnvironment: {
			...process.env,
			PI_SKIP_VERSION_CHECK: "1",
			PROCESS_RUNTIME_RESPONSE_DELAY_MS: "5000",
		},
		runtimeDirectory: root,
		columns: 80,
		rows: 24,
		ownerRequestHandlers: ordinaryOwnerHandlers(),
	});
	const runtime = new PiChildHostedRuntime(launch);
	const host = AgentRuntimeSupervisor.createChild({
		agentId: expectedSessionId,
		startSession: async () => ({ runtime, ready: runtime.ready }),
	});
	const handle = await host.lane.run(() => host.startInLane());
	const contextArtifactPath = (await launch.ready()).snapshot.projectContext?.filePath;
	assert.ok(contextArtifactPath);
	return { launch, host, handle, sessionPath, contextArtifactPath };
}

async function waitUntil(condition: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for hosted Runtime state");
}

function controlEvent(
	event: PiChildRuntimeEvent["event"],
	payload: unknown,
): PiChildRuntimeEvent {
	return { event, payload } as PiChildRuntimeEvent;
}
