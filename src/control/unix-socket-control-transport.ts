import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	rmdir,
	unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createConnection } from "node:net";

import type { ControlTransport } from "./control-transport.ts";
import {
	type UnixControlEndpoint,
	validateControlEndpoint,
} from "./control-protocol-schemas.ts";
import {
	connectNodeIpcControlTransport,
	listenNodeIpcControlEndpoint,
	type NodeIpcControlListener,
} from "./node-ipc-control-transport.ts";

// macOS sockaddr_un is shorter than Linux's; this limit keeps descriptors portable.
export const MAXIMUM_UNIX_SOCKET_PATH_BYTES = 100;
const STALE_SOCKET_PROBE_MILLISECONDS = 250;

export interface UnixControlListener extends NodeIpcControlListener<UnixControlEndpoint> {
	readonly endpoint: UnixControlEndpoint;
}

export type CreateUnixControlListenerOptions = Readonly<{
	workflowId: string;
	runtimeDirectory?: string;
}>;

export async function createUnixControlListener(
	options: CreateUnixControlListenerOptions,
): Promise<UnixControlListener> {
	if (options.workflowId.length === 0) {
		throw new Error("control_endpoint_invalid: workflowId is required");
	}
	const runtimeDirectory = options.runtimeDirectory
		?? process.env.XDG_RUNTIME_DIR
		?? tmpdir();
	if (!isAbsolute(runtimeDirectory)) {
		throw new Error("control_endpoint_invalid: runtime directory must be absolute");
	}
	await mkdir(runtimeDirectory, { recursive: true });
	const workflowHash = createHash("sha256").update(options.workflowId).digest("hex").slice(0, 10);
	const ownedDirectory = await mkdtemp(join(runtimeDirectory, `pi-ac-${workflowHash}-`));
	await chmod(ownedDirectory, 0o700);
	const endpoint = { transport: "unix", address: join(ownedDirectory, "c.sock") } as const;
	try {
		assertUnixSocketPath(endpoint.address);
		return await listenUnixControlEndpoint(endpoint, { ownedDirectory });
	} catch (error) {
		const primary = asError(error);
		const errors = [primary];
		try {
			await cleanupUnixEndpoint(endpoint.address, ownedDirectory);
		} catch (cleanupError) {
			if (!containsError(cleanupError, primary)) errors.push(asError(cleanupError));
		}
		throwCleanupErrors(errors);
		throw primary;
	}
}

export async function listenUnixControlEndpoint(
	endpointValue: UnixControlEndpoint,
	options: Readonly<{ ownedDirectory?: string }> = {},
): Promise<UnixControlListener> {
	const endpoint = validateControlEndpoint(endpointValue);
	if (endpoint.transport !== "unix") {
		throw new Error("control_endpoint_invalid: expected a Unix endpoint");
	}
	assertUnixSocketPath(endpoint.address);
	await removeStaleUnixSocket(endpoint.address);
	const listener = await listenNodeIpcControlEndpoint({
		endpoint,
		address: endpoint.address,
		cleanupEndpoint: () => cleanupUnixEndpoint(endpoint.address, options.ownedDirectory),
	}) as UnixControlListener;
	try {
		await chmod(endpoint.address, 0o600);
		return listener;
	} catch (error) {
		const primary = asError(error);
		try {
			await listener.close();
		} catch (cleanupError) {
			throw combinePrimaryAndCleanup(primary, asError(cleanupError));
		}
		throw primary;
	}
}

export async function connectUnixControlTransport(
	endpointValue: UnixControlEndpoint,
): Promise<ControlTransport> {
	const endpoint = validateControlEndpoint(endpointValue);
	if (endpoint.transport !== "unix") {
		throw new Error("control_endpoint_invalid: expected a Unix endpoint");
	}
	assertUnixSocketPath(endpoint.address);
	return await connectNodeIpcControlTransport(endpoint.address);
}

export function assertUnixSocketPath(address: string): void {
	if (!isAbsolute(address)) {
		throw new Error("control_endpoint_invalid: Unix socket address must be absolute");
	}
	const bytes = Buffer.byteLength(address);
	if (bytes > MAXIMUM_UNIX_SOCKET_PATH_BYTES) {
		throw new Error(
			`control_endpoint_path_too_long: Unix socket path is ${bytes} bytes; maximum is ${MAXIMUM_UNIX_SOCKET_PATH_BYTES}`,
		);
	}
}

async function removeStaleUnixSocket(address: string): Promise<void> {
	let stats;
	try {
		stats = await lstat(address);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return;
		throw error;
	}
	if (!stats.isSocket()) {
		throw new Error("control_endpoint_occupied: endpoint path exists and is not a socket");
	}
	if (await socketAcceptsConnections(address)) {
		throw new Error("control_endpoint_in_use: Unix socket already accepts connections");
	}
	await unlink(address);
}

async function socketAcceptsConnections(address: string): Promise<boolean> {
	return await new Promise<boolean>((resolve, reject) => {
		const socket = createConnection(address);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("control_endpoint_probe_timeout: existing Unix socket did not respond"));
		}, STALE_SOCKET_PROBE_MILLISECONDS);
		const finish = (result: boolean) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
				finish(false);
				return;
			}
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function cleanupUnixEndpoint(address: string, ownedDirectory?: string): Promise<void> {
	const errors: Error[] = [];
	try {
		await unlinkIfExists(address);
	} catch (error) {
		errors.push(asError(error));
	}
	if (ownedDirectory) {
		try {
			await removeEmptyDirectory(ownedDirectory);
		} catch (error) {
			errors.push(asError(error));
		}
	}
	throwCleanupErrors(errors);
}

async function unlinkIfExists(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

async function removeEmptyDirectory(path: string): Promise<void> {
	try {
		await rmdir(path);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}

function containsError(error: unknown, candidate: Error): boolean {
	return error === candidate
		|| (error instanceof AggregateError && error.errors.includes(candidate));
}

function throwCleanupErrors(errors: readonly Error[]): void {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "control_listener_cleanup_failed");
}

function combinePrimaryAndCleanup(primary: Error, cleanup: Error): Error {
	if (cleanup === primary) return primary;
	if (cleanup instanceof AggregateError && cleanup.errors.includes(primary)) return cleanup;
	return new AggregateError([primary, cleanup], "control_listener_cleanup_failed");
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
