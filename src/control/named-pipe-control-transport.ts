import { createHash, randomBytes } from "node:crypto";

import type { ControlTransport } from "./control-transport.ts";
import {
	type NamedPipeControlEndpoint,
	validateControlEndpoint,
} from "./control-protocol-schemas.ts";
import {
	connectNodeIpcControlTransport,
	listenNodeIpcControlEndpoint,
	type NodeIpcControlListener,
} from "./node-ipc-control-transport.ts";

const NAMED_PIPE_PREFIX = "\\\\.\\pipe\\";
export const MAXIMUM_NAMED_PIPE_ADDRESS_LENGTH = 256;

export interface NamedPipeControlListener
	extends NodeIpcControlListener<NamedPipeControlEndpoint> {
	readonly endpoint: NamedPipeControlEndpoint;
}

export type CreateNamedPipeControlListenerOptions = Readonly<{
	workflowId: string;
}>;

export function createNamedPipeAddress(workflowId: string): string {
	if (workflowId.length === 0) {
		throw new Error("control_endpoint_invalid: workflowId is required");
	}
	const workflowHash = createHash("sha256").update(workflowId).digest("hex").slice(0, 10);
	// Randomness makes the owner-scoped pipe impractical to guess and avoids any
	// stale-name or concurrent-Workflow collision without exposing raw identity.
	const nonce = randomBytes(16).toString("hex");
	const address = `${NAMED_PIPE_PREFIX}pi-ac-${workflowHash}-${nonce}`;
	assertNamedPipeAddress(address);
	return address;
}

export async function createNamedPipeControlListener(
	options: CreateNamedPipeControlListenerOptions,
): Promise<NamedPipeControlListener> {
	return await listenNamedPipeControlEndpoint({
		transport: "named-pipe",
		address: createNamedPipeAddress(options.workflowId),
	});
}

export async function listenNamedPipeControlEndpoint(
	endpointValue: NamedPipeControlEndpoint,
): Promise<NamedPipeControlListener> {
	const endpoint = validateControlEndpoint(endpointValue);
	if (endpoint.transport !== "named-pipe") {
		throw new Error("control_endpoint_invalid: expected a named-pipe endpoint");
	}
	assertNamedPipeAddress(endpoint.address);
	return await listenNodeIpcControlEndpoint({
		endpoint,
		address: endpoint.address,
		// Node defaults both flags to false. Keep that owner-scoped access explicit
		// because broad pipe access would bypass the one-shot admission intention.
		readableAll: false,
		writableAll: false,
	}) as NamedPipeControlListener;
}

export async function connectNamedPipeControlTransport(
	endpointValue: NamedPipeControlEndpoint,
): Promise<ControlTransport> {
	const endpoint = validateControlEndpoint(endpointValue);
	if (endpoint.transport !== "named-pipe") {
		throw new Error("control_endpoint_invalid: expected a named-pipe endpoint");
	}
	assertNamedPipeAddress(endpoint.address);
	return await connectNodeIpcControlTransport(endpoint.address);
}

export function assertNamedPipeAddress(address: string): void {
	if (address.length > MAXIMUM_NAMED_PIPE_ADDRESS_LENGTH) {
		throw new Error(
			`control_endpoint_path_too_long: named-pipe address is ${address.length} characters; maximum is ${MAXIMUM_NAMED_PIPE_ADDRESS_LENGTH}`,
		);
	}
	if (!address.startsWith(NAMED_PIPE_PREFIX)) {
		throw new Error("control_endpoint_invalid: named-pipe address must use the \\\\.\\pipe\\ namespace");
	}
	const name = address.slice(NAMED_PIPE_PREFIX.length);
	// This package allocates every endpoint internally. A flat ASCII subset avoids
	// Win32 path normalization while retaining all names the allocator can emit.
	if (!/^[A-Za-z0-9_-]+$/.test(name)) {
		throw new Error("control_endpoint_invalid: named-pipe name must be one flat ASCII segment");
	}
}
