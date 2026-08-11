import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { PiChildHostedRuntime } from "../src/process-runtime/pi-child-hosted-runtime.ts";
import { PiChildProcessRuntime } from "../src/process-runtime/pi-child-process-runtime.ts";
import { InProcessAgentHost } from "../src/runtime/in-process-agent-host.ts";
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
		projectTrusted: true,
		ownerEnvironment: {
			...process.env,
			PI_SKIP_VERSION_CHECK: "1",
			PROCESS_RUNTIME_RESPONSE_DELAY_MS: "1000",
		},
		runtimeDirectory: root,
		columns: 80,
		rows: 24,
	});
	const pid = launch.pid;
	const bootstrapPath = launch.bootstrapPath;
	const runtime = new PiChildHostedRuntime(launch);
	const host = InProcessAgentHost.createChild({
		sessionManager: SessionManager.open(sessionPath),
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
		assert.throws(
			() => host.classifyToolBatch([]),
			/temporarily_unavailable: process-hosted tool classification/,
		);

		const content = [{ type: "text" as const, text: "Commit before model settlement." }];
		const delivery = host.deliverInLane(
			{ kind: "user", content },
			{
				inspectCommit: () => {
					const tail = SessionManager.open(sessionPath).getEntries().at(-1);
					return tail?.type === "message" &&
						tail.message.role === "user" &&
						JSON.stringify(tail.message.content) === JSON.stringify(content);
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

		const queued = host.deliverInLane({
			kind: "user",
			content: "Preserve this queued direction across the Hold.",
			deliverAs: "steer",
		});
		assert.equal(
			await host.lane.run(() => host.interruptCurrentRunInLane()),
			"held",
		);
		await Promise.all([delivery.completion, queued.completion]);
		assert.equal(cancellation.aborted, true);
		assert.equal(host.currentWorkState(), "settled");
		assert.equal(host.queuedInputCount(), 1);
		assert.deepEqual(settlements, ["settled"]);
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

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}
