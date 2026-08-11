import type { ControlTransport } from "./control-transport.ts";
import type { ControlEndpoint } from "./control-protocol-schemas.ts";
import {
	connectUnixControlTransport,
	createUnixControlListener,
	type CreateUnixControlListenerOptions,
	type UnixControlListener,
} from "./unix-socket-control-transport.ts";

const UNIX_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
	"aix",
	"darwin",
	"freebsd",
	"linux",
	"openbsd",
	"sunos",
]);

/** Platform-neutral listener contract consumed by future process-host code. */
export interface ControlTransportListener {
	readonly endpoint: ControlEndpoint;
	accept(signal?: AbortSignal): Promise<ControlTransport>;
	close(): Promise<void>;
}

export function admitControlTransportPlatform(
	platform: NodeJS.Platform = process.platform,
): "unix" {
	if (!UNIX_PLATFORMS.has(platform)) {
		throw new Error(
			`control_transport_unsupported_platform: ${platform} has no Control Transport Adapter`,
		);
	}
	return "unix";
}

export async function createPlatformControlListener(
	options: CreateUnixControlListenerOptions & Readonly<{ platform?: NodeJS.Platform }>,
): Promise<ControlTransportListener> {
	admitControlTransportPlatform(options.platform);
	return await createUnixControlListener(options) as UnixControlListener;
}

export async function connectControlTransport(
	endpoint: ControlEndpoint,
	options: Readonly<{ platform?: NodeJS.Platform }> = {},
): Promise<ControlTransport> {
	admitControlTransportPlatform(options.platform);
	switch (endpoint.transport) {
		case "unix": return await connectUnixControlTransport(endpoint);
	}
}
