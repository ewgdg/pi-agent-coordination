import type { ControlTransport } from "./control-transport.ts";

export type InMemoryControlTransportOptions = Readonly<{
	/** Repeating deterministic byte lengths used to fragment every write. */
	fragmentSizes?: readonly number[];
}>;

/** Deterministic byte-stream Adapter used by the complete channel contract suite. */
export class InMemoryControlTransport implements ControlTransport {
	readonly #fragmentSizes: readonly number[];
	#closed = false;
	#dataHandlers = new Set<(chunk: Uint8Array) => void>();
	#closeHandlers = new Set<(cause?: Error) => void>();
	#peer: InMemoryControlTransport | undefined;

	constructor(options: InMemoryControlTransportOptions = {}) {
		const fragmentSizes = options.fragmentSizes ?? [];
		if (!fragmentSizes.every((size) => Number.isSafeInteger(size) && size > 0)) {
			throw new Error("control_transport_configuration: fragment sizes must be positive integers");
		}
		this.#fragmentSizes = [...fragmentSizes];
	}

	connect(peer: InMemoryControlTransport): void {
		if (this.#peer) throw new Error("control_transport_connected: transport already has a peer");
		this.#peer = peer;
	}

	async write(data: Uint8Array): Promise<void> {
		if (this.#closed) {
			throw new Error("control_transport_closed: cannot write to a closed transport");
		}
		const peer = this.#peer;
		if (!peer || peer.#closed) {
			throw new Error("control_transport_closed: peer is not available");
		}
		for (const chunk of fragment(data, this.#fragmentSizes)) peer.#receive(chunk);
	}

	onData(handler: (chunk: Uint8Array) => void): () => void {
		if (this.#closed) return () => undefined;
		this.#dataHandlers.add(handler);
		return () => this.#dataHandlers.delete(handler);
	}

	onClose(handler: (cause?: Error) => void): () => void {
		if (this.#closed) {
			queueMicrotask(() => handler(new Error("control_transport_closed: transport is closed")));
			return () => undefined;
		}
		this.#closeHandlers.add(handler);
		return () => this.#closeHandlers.delete(handler);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#notifyClosed(new Error("control_transport_closed: transport closed locally"));
		const peer = this.#peer;
		if (peer) peer.#closeFromPeer();
	}

	#receive(data: Uint8Array): void {
		if (this.#closed) return;
		for (const handler of this.#dataHandlers) handler(data.slice());
	}

	#closeFromPeer(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#notifyClosed(new Error("control_transport_closed: peer closed"));
	}

	#notifyClosed(cause: Error): void {
		for (const handler of this.#closeHandlers) handler(cause);
		this.#dataHandlers.clear();
		this.#closeHandlers.clear();
	}
}

export function createInMemoryControlTransportPair(
	options: InMemoryControlTransportOptions = {},
): readonly [InMemoryControlTransport, InMemoryControlTransport] {
	const first = new InMemoryControlTransport(options);
	const second = new InMemoryControlTransport(options);
	first.connect(second);
	second.connect(first);
	return [first, second];
}

function fragment(data: Uint8Array, sizes: readonly number[]): Uint8Array[] {
	if (sizes.length === 0 || data.byteLength === 0) return [data.slice()];
	const chunks: Uint8Array[] = [];
	let offset = 0;
	let sequence = 0;
	while (offset < data.byteLength) {
		const requested = sizes[sequence % sizes.length] as number;
		const end = Math.min(data.byteLength, offset + requested);
		chunks.push(data.slice(offset, end));
		offset = end;
		sequence += 1;
	}
	return chunks;
}
