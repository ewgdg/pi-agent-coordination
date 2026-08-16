import type { ControlTransport, ControlTransportListener } from "./control-transport.ts";
import {
	type ControlEndpoint,
	validateControlEndpoint,
} from "./control-protocol-schemas.ts";
import {
	connectNamedPipeControlTransport,
	createNamedPipeControlListener,
} from "./named-pipe-control-transport.ts";
import {
	connectUnixControlTransport,
	createUnixControlListener,
} from "./unix-socket-control-transport.ts";

const UNIX_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
	"aix",
	"darwin",
	"freebsd",
	"linux",
	"openbsd",
	"sunos",
]);

export type ControlTransportKind = ControlEndpoint["transport"];
export type CreatePlatformControlListenerOptions = Readonly<{
	workflowId: string;
	runtimeDirectory?: string;
	platform?: NodeJS.Platform;
}>;

export type { ControlTransportListener } from "./control-transport.ts";

export function admitControlTransportPlatform(
	platform: NodeJS.Platform = process.platform,
): ControlTransportKind {
	if (platform === "win32") return "named-pipe";
	if (UNIX_PLATFORMS.has(platform)) return "unix";
	throw new Error(
		`control_transport_unsupported_platform: ${platform} has no Control Transport Adapter`,
	);
}

export async function createPlatformControlListener(
	options: CreatePlatformControlListenerOptions,
): Promise<ControlTransportListener> {
	const transport = admitControlTransportPlatform(options.platform);
	switch (transport) {
		case "unix":
			return await createUnixControlListener({
				workflowId: options.workflowId,
				...(options.runtimeDirectory === undefined
					? {}
					: { runtimeDirectory: options.runtimeDirectory }),
			});
		case "named-pipe":
			return await createNamedPipeControlListener({ workflowId: options.workflowId });
	}
}

export async function connectControlTransport(
	endpointValue: ControlEndpoint,
	options: Readonly<{ platform?: NodeJS.Platform }> = {},
): Promise<ControlTransport> {
	const endpoint = validateControlEndpoint(endpointValue);
	const platformTransport = admitControlTransportPlatform(options.platform);
	if (endpoint.transport !== platformTransport) {
		throw new Error(
			`control_endpoint_transport_mismatch: ${endpoint.transport} endpoint cannot be used by ${platformTransport} platform Adapter`,
		);
	}
	switch (endpoint.transport) {
		case "unix": return await connectUnixControlTransport(endpoint);
		case "named-pipe": return await connectNamedPipeControlTransport(endpoint);
	}
}
