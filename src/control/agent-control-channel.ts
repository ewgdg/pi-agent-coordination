import {
	type Static,
	type TSchema,
} from "typebox";
import { Check } from "typebox/value";

import { SerialLane } from "../runtime/serial-lane.ts";
import type { ControlTransport } from "./control-transport.ts";

export const AGENT_CONTROL_PROTOCOL_VERSION = 1 as const;
const DEFAULT_MAXIMUM_CONTROL_FRAME_BYTES = 1024 * 1024;

type ControlDefinition = Readonly<{
	request: TSchema;
	response: TSchema;
}>;

type EventDefinition = Readonly<{
	payload: TSchema;
}>;

export type AgentControlProtocol = Readonly<{
	methods: Readonly<Record<string, ControlDefinition>>;
	events: Readonly<Record<string, EventDefinition>>;
}>;

export type AgentControlIdentity = Readonly<{
	protocolVersion: typeof AGENT_CONTROL_PROTOCOL_VERSION;
	workflowId: string;
	agentId: string;
}>;

type MethodName<P extends AgentControlProtocol> = keyof P["methods"] & string;
type MethodRequest<
	P extends AgentControlProtocol,
	M extends MethodName<P>,
> = Static<P["methods"][M]["request"]>;
type MethodResponse<
	P extends AgentControlProtocol,
	M extends MethodName<P>,
> = Static<P["methods"][M]["response"]>;

type ControlRequest<P extends AgentControlProtocol> = {
	[M in MethodName<P>]: Readonly<{
		method: M;
		payload: MethodRequest<P, M>;
	}>;
}[MethodName<P>];

type RequestHandler<P extends AgentControlProtocol> = (
	request: ControlRequest<P>,
) => Promise<unknown> | unknown;

type PendingRequest = Readonly<{
	method: string;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
}>;

type RequestFrame = AgentControlIdentity & Readonly<{
	type: "request";
	requestId: string;
	method: string;
	payload: unknown;
}>;

type ResponseFrame = AgentControlIdentity & Readonly<{
	type: "response";
	requestId: string;
	ok: boolean;
	result?: unknown;
	error?: Readonly<{
		code: string;
		message: string;
	}>;
}>;

type ControlFrame = RequestFrame | ResponseFrame;

export class FramedAgentControlChannel<
	P extends AgentControlProtocol,
> {
	readonly #identity: AgentControlIdentity;
	readonly #maximumFrameBytes: number;
	readonly #protocol: P;
	readonly #transport: ControlTransport;
	readonly #writer = new SerialLane();
	readonly #decoder = new TextDecoder();
	readonly #pending = new Map<string, PendingRequest>();
	#buffer = "";
	#closed = false;
	#nextRequestSequence = 0;
	#requestHandler: RequestHandler<P> | undefined;
	#unsubscribeData: (() => void) | undefined;
	#unsubscribeClose: (() => void) | undefined;

	constructor(options: {
		identity: AgentControlIdentity;
		protocol: P;
		transport: ControlTransport;
		maximumFrameBytes?: number;
	}) {
		this.#identity = options.identity;
		this.#protocol = options.protocol;
		this.#transport = options.transport;
		this.#maximumFrameBytes =
			options.maximumFrameBytes ?? DEFAULT_MAXIMUM_CONTROL_FRAME_BYTES;
		this.#unsubscribeData = this.#transport.onData((chunk) => {
			void this.#receive(chunk);
		});
		this.#unsubscribeClose = this.#transport.onClose((cause) => {
			this.#finishClose(cause ?? new Error("control_channel_closed: transport closed"));
		});
	}

	onRequest(handler: RequestHandler<P>): () => void {
		if (this.#requestHandler) {
			throw new Error("control_channel_handler_exists: request handler already registered");
		}
		this.#requestHandler = handler;
		return () => {
			if (this.#requestHandler === handler) this.#requestHandler = undefined;
		};
	}

	async request<M extends MethodName<P>>(
		method: M,
		payload: MethodRequest<P, M>,
	): Promise<MethodResponse<P, M>> {
		this.#assertOpen();
		const definition = this.#protocol.methods[method];
		if (!definition || !Check(definition.request, payload)) {
			throw new Error(`control_channel_invalid_request: ${method}`);
		}
		const requestId = `${this.#identity.agentId}:${++this.#nextRequestSequence}`;
		const result = new Promise<unknown>((resolve, reject) => {
			this.#pending.set(requestId, { method, resolve, reject });
		});
		try {
			await this.#send({
				...this.#identity,
				type: "request",
				requestId,
				method,
				payload,
			});
		} catch (error) {
			this.#pending.delete(requestId);
			throw error;
		}
		return await result as MethodResponse<P, M>;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#finishClose(new Error("control_channel_closed: channel closed"));
		await this.#transport.close();
	}

	async #receive(chunk: Uint8Array): Promise<void> {
		if (this.#closed) return;
		try {
			this.#buffer += this.#decoder.decode(chunk, { stream: true });
			if (Buffer.byteLength(this.#buffer) > this.#maximumFrameBytes) {
				throw new Error("control_channel_frame_too_large: unterminated frame exceeds limit");
			}
			for (;;) {
				const newline = this.#buffer.indexOf("\n");
				if (newline < 0) return;
				const line = this.#buffer.slice(0, newline);
				this.#buffer = this.#buffer.slice(newline + 1);
				if (Buffer.byteLength(line) > this.#maximumFrameBytes) {
					throw new Error("control_channel_frame_too_large: frame exceeds limit");
				}
				if (line.length === 0) {
					throw new Error("control_channel_malformed_frame: empty frame");
				}
				await this.#handleFrame(this.#parseFrame(line));
			}
		} catch (error) {
			const cause = error instanceof Error
				? error
				: new Error("control_channel_protocol_error: unknown receive failure");
			this.#finishClose(cause);
			await this.#transport.close();
		}
	}

	#parseFrame(line: string): ControlFrame {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error("control_channel_malformed_frame: invalid JSON");
		}
		if (!isRecord(value)) {
			throw new Error("control_channel_malformed_frame: frame must be an object");
		}
		this.#assertIdentity(value);
		if (value.type === "request") {
			if (
				typeof value.requestId !== "string"
				|| typeof value.method !== "string"
				|| !("payload" in value)
			) {
				throw new Error("control_channel_malformed_frame: invalid request frame");
			}
			return value as RequestFrame;
		}
		if (value.type === "response") {
			if (typeof value.requestId !== "string" || typeof value.ok !== "boolean") {
				throw new Error("control_channel_malformed_frame: invalid response frame");
			}
			return value as ResponseFrame;
		}
		throw new Error("control_channel_unknown_frame: unsupported frame type");
	}

	async #handleFrame(frame: ControlFrame): Promise<void> {
		if (frame.type === "request") {
			await this.#handleRequest(frame);
			return;
		}
		this.#handleResponse(frame);
	}

	async #handleRequest(frame: RequestFrame): Promise<void> {
		const definition = this.#protocol.methods[frame.method];
		if (!definition || !Check(definition.request, frame.payload)) {
			throw new Error(`control_channel_invalid_request: ${frame.method}`);
		}
		if (!this.#requestHandler) {
			await this.#sendError(frame.requestId, "handler_unavailable", "No request handler is registered");
			return;
		}
		try {
			const result = await this.#requestHandler({
				method: frame.method,
				payload: frame.payload,
			} as ControlRequest<P>);
			if (!Check(definition.response, result)) {
				throw new Error(`control_channel_invalid_response: ${frame.method}`);
			}
			await this.#send({
				...this.#identity,
				type: "response",
				requestId: frame.requestId,
				ok: true,
				result,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Request handler failed";
			await this.#sendError(frame.requestId, "request_failed", message);
		}
	}

	#handleResponse(frame: ResponseFrame): void {
		const pending = this.#pending.get(frame.requestId);
		if (!pending) {
			throw new Error(`control_channel_unknown_response: ${frame.requestId}`);
		}
		this.#pending.delete(frame.requestId);
		if (!frame.ok) {
			pending.reject(new Error(
				`${frame.error?.code ?? "request_failed"}: ${frame.error?.message ?? "Remote request failed"}`,
			));
			return;
		}
		const definition = this.#protocol.methods[pending.method];
		if (!definition || !Check(definition.response, frame.result)) {
			pending.reject(new Error(`control_channel_invalid_response: ${pending.method}`));
			return;
		}
		pending.resolve(frame.result);
	}

	async #sendError(requestId: string, code: string, message: string): Promise<void> {
		await this.#send({
			...this.#identity,
			type: "response",
			requestId,
			ok: false,
			error: { code, message },
		});
	}

	async #send(frame: ControlFrame): Promise<void> {
		this.#assertOpen();
		const bytes = new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
		if (bytes.byteLength > this.#maximumFrameBytes) {
			throw new Error("control_channel_frame_too_large: outgoing frame exceeds limit");
		}
		await this.#writer.run(() => this.#transport.write(bytes));
	}

	#assertIdentity(frame: Record<string, unknown>): void {
		if (
			frame.protocolVersion !== this.#identity.protocolVersion
			|| frame.workflowId !== this.#identity.workflowId
			|| frame.agentId !== this.#identity.agentId
		) {
			throw new Error("control_channel_identity_mismatch: frame identity is not admitted");
		}
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new Error("control_channel_closed: channel is closed");
		}
	}

	#finishClose(cause: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribeData?.();
		this.#unsubscribeClose?.();
		this.#unsubscribeData = undefined;
		this.#unsubscribeClose = undefined;
		for (const pending of this.#pending.values()) pending.reject(cause);
		this.#pending.clear();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
