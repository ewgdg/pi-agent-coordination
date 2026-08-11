export interface ControlTransport {
	write(data: Uint8Array): Promise<void>;
	onData(handler: (chunk: Uint8Array) => void): () => void;
	onClose(handler: (cause?: Error) => void): () => void;
	close(): Promise<void>;
}
