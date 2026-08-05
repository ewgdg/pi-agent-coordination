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
	return (pi) => registerAgentBoundBehavior(pi, resolveView);
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
	registerAgentBoundBehavior(pi, resolveView);
}

function registerAgentBoundBehavior(
	pi: ExtensionAPI,
	resolveView: () => OrdinaryAgentCoordinatorView,
): void {
	registerOrdinaryAgentSurfaces(pi, resolveView);
	// message_end is Pi's final awaited hook before it synchronously publishes the
	// native result. A Run fence can still turn a submitted candidate into the one
	// interruption result here; attention remains until later transcript proof.
	pi.on("message_end", (event) => {
		const replacement = resolveView().guardHumanToolResult(event.message);
		if (!replacement) return;
		return { message: replacement };
	});
	// A previous sequential tool result is committed before Pi admits the next
	// sibling. Reconcile here so input-required attention cannot cross that barrier.
	pi.on("tool_execution_start", () => resolveView().reconcileHumanToolResults());
	// Pi awaits turn_end only after the complete issued tool batch and before it
	// constructs the next model context, making this the Steer freeze boundary.
	pi.on("turn_end", () => {
		resolveView().reconcileHumanToolResults();
		return resolveView().reachSafeBoundary();
	});
	// Aborted and failed turns may not reach turn_end. agent_end follows all native
	// message commits, so it safely reconciles their final Human result as well.
	pi.on("agent_end", () => resolveView().reconcileHumanToolResults());
}
