import type { ControlEndpoint } from "./control-protocol-schemas.ts";

export interface ControlTransport {
	write(data: Uint8Array): Promise<void>;
	onData(handler: (chunk: Uint8Array) => void): () => void;
	onClose(handler: (cause?: Error) => void): () => void;
	close(): Promise<void>;
}

/** Platform-neutral listener seam used by transport admission. */
export interface ControlTransportListener {
	readonly endpoint: ControlEndpoint;
	accept(signal?: AbortSignal): Promise<ControlTransport>;
	close(): Promise<void>;
}
