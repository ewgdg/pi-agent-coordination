import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { ControlEvent } from "../src/control/agent-control-channel.ts";
import { agentControlProtocol } from "../src/control/agent-control-protocol.ts";
import { PiChildProcessRuntime } from "../src/process-runtime/pi-child-process-runtime.ts";
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
	let runtime: PiChildProcessRuntime | undefined;
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
				HERDR_ENV: "owned",
				HERDR_SOCKET_PATH: "/tmp/owner-herdr.sock",
				HERDR_PANE_ID: "owner-pane",
			},
			runtimeDirectory: root,
			columns: 80,
			rows: 24,
		});
		runtime.onEvent((event: ControlEvent<typeof agentControlProtocol>) => {
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
			extensions: [CHILD_EXTENSION],
			sessionId: expectedSessionId,
		});
		assert.equal((await stat(runtime.bootstrapPath)).mode & 0o777, 0o600);

		await waitForFrame(runtime, "PROCESS_RUNTIME_CHILD_WIDGET");
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
		assert.match(JSON.stringify(SessionManager.open(sessionPath).getEntries()), new RegExp(PROCESS_RUNTIME_TEST_RESPONSE));

		runtime.resize(100, 30);
		runtime.writeInput("/runtime-probe OWNER_INPUT_OK\r");
		await waitForFrame(runtime, "INPUT=OWNER_INPUT_OK");
		assert.match(frameText(runtime), /SIZE=100x30/);
		assert.equal(runtime.frame().columns, 100);
		assert.equal(runtime.frame().rows, 30);

		const pid = runtime.pid;
		const bootstrapPath = runtime.bootstrapPath;
		const exit = await runtime.shutdown("test complete");
		assert.deepEqual(exit, { exitCode: 0, signal: 0 });
		await waitUntil(() => lifecycle.includes("session.shutdown"));
		assert.throws(() => process.kill(pid, 0), hasProcessCode("ESRCH"));
		await assert.rejects(lstat(bootstrapPath), hasFsCode("ENOENT"));
	} finally {
		await runtime?.dispose();
	}
});

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
