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
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net";

import { SerialLane } from "../runtime/serial-lane.ts";
import type { ControlTransport, ControlTransportListener } from "./control-transport.ts";
import {
	type UnixControlEndpoint,
	validateControlEndpoint,
} from "./control-protocol-schemas.ts";

// macOS sockaddr_un is shorter than Linux's; this limit keeps descriptors portable.
export const MAXIMUM_UNIX_SOCKET_PATH_BYTES = 100;
const STALE_SOCKET_PROBE_MILLISECONDS = 250;

export interface UnixControlListener extends ControlTransportListener {
	readonly endpoint: UnixControlEndpoint;
}

export type CreateUnixControlListenerOptions = Readonly<{
	workflowId: string;
	runtimeDirectory?: string;
}>;

type AcceptWaiter = {
	resolve: (transport: ControlTransport) => void;
	reject: (error: Error) => void;
	removeAbortListener: () => void;
};

/** A net.Socket Adapter that preserves write order and waits for drain. */
export class UnixSocketControlTransport implements ControlTransport {
	readonly #socket: Socket;
	readonly #writer = new SerialLane();
	readonly #dataHandlers = new Set<(chunk: Uint8Array) => void>();
	readonly #bufferedData: Uint8Array[] = [];
	readonly #closeHandlers = new Set<(cause?: Error) => void>();
	#closed = false;
	#closeCause: Error | undefined;

	constructor(socket: Socket) {
		this.#socket = socket;
		this.#socket.pause();
		this.#socket.on("data", (chunk: Buffer) => {
			const bytes = new Uint8Array(chunk).slice();
			if (this.#dataHandlers.size === 0) {
				this.#bufferedData.push(bytes);
				return;
			}
			this.#notifyData(bytes);
		});
		this.#socket.on("error", (error) => {
			this.#closeCause = error;
		});
		this.#socket.on("close", () => {
			this.#finishClose(this.#closeCause ?? new Error("control_transport_closed: Unix socket closed"));
		});
		// Read continuously so queued peers that exit are observable; bytes remain
		// transport-owned until a data subscriber is installed.
		this.#socket.resume();
	}

	write(data: Uint8Array): Promise<void> {
		return this.#writer.run(() => this.#writeOnce(data));
	}

	onData(handler: (chunk: Uint8Array) => void): () => void {
		if (this.#closed) return () => undefined;
		this.#dataHandlers.add(handler);
		for (const chunk of this.#bufferedData.splice(0)) this.#notifyData(chunk);
		return () => this.#dataHandlers.delete(handler);
	}

	onClose(handler: (cause?: Error) => void): () => void {
		if (this.#closed) {
			queueMicrotask(() => notifyCloseObserver(handler, this.#closeCause));
			return () => undefined;
		}
		this.#closeHandlers.add(handler);
		return () => this.#closeHandlers.delete(handler);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		const closed = new Promise<void>((resolve) => this.#socket.once("close", resolve));
		this.#socket.destroy();
		await closed;
	}

	async #writeOnce(data: Uint8Array): Promise<void> {
		if (this.#closed || this.#socket.destroyed || !this.#socket.writable) {
			throw this.#closeCause ?? new Error("control_transport_closed: Unix socket is not writable");
		}
		await new Promise<void>((resolve, reject) => {
			let callbackComplete = false;
			let drainComplete = true;
			let settled = false;
			const cleanup = () => {
				this.#socket.off("close", onClose);
				this.#socket.off("drain", onDrain);
			};
			const succeedIfComplete = () => {
				if (settled || !callbackComplete || !drainComplete) return;
				settled = true;
				cleanup();
				resolve();
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const onClose = () => fail(
				this.#closeCause ?? new Error("control_transport_closed: Unix socket closed during write"),
			);
			const onDrain = () => {
				drainComplete = true;
				succeedIfComplete();
			};
			this.#socket.once("close", onClose);
			const accepted = this.#socket.write(data, (error?: Error | null) => {
				if (error) {
					fail(error);
					return;
				}
				callbackComplete = true;
				succeedIfComplete();
			});
			if (!accepted) {
				drainComplete = false;
				this.#socket.once("drain", onDrain);
			}
		});
	}

	#notifyData(bytes: Uint8Array): void {
		for (const handler of this.#dataHandlers) {
			try {
				handler(bytes.slice());
			} catch {
				// Transport observers cannot disrupt socket lifecycle processing.
			}
		}
	}

	#finishClose(cause: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeCause = cause;
		const closeHandlers = [...this.#closeHandlers];
		this.#closeHandlers.clear();
		for (const handler of closeHandlers) notifyCloseObserver(handler, cause);
		this.#bufferedData.splice(0);
		this.#dataHandlers.clear();
	}
}

class NodeUnixControlListener implements UnixControlListener {
	readonly endpoint: UnixControlEndpoint;
	readonly #server: Server;
	readonly #ownedDirectory: string | undefined;
	readonly #queued: ControlTransport[] = [];
	readonly #connections = new Set<ControlTransport>();
	readonly #waiters: AcceptWaiter[] = [];
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(options: {
		endpoint: UnixControlEndpoint;
		server: Server;
		ownedDirectory?: string;
	}) {
		this.endpoint = options.endpoint;
		this.#server = options.server;
		this.#ownedDirectory = options.ownedDirectory;
		this.#server.on("connection", (socket) => this.#admit(socket));
		this.#server.on("error", (error) => this.#fail(error));
	}

	accept(signal?: AbortSignal): Promise<ControlTransport> {
		if (signal?.aborted) return Promise.reject(abortError());
		if (this.#closed) {
			return Promise.reject(new Error("control_listener_closed: listener is closed"));
		}
		const queued = this.#queued.shift();
		if (queued) return Promise.resolve(queued);
		return new Promise<ControlTransport>((resolve, reject) => {
			const waiter: AcceptWaiter = {
				resolve,
				reject,
				removeAbortListener: () => undefined,
			};
			const onAbort = () => {
				const index = this.#waiters.indexOf(waiter);
				if (index >= 0) this.#waiters.splice(index, 1);
				waiter.removeAbortListener();
				reject(abortError());
			};
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
				waiter.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
			}
			this.#waiters.push(waiter);
		});
	}

	close(): Promise<void> {
		return this.#shutdown();
	}

	#shutdown(primaryError?: Error): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		const waiterCause = primaryError ?? new Error("control_listener_closed: listener closed");
		for (const waiter of this.#waiters.splice(0)) {
			waiter.removeAbortListener();
			waiter.reject(waiterCause);
		}
		this.#queued.splice(0);
		const connections = [...this.#connections];
		this.#connections.clear();
		this.#closePromise = (async () => {
			const errors: Error[] = primaryError ? [primaryError] : [];
			// A listener owns every admitted socket, including connections already
			// accepted by a caller, so shutdown cannot wait forever on open peers.
			const connectionResults = await Promise.allSettled(
				connections.map((transport) => Promise.resolve().then(() => transport.close())),
			);
			for (const result of connectionResults) {
				if (result.status === "rejected") errors.push(asError(result.reason));
			}
			if (this.#server.listening) {
				try {
					await new Promise<void>((resolve, reject) => {
						this.#server.close((error) => error ? reject(error) : resolve());
					});
				} catch (error) {
					errors.push(asError(error));
				}
			}
			try {
				await unlinkIfExists(this.endpoint.address);
			} catch (error) {
				errors.push(asError(error));
			}
			if (this.#ownedDirectory) {
				try {
					await removeEmptyDirectory(this.#ownedDirectory);
				} catch (error) {
					errors.push(asError(error));
				}
			}
			throwCleanupErrors(errors);
		})();
		return this.#closePromise;
	}

	#admit(socket: Socket): void {
		const transport = new UnixSocketControlTransport(socket);
		this.#connections.add(transport);
		transport.onClose(() => {
			this.#connections.delete(transport);
			const queuedIndex = this.#queued.indexOf(transport);
			if (queuedIndex >= 0) this.#queued.splice(queuedIndex, 1);
		});
		if (this.#closed) {
			void transport.close();
			return;
		}
		const waiter = this.#waiters.shift();
		if (waiter) {
			waiter.removeAbortListener();
			waiter.resolve(transport);
			return;
		}
		this.#queued.push(transport);
	}

	#fail(error: Error): void {
		if (this.#closed) return;
		void this.#shutdown(error).catch(() => undefined);
	}
}

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
			await unlinkIfExists(endpoint.address);
		} catch (cleanupError) {
			errors.push(asError(cleanupError));
		}
		try {
			await removeEmptyDirectory(ownedDirectory);
		} catch (cleanupError) {
			errors.push(asError(cleanupError));
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
	const server = createServer({ pauseOnConnect: true });
	const listener = new NodeUnixControlListener({ endpoint, server, ...options });
	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(endpoint.address);
		});
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
	const socket = createConnection(endpoint.address);
	await new Promise<void>((resolve, reject) => {
		const onConnect = () => {
			socket.off("error", onError);
			resolve();
		};
		const onError = (error: Error) => {
			socket.off("connect", onConnect);
			reject(error);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
	return new UnixSocketControlTransport(socket);
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

function notifyCloseObserver(handler: (cause?: Error) => void, cause?: Error): void {
	try {
		handler(cause);
	} catch {
		// Observers cannot take ownership of socket cleanup or block one another.
	}
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

function abortError(): Error {
	return new DOMException("The listener accept was cancelled", "AbortError");
}
