import type { ControlTransport } from "./control-transport.ts";

class InMemoryControlTransport implements ControlTransport {
	#closed = false;
	#dataHandlers = new Set<(chunk: Uint8Array) => void>();
	#closeHandlers = new Set<(cause?: Error) => void>();
	#peer: InMemoryControlTransport | undefined;

	connect(peer: InMemoryControlTransport): void {
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
		peer.#receive(data.slice());
	}

	onData(handler: (chunk: Uint8Array) => void): () => void {
		this.#dataHandlers.add(handler);
		return () => this.#dataHandlers.delete(handler);
	}

	onClose(handler: (cause?: Error) => void): () => void {
		this.#closeHandlers.add(handler);
		return () => this.#closeHandlers.delete(handler);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#notifyClosed();
		const peer = this.#peer;
		if (peer) peer.#closeFromPeer();
	}

	#receive(data: Uint8Array): void {
		for (const handler of this.#dataHandlers) handler(data);
	}

	#closeFromPeer(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#notifyClosed();
	}

	#notifyClosed(): void {
		for (const handler of this.#closeHandlers) handler();
		this.#dataHandlers.clear();
		this.#closeHandlers.clear();
	}
}

export function createInMemoryControlTransportPair(): readonly [
	ControlTransport,
	ControlTransport,
] {
	const first = new InMemoryControlTransport();
	const second = new InMemoryControlTransport();
	first.connect(second);
	second.connect(first);
	return [first, second];
}
