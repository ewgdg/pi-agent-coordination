import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net";

import { SerialLane } from "../runtime/serial-lane.ts";
import type { ControlEndpoint } from "./control-protocol-schemas.ts";
import type { ControlTransport, ControlTransportListener } from "./control-transport.ts";

const CONTROL_CONNECT_TIMEOUT_MILLISECONDS = 5_000;

type AcceptWaiter = {
	resolve: (transport: ControlTransport) => void;
	reject: (error: Error) => void;
	removeAbortListener: () => void;
};

/** Shared Node IPC Socket Adapter used by Unix sockets and Windows named pipes. */
export class NodeIpcControlTransport implements ControlTransport {
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
			this.#finishClose(this.#closeCause ?? new Error("control_transport_closed: IPC socket closed"));
		});
		// Observe peers that exit before acceptance while retaining their bytes until
		// the first data subscriber is installed.
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
			throw this.#closeCause ?? new Error("control_transport_closed: IPC socket is not writable");
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
				this.#closeCause ?? new Error("control_transport_closed: IPC socket closed during write"),
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

export interface NodeIpcControlListener<Endpoint extends ControlEndpoint>
	extends ControlTransportListener {
	readonly endpoint: Endpoint;
}

class NodeIpcControlListenerAdapter<Endpoint extends ControlEndpoint>
	implements NodeIpcControlListener<Endpoint> {
	readonly endpoint: Endpoint;
	readonly #server: Server;
	readonly #cleanupEndpoint: (() => Promise<void>) | undefined;
	readonly #queued: ControlTransport[] = [];
	readonly #connections = new Set<ControlTransport>();
	readonly #waiters: AcceptWaiter[] = [];
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(options: {
		endpoint: Endpoint;
		server: Server;
		cleanupEndpoint?: () => Promise<void>;
	}) {
		this.endpoint = options.endpoint;
		this.#server = options.server;
		this.#cleanupEndpoint = options.cleanupEndpoint;
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
			// The listener owns accepted and queued sockets, so server close cannot be
			// held open indefinitely by a peer.
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
			if (this.#cleanupEndpoint) {
				try {
					await this.#cleanupEndpoint();
				} catch (error) {
					errors.push(asError(error));
				}
			}
			throwCleanupErrors(errors);
		})();
		return this.#closePromise;
	}

	#admit(socket: Socket): void {
		const transport = new NodeIpcControlTransport(socket);
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

export async function listenNodeIpcControlEndpoint<Endpoint extends ControlEndpoint>(options: {
	endpoint: Endpoint;
	address: string;
	readableAll?: boolean;
	writableAll?: boolean;
	cleanupEndpoint?: () => Promise<void>;
}): Promise<NodeIpcControlListener<Endpoint>> {
	const server = createServer({ pauseOnConnect: true });
	const listener = new NodeIpcControlListenerAdapter({
		endpoint: options.endpoint,
		server,
		...(options.cleanupEndpoint === undefined
			? {}
			: { cleanupEndpoint: options.cleanupEndpoint }),
	});
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
			server.listen({
				path: options.address,
				...(options.readableAll === undefined ? {} : { readableAll: options.readableAll }),
				...(options.writableAll === undefined ? {} : { writableAll: options.writableAll }),
			});
		});
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

export async function connectNodeIpcControlTransport(address: string): Promise<ControlTransport> {
	const cancellation = new AbortController();
	const timeout = setTimeout(
		() => cancellation.abort(new Error("control_transport_connect_timeout")),
		CONTROL_CONNECT_TIMEOUT_MILLISECONDS,
	);
	const socket = createConnection({ path: address, signal: cancellation.signal });
	try {
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
		return new NodeIpcControlTransport(socket);
	} catch (error) {
		socket.destroy();
		if (cancellation.signal.aborted) {
			throw new Error(
				`control_transport_connect_timeout: IPC connection did not open within ${CONTROL_CONNECT_TIMEOUT_MILLISECONDS}ms`,
				{ cause: error },
			);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
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
