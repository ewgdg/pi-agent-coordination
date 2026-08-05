import type {
	AgentSessionRuntime,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionHandler,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import type { OrdinaryAgentCoordinatorView } from "../coordination/workflow-coordinator.ts";
import { registerOrdinaryAgentSurfaces } from "../tools/owner-surfaces.ts";

export function createAgentBoundExtension(
	resolveView: () => OrdinaryAgentCoordinatorView,
): ExtensionFactory {
	return (pi) => registerOrdinaryAgentSurfaces(pi, resolveView);
}

export function bindHiddenOwnerAgentExtension(options: {
	pi: ExtensionAPI;
	runtime: AgentSessionRuntime;
	bootstrapHandler: ExtensionHandler<SessionStartEvent>;
	resolveView: () => OrdinaryAgentCoordinatorView;
}): void {
	const { pi, runtime, bootstrapHandler, resolveView } = options;
	const matchingExtensions = runtime.services.resourceLoader
		.getExtensions()
		.extensions.filter((extension) =>
			extension.handlers
				.get("session_start")
				?.some((handler) => handler === bootstrapHandler),
		);
	if (matchingExtensions.length !== 1) {
		throw new Error("Incompatible Pi host: cannot bind the Owner Agent extension");
	}

	// Pi loads package extensions publicly. Once this session is authenticated as
	// Owner, the same extension becomes its hidden identity-bound ordinary surface.
	matchingExtensions[0]!.hidden = true;
	registerOrdinaryAgentSurfaces(pi, resolveView);
}
