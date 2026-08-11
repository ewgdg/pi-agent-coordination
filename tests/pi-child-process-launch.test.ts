import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	PiChildProcessRuntime,
	type PiChildProcessLaunch,
	type StartPiChildProcessRuntimeOptions,
} from "../src/process-runtime/pi-child-process-runtime.ts";
import {
	PROCESS_RUNTIME_TEST_MODEL,
	PROCESS_RUNTIME_TEST_PROVIDER,
} from "./fixtures/process-runtime-child-extension.ts";

const TEST_TIMEOUT_MS = 30_000;
const CHILD_EXTENSION = fileURLToPath(
	new URL("./fixtures/process-runtime-child-extension.ts", import.meta.url),
);

test("launch exposes the real startup PTY frame before runtime admission", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const options = await createLaunchOptions("startup-frame", 500);
	let launch: PiChildProcessLaunch | undefined;
	try {
		launch = await PiChildProcessRuntime.launch(options);
		const readiness = launch.ready();
		await waitForFrame(launch, "PROCESS_RUNTIME_CHILD_WIDGET");
		assert.equal(
			await Promise.race([
				readiness.then(() => "ready" as const),
				new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
			]),
			"pending",
		);

		const runtime = await readiness;
		assert.equal(runtime.pid, launch.pid);
		assert.deepEqual(runtime.ready, {
			sessionId: options.expectedSessionId,
			mode: "tui",
			hasUI: true,
		});
		assert.match(frameText(launch), /PROCESS_RUNTIME_CHILD_WIDGET/);
	} finally {
		await launch?.dispose();
	}
});

test("cancelling pending launch rejects exact readiness and bounds all startup cleanup", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const options = await createLaunchOptions("startup-cancel", 10_000);
	const launch = await PiChildProcessRuntime.launch(options);
	const readiness = launch.ready();
	void readiness.catch(() => undefined);
	await waitForFrame(launch, "PROCESS_RUNTIME_CHILD_WIDGET");
	const bootstrap = JSON.parse(await readFile(launch.bootstrapPath, "utf8")) as {
		endpoint: { transport: "unix"; address: string };
	};
	const pid = launch.pid;
	const cancellation = new Error("deterministic pending launch cancellation");

	const cleanup = launch.cancelInitialization(cancellation);
	assert.ok(cleanup);
	assert.equal(launch.cancelInitialization(new Error("too late")), undefined);
	await assert.rejects(readiness, (error) => error === cancellation);
	await cleanup;
	assert.equal(launch.disposed, true);
	assert.throws(() => process.kill(pid, 0), hasCode("ESRCH"));
	await assert.rejects(lstat(launch.bootstrapPath), hasCode("ENOENT"));
	await assert.rejects(lstat(bootstrap.endpoint.address), hasCode("ENOENT"));
	await launch.dispose();
});

async function createLaunchOptions(
	name: string,
	startupDelayMilliseconds: number,
): Promise<StartPiChildProcessRuntimeOptions> {
	const root = await mkdtemp(join(tmpdir(), `pi-child-launch-${name}-`));
	const cwd = join(root, "work");
	const sessionDirectory = join(root, "sessions");
	await mkdir(cwd, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const expectedSessionId = name === "startup-frame"
		? "019a6b4d-1b22-7000-8000-000000000101"
		: "019a6b4d-1b22-7000-8000-000000000102";
	const sessionPath = join(sessionDirectory, "child.jsonl");
	await writeFile(sessionPath, `${JSON.stringify({
		type: "session",
		version: 3,
		id: expectedSessionId,
		timestamp: new Date().toISOString(),
		cwd,
	})}\n`, { mode: 0o600 });
	return {
		workflowId: `process-launch-${name}-workflow`,
		agentId: `process-launch-${name}-agent`,
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
			PROCESS_RUNTIME_STARTUP_DELAY_MS: String(startupDelayMilliseconds),
		},
		runtimeDirectory: root,
		columns: 80,
		rows: 24,
	};
}

function frameText(projection: Pick<PiChildProcessLaunch, "frame">): string {
	return projection.frame().lines.map((line) => line.text).join("\n");
}

async function waitForFrame(
	projection: Pick<PiChildProcessLaunch, "frame" | "drain">,
	expected: string,
): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await projection.drain();
		if (frameText(projection as PiChildProcessLaunch).includes(expected)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for startup frame ${JSON.stringify(expected)}`);
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}
