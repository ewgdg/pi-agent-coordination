import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import type { ControlEvent } from "../src/control/agent-control-channel.ts";
import { agentControlProtocol } from "../src/control/agent-control-protocol.ts";
import { createAdmittedPiChildProcessProjection } from "../src/process-runtime/admitted-pi-child-process-projection.ts";
import { PiChildProcessRuntime } from "../src/process-runtime/pi-child-process-runtime.ts";
import type { OwnerParticipantRequestHandlers } from "../src/process-runtime/remote-participant-control.ts";
import {
	PROCESS_RUNTIME_TEST_MODEL,
	PROCESS_RUNTIME_TEST_PROVIDER,
	PROCESS_RUNTIME_TEST_RESPONSE,
} from "./fixtures/process-runtime-child-extension.ts";

const TEST_TIMEOUT_MS = 30_000;
const CHILD_EXTENSION = fileURLToPath(
	new URL("./fixtures/process-runtime-child-extension.ts", import.meta.url),
);

test("real Pi CLI runs one exact TUI session through the process Runtime Bridge", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-runtime-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000001";
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

	const lifecycle: string[] = [];
	const ownerIntentions: unknown[] = [];
	const runtimeEvents: ControlEvent<typeof agentControlProtocol>[] = [];
	let runtime: PiChildProcessRuntime | undefined;
	let projection: ReturnType<typeof createAdmittedPiChildProcessProjection> | undefined;
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "process-runtime-test-workflow",
			agentId: "process-runtime-test-agent",
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
			projectTrusted: true,
			ownerEnvironment: {
				...process.env,
				PI_SKIP_VERSION_CHECK: "1",
				PROCESS_RUNTIME_RESPONSE_DELAY_MS: "1000",
				HERDR_ENV: "owned",
				HERDR_SOCKET_PATH: "/tmp/owner-herdr.sock",
				HERDR_PANE_ID: "owner-pane",
			},
			runtimeDirectory: root,
			columns: 80,
			rows: 24,
			ownerRequestHandlers: ordinaryOwnerHandlers({
				executionStarted: () => ownerIntentions.push({
					agentId: "process-runtime-test-agent",
					intention: "executionStarted",
				}),
			}),
		});
		projection = createAdmittedPiChildProcessProjection(runtime);
		let projectionChanges = 0;
		let projectionExits = 0;
		const projectionFailures: unknown[] = [];
		projection.addChangeHandler(() => projectionChanges += 1);
		projection.addExitRequestHandler(() => projectionExits += 1);
		projection.addFailureHandler((error) => projectionFailures.push(error));
		runtime.onEvent((event: ControlEvent<typeof agentControlProtocol>) => {
			runtimeEvents.push(event);
			if (["agent.start", "agent.end", "agent.settled", "session.shutdown"].includes(event.event)) {
				lifecycle.push(event.event);
			}
		});

		assert.notEqual(runtime.pid, process.pid);
		assert.deepEqual(runtime.ready, {
			sessionId: expectedSessionId,
			mode: "tui",
			hasUI: true,
		});
		assert.deepEqual(runtime.snapshot, {
			cwd,
			model: {
				provider: PROCESS_RUNTIME_TEST_PROVIDER,
				modelId: PROCESS_RUNTIME_TEST_MODEL,
			},
			thinking: "off",
			tools: [],
			skills: [],
			skillSources: [],
			extensions: [CHILD_EXTENSION],
			toolExecutionModes: [],
			projectTrusted: true,
			sessionId: expectedSessionId,
			sessionPath,
			projectContext: null,
		});
		assert.equal((await stat(runtime.bootstrapPath)).mode & 0o777, 0o600);

		await waitForFrame(runtime, "PROCESS_RUNTIME_CHILD_WIDGET");
		assert.match(
			projection.presentation.render(80).map(stripTerminalSequences).join("\n"),
			/PROCESS_RUNTIME_CHILD_WIDGET/,
		);
		assert.match(frameText(runtime), /HERDR_ENV=undefined/);
		assert.match(frameText(runtime), /HERDR_SOCKET_PATH=undefined/);
		assert.match(frameText(runtime), /HERDR_PANE_ID=undefined/);

		assert.deepEqual(await runtime.prompt({
			runId: "process-runtime-test-run",
			input: "Complete the offline process Runtime Bridge test.",
			kind: "initial",
		}), { accepted: true });
		await waitUntil(() => lifecycle.includes("agent.settled"));
		assert.deepEqual(lifecycle.slice(0, 3), ["agent.start", "agent.end", "agent.settled"]);
		assert.deepEqual(ownerIntentions[0], {
			agentId: "process-runtime-test-agent",
			intention: "executionStarted",
		});
		assert.match(JSON.stringify(SessionManager.open(sessionPath).getEntries()), new RegExp(PROCESS_RUNTIME_TEST_RESPONSE));
		assert.deepEqual(await runtime.channel.request("queue.clear", {
			runId: "process-runtime-test-run",
		}), { steering: [], followUp: [], queuedInputCount: 0 });
		assert.deepEqual(await runtime.channel.request("run.interrupt", {
			runId: "process-runtime-test-run",
		}), { accepted: false });
		await assert.rejects(
			runtime.channel.request("queue.clear", { runId: "stale-process-runtime-run" }),
			/stale_run/,
		);
		await assert.rejects(
			runtime.channel.request("run.interrupt", { runId: "stale-process-runtime-run" }),
			/stale_run/,
		);

		assert.deepEqual(await runtime.channel.request("run.continue", {
			runId: "process-runtime-continued-run",
		}), { accepted: true });
		await waitUntil(() => lifecycle.filter((event) => event === "agent.settled").length === 2);

		const lifecycleBeforeDelivery = lifecycle.length;
		const activeDelivery = runtime.channel.request("message.deliver", {
			runId: "process-runtime-delivery-run",
			delivery: {
				kind: "user",
				content: "Commit before the delayed model turn settles.",
			},
		});
		await waitUntil(() => runtimeEvents.some((event) =>
			event.event === "agent.start" &&
			event.payload.runId === "process-runtime-delivery-run"
		));
		assert.equal(runtimeEvents.some((event) =>
			event.event === "agent.settled" &&
			event.payload.runId === "process-runtime-delivery-run"
		), false);
		const queuedDelivery = runtime.channel.request("message.deliver", {
			runId: "process-runtime-delivery-run",
			delivery: {
				kind: "user",
				content: "Clear this queued direction before it commits.",
				deliverAs: "steer",
			},
		});
		const clearedDelivery = runtime.channel.request("queue.clear", {
			runId: "process-runtime-delivery-run",
		});
		const interruptedDelivery = runtime.channel.request("run.interrupt", {
			runId: "process-runtime-delivery-run",
		});
		const activeDeliveryResult = await activeDelivery;
		assert.equal(activeDeliveryResult.accepted, true);
		assert.equal(activeDeliveryResult.transcriptCommitted, true);
		assert.equal(activeDeliveryResult.modelCycleStarted, true);
		assert.equal(
			lifecycle.slice(lifecycleBeforeDelivery).includes("agent.settled"),
			false,
		);
		assert.deepEqual(await clearedDelivery, {
			steering: ["Clear this queued direction before it commits."],
			followUp: [],
			queuedInputCount: 0,
		});
		assert.deepEqual(await interruptedDelivery, { accepted: true });
		assert.deepEqual(await queuedDelivery, {
			accepted: true,
			transcriptCommitted: false,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});
		await waitUntil(() => lifecycle.filter((event) => event === "agent.settled").length === 3);
		assert.equal(runtimeEvents.some((event) =>
			event.event === "agent.end" &&
			event.payload.runId === "process-runtime-delivery-run" &&
			event.payload.outcome === "interrupted" &&
			event.payload.willRetry === false
		), true);

		assert.deepEqual(await runtime.channel.request("message.deliver", {
			runId: "process-runtime-cancelled-delivery-run",
			delivery: {
				kind: "user",
				content: "Start work before the queued Control request is cancelled.",
			},
		}), {
			accepted: true,
			transcriptCommitted: true,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});
		const cancellation = new AbortController();
		const cancelledDelivery = runtime.channel.request("message.deliver", {
			runId: "process-runtime-cancelled-delivery-run",
			delivery: {
				kind: "user",
				content: "This cancelled queued direction must never commit.",
				deliverAs: "steer",
			},
		}, cancellation.signal);
		await new Promise((resolve) => setTimeout(resolve, 20));
		cancellation.abort();
		await assert.rejects(cancelledDelivery, (error: unknown) =>
			error instanceof Error && error.name === "AbortError"
		);
		await waitUntil(() => lifecycle.filter((event) => event === "agent.settled").length === 4);
		assert.doesNotMatch(
			JSON.stringify(SessionManager.open(sessionPath).getEntries()),
			/This cancelled queued direction must never commit/,
		);

		assert.deepEqual(await runtime.channel.request("message.deliver", {
			runId: "process-runtime-missing-commit-run",
			delivery: {
				kind: "user",
				content: "PROCESS_RUNTIME_DROP_MESSAGE_COMMIT",
			},
		}), {
			accepted: true,
			transcriptCommitted: false,
			modelCycleStarted: true,
			queuedInputCount: 0,
		});
		await waitUntil(() => lifecycle.filter((event) => event === "agent.settled").length === 5);
		assert.doesNotMatch(
			JSON.stringify(SessionManager.open(sessionPath).getEntries()),
			/PROCESS_RUNTIME_DROP_MESSAGE_COMMIT/,
		);

		projection.resize(100, 30);
		projection.dispatchInput("/runtime-probe OWNER_INPUT_OK\r");
		await waitForFrame(runtime, "INPUT=OWNER_INPUT_OK");
		assert.ok(projectionChanges > 0);
		assert.match(frameText(runtime), /SIZE=100x30/);
		assert.equal(runtime.frame().columns, 100);
		assert.equal(runtime.frame().rows, 30);

		const pid = runtime.pid;
		const bootstrapPath = runtime.bootstrapPath;
		const exit = await runtime.shutdown("test complete");
		assert.deepEqual(exit, { exitCode: 0, signal: 0 });
		await waitUntil(() => lifecycle.includes("session.shutdown"));
		await waitUntil(() => projectionExits === 1);
		assert.deepEqual(projectionFailures, []);
		assert.throws(() => process.kill(pid, 0), hasProcessCode("ESRCH"));
		await assert.rejects(lstat(bootstrapPath), hasFsCode("ENOENT"));
	} finally {
		await projection?.dispose();
		await runtime?.dispose();
	}
});

test("startup snapshot binds selected skills and file-backed launch inputs exactly", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-snapshot-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const skillDirectory = join(root, "skills", "review");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000004";
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	await mkdir(skillDirectory, { recursive: true });
	const sessionPath = join(sessionDirectory, "child.jsonl");
	const skillPath = join(skillDirectory, "SKILL.md");
	const projectContextPath = join(root, "project-context.md");
	const projectContextBody = [
		"# Rendered child context",
		"",
		"## /workspace/AGENTS.md",
		"Full rendered agentsFiles artifact.",
	].join("\n");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });
	await writeFile(skillPath, [
		"---",
		"name: review",
		"description: Review exact process state.",
		"---",
		"Review the process state.",
	].join("\n"));
	await writeFile(projectContextPath, projectContextBody);
	let runtime: PiChildProcessRuntime | undefined;
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "process-snapshot-workflow",
			agentId: "process-snapshot-agent",
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
				skills: ["review"],
				extensions: [CHILD_EXTENSION],
			},
			skillPaths: [skillPath],
			projectContextPath,
			projectTrusted: false,
			ownerEnvironment: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			runtimeDirectory: root,
		});
		assert.deepEqual(runtime.snapshot, {
			cwd,
			model: {
				provider: PROCESS_RUNTIME_TEST_PROVIDER,
				modelId: PROCESS_RUNTIME_TEST_MODEL,
			},
			thinking: "off",
			tools: [],
			skills: ["review"],
			skillSources: [{ name: "review", filePath: skillPath }],
			extensions: [CHILD_EXTENSION],
			toolExecutionModes: [],
			projectTrusted: false,
			sessionId: expectedSessionId,
			sessionPath,
			projectContext: { filePath: projectContextPath, body: projectContextBody },
		});
	} finally {
		await runtime?.dispose();
	}
});

test("real child Observe and Message tools reach the scoped Owner handlers", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-coordination-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000003";
	const agentId = "process-coordination-agent";
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
	const ownerCalls: unknown[] = [];
	const observeReceipt = {
		agentId,
		workflowId: "process-coordination-workflow",
		label: "Remote Child",
		directSpawnerAgentId: "owner-agent",
		primaryEvidence: {
			transcriptPath: sessionPath,
			inspectedThrough: { agentId, entryId: "entry-observed" },
		},
		run: { phase: "dormant", retentionReasons: [] },
	} as const;
	const messageReceipt = { messageId: "process-message-receipt", delivery: "pending" } as const;
	let runtime: PiChildProcessRuntime | undefined;
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "process-coordination-workflow",
			agentId,
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
				tools: ["agent_observe", "agent_message"],
				skills: [],
				extensions: [CHILD_EXTENSION],
			},
			skillPaths: [],
			projectTrusted: true,
			ownerEnvironment: {
				...process.env,
				PI_SKIP_VERSION_CHECK: "1",
				PROCESS_RUNTIME_COORDINATION_TOOLS: "1",
			},
			runtimeDirectory: root,
			ownerRequestHandlers: ordinaryOwnerHandlers({
				executionStarted: () => ownerCalls.push([agentId, "executionStarted"]),
				observe: (input) => ownerCalls.push([agentId, "agent_observe", input]),
				message: (toolCallId, input) =>
					ownerCalls.push([agentId, "agent_message", toolCallId, input]),
				observeReceipt,
				messageReceipt,
			}),
		});
		const events: string[] = [];
		runtime.onEvent((event) => events.push(event.event));
		assert.deepEqual(await runtime.prompt({
			runId: "process-coordination-run",
			input: "Invoke the scripted coordination tools.",
			kind: "initial",
		}), { accepted: true });
		await waitUntil(() => events.includes("agent.settled"));

		assert.deepEqual(ownerCalls.slice(0, 3), [
			[agentId, "executionStarted"],
			[agentId, "agent_observe", { operation: "status" }],
			[agentId, "agent_message", "process-message-call", {
				operation: "send",
				targetAgentId: "process-target-agent",
				content: "Exact process message",
			}],
		]);
		const results = SessionManager.open(sessionPath).getEntries().flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult"
				? [entry.message]
				: []
		);
		assert.deepEqual(results.find((message) => message?.toolCallId === "process-observe-call")?.details, observeReceipt);
		assert.deepEqual(results.find((message) => message?.toolCallId === "process-message-call")?.details, messageReceipt);
	} finally {
		await runtime?.dispose();
	}
});

test("process Runtime Host force-kills a child whose session shutdown never completes", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-child-runtime-stubborn-test-"));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	const expectedSessionId = "019a6b4d-1b22-7000-8000-000000000002";
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

	let runtime: PiChildProcessRuntime | undefined;
	try {
		runtime = await PiChildProcessRuntime.start({
			workflowId: "process-runtime-stubborn-test-workflow",
			agentId: "process-runtime-stubborn-test-agent",
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
			projectTrusted: true,
			ownerEnvironment: {
				...process.env,
				PI_SKIP_VERSION_CHECK: "1",
				PROCESS_RUNTIME_HANG_SHUTDOWN: "1",
			},
			runtimeDirectory: root,
			columns: 80,
			rows: 24,
		});
		const pid = runtime.pid;
		const bootstrapPath = runtime.bootstrapPath;
		const exit = await runtime.shutdown("force-cleanup test", 100);
		assert.notEqual(exit.signal, 0);
		assert.throws(() => process.kill(pid, 0), hasProcessCode("ESRCH"));
		await assert.rejects(lstat(bootstrapPath), hasFsCode("ENOENT"));
	} finally {
		await runtime?.dispose();
	}
});

function ordinaryOwnerHandlers(options: Readonly<{
	executionStarted?: () => void;
	observe?: (input: { operation: "status" | "children"; agentId?: string }) => void;
	message?: (toolCallId: string, input: unknown) => void;
	observeReceipt?: Awaited<ReturnType<OwnerParticipantRequestHandlers<"ordinary">["coordination"]["observe"]>>;
	messageReceipt?: Awaited<ReturnType<OwnerParticipantRequestHandlers<"ordinary">["coordination"]["message"]>>;
}> = {}): OwnerParticipantRequestHandlers<"ordinary"> {
	return {
		lifecycle: {
			async executionStarted() { options.executionStarted?.(); },
			async humanInputSubmitted() { return false; },
			async humanInputMode() { return "agent"; },
			async humanToolResultCommitting() { return undefined; },
			async toolExecutionStarted() {},
			async safeBoundaryReached() {},
			async executionEnded() {},
		},
		coordination: {
			async observe(input) {
				options.observe?.(input);
				return options.observeReceipt ?? {
					children: [],
				};
			},
			async message(toolCallId, input) {
				options.message?.(toolCallId, input);
				return options.messageReceipt ?? { messageId: "unused-message", delivery: "pending" };
			},
			async control(_toolCallId, input) {
				return { agentId: input.agentId, disposition: "not_running" };
			},
			async spawn() {
				return { disposition: "not_created", failedStage: "identity_commit" };
			},
			async askUserQuestion() {
				return { requestId: "unused-human", answer: "unused" };
			},
		},
	};
}

function frameText(runtime: PiChildProcessRuntime): string {
	return runtime.frame().lines.map((line) => line.text).join("\n");
}

async function waitForFrame(runtime: PiChildProcessRuntime, expected: string): Promise<void> {
	await waitUntil(async () => {
		await runtime.drain();
		return frameText(runtime).includes(expected);
	});
}

async function waitUntil(condition: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for process Runtime Bridge state");
}

function hasFsCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}

function hasProcessCode(code: string): (error: unknown) => boolean {
	return hasFsCode(code);
}
