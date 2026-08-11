import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Type } from "typebox";

import {
	FramedAgentControlChannel,
	type AgentControlProtocol,
} from "../src/control/agent-control-channel.ts";
import {
	admitControlTransportPlatform,
	connectControlTransport,
	createPlatformControlListener,
} from "../src/control/control-platform.ts";
import {
	assertUnixSocketPath,
	connectUnixControlTransport,
	createUnixControlListener,
	listenUnixControlEndpoint,
	MAXIMUM_UNIX_SOCKET_PATH_BYTES,
} from "../src/control/unix-socket-control-transport.ts";

const unixOnly = process.platform === "win32" ? test.skip : test;
const protocol = {
	methods: {
		"test.echo": {
			request: Type.Object({ value: Type.String() }, { additionalProperties: false }),
			response: Type.Object({ value: Type.String() }, { additionalProperties: false }),
		},
	},
	events: {
		"test.changed": {
			payload: Type.Object({ value: Type.String() }, { additionalProperties: false }),
		},
	},
} as const satisfies AgentControlProtocol;
const identity = { protocolVersion: 1 as const, workflowId: "unix-workflow", agentId: "unix-agent" };

unixOnly("Unix listener allocates a short private endpoint and removes it on close", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-test-"));
	const listener = await createUnixControlListener({ workflowId: "a-workflow-id-that-can-be-long", runtimeDirectory: root });
	const directory = dirname(listener.endpoint.address);
	assert.ok(Buffer.byteLength(listener.endpoint.address) <= MAXIMUM_UNIX_SOCKET_PATH_BYTES);
	assert.equal((await stat(directory)).mode & 0o777, 0o700);
	assert.equal((await stat(listener.endpoint.address)).mode & 0o777, 0o600);
	await listener.close();
	await assert.rejects(lstat(listener.endpoint.address), hasFsCode("ENOENT"));
	await assert.rejects(lstat(directory), hasFsCode("ENOENT"));
	await rmdir(root);
});

unixOnly("Control Channel contract runs unchanged over connected Unix socket Adapters", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-contract-"));
	const listener = await createPlatformControlListener({ workflowId: "contract", runtimeDirectory: root });
	const accepted = listener.accept();
	const ownerTransport = await connectControlTransport(listener.endpoint);
	const childTransport = await accepted;
	const owner = new FramedAgentControlChannel({ identity, protocol, transport: ownerTransport });
	const child = new FramedAgentControlChannel({ identity, protocol, transport: childTransport });
	const events: string[] = [];
	child.onRequest(({ payload }) => ({ value: payload.value }));
	child.onEvent(({ payload }) => { events.push(payload.value); });

	assert.deepEqual(await owner.request("test.echo", { value: "socket🙂" }), { value: "socket🙂" });
	await Promise.all([
		owner.sendEvent("test.changed", { value: "one" }),
		owner.sendEvent("test.changed", { value: "two" }),
	]);
	await waitUntil(() => events.length === 2);
	assert.deepEqual(events, ["one", "two"]);
	await owner.close();
	await child.close();
	await listener.close();
	await rmdir(root);
});

unixOnly("Unix listener shutdown closes accepted sockets before closing the server", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-shutdown-"));
	const listener = await createUnixControlListener({ workflowId: "shutdown", runtimeDirectory: root });
	const accepted = listener.accept();
	const client = await connectUnixControlTransport(listener.endpoint);
	const serverSide = await accepted;
	const clientClosed = new Promise<void>((resolve) => client.onClose(() => resolve()));
	await listener.close();
	await clientClosed;
	await Promise.all([client.close(), serverSide.close()]);
	await rmdir(root);
});

unixOnly("Unix listener cleans a stale socket but refuses an active or non-socket endpoint", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-control-stale-"));
	const staleAddress = join(root, "stale.sock");
	await leaveStaleSocket(staleAddress);
	assert.equal((await lstat(staleAddress)).isSocket(), true);
	const staleListener = await listenUnixControlEndpoint({ transport: "unix", address: staleAddress });
	assert.equal((await lstat(staleAddress)).isSocket(), true);

	await assert.rejects(
		listenUnixControlEndpoint({ transport: "unix", address: staleAddress }),
		/control_endpoint_in_use/,
	);
	await staleListener.close();

	const occupiedAddress = join(root, "occupied.sock");
	const { writeFile, unlink } = await import("node:fs/promises");
	await writeFile(occupiedAddress, "not a socket");
	await assert.rejects(
		listenUnixControlEndpoint({ transport: "unix", address: occupiedAddress }),
		/control_endpoint_occupied/,
	);
	await unlink(occupiedAddress);
	await rmdir(root);
});

unixOnly("Unix connector fails clearly for path length and missing listeners", async () => {
	const tooLong = `/${"x".repeat(MAXIMUM_UNIX_SOCKET_PATH_BYTES)}`;
	assert.throws(() => assertUnixSocketPath(tooLong), /control_endpoint_path_too_long/);
	await assert.rejects(
		connectUnixControlTransport({ transport: "unix", address: join(tmpdir(), "definitely-missing-pi-control.sock") }),
		/ENOENT/,
	);
});

test("platform admission selects Unix internally and fails before allocation elsewhere", async () => {
	if (process.platform !== "win32") assert.equal(admitControlTransportPlatform(), "unix");
	assert.throws(
		() => admitControlTransportPlatform("win32"),
		/control_transport_unsupported_platform: win32/,
	);
	const neverCreated = join(tmpdir(), `pi-control-unsupported-${process.pid}-${Date.now()}`);
	await assert.rejects(
		createPlatformControlListener({
			workflowId: "unsupported",
			runtimeDirectory: neverCreated,
			platform: "win32",
		}),
		/control_transport_unsupported_platform/,
	);
	await assert.rejects(lstat(neverCreated), hasFsCode("ENOENT"));
});

async function leaveStaleSocket(address: string): Promise<void> {
	const script = [
		'import net from "node:net";',
		`const server = net.createServer();`,
		`server.listen(${JSON.stringify(address)}, () => process.stdout.write("ready\\n"));`,
		`setInterval(() => undefined, 1000);`,
	].join("\n");
	const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.stdout.once("data", () => resolve());
	});
	child.kill("SIGKILL");
	await once(child, "exit");
}

function hasFsCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}

async function waitUntil(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 100; attempts += 1) {
		if (condition()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error("condition was not reached");
}
