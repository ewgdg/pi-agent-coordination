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
	return (pi) => {
		pi.on("session_before_fork", () => ({ cancel: true }));
		registerAgentBoundBehavior(pi, resolveView);
	};
}

export function bindHiddenOwnerAgentExtension(options: {
	pi: ExtensionAPI;
	runtime: AgentSessionRuntime;
	bootstrapHandler: ExtensionHandler<SessionStartEvent>;
	resolveView: () => OrdinaryAgentCoordinatorView;
	prepareOwnerFork: () => Promise<void>;
}): void {
	const {
		pi,
		runtime,
		bootstrapHandler,
		resolveView,
		prepareOwnerFork,
	} = options;
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
	pi.on("session_shutdown", (event) => {
		if (event.reason === "fork") return prepareOwnerFork();
	});
}

function registerAgentBoundBehavior(
	pi: ExtensionAPI,
	resolveView: () => OrdinaryAgentCoordinatorView,
): void {
	registerOrdinaryAgentSurfaces(pi, resolveView);
	// agent_start is the one awaited Pi boundary shared by native prompts,
	// custom Delivery turns, queued continuations, and automatic retries.
	pi.on("agent_start", () => resolveView().beginExecution());
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		try {
			const resumed = await resolveView().resumeFromHuman(event.text, event.images);
			return resumed ? { action: "handled" } : { action: "continue" };
		} catch (error) {
			ctx.ui.notify(
				`Run resumption failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return { action: "handled" };
		}
	});
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
	pi.on("tool_execution_start", async () => {
		resolveView().reconcileHumanToolResults();
		await resolveView().ensureExecution();
	});
	// Pi awaits turn_end only after the complete issued tool batch and before it
	// constructs the next model context, making this the Steer freeze boundary.
	pi.on("turn_end", async () => {
		resolveView().reconcileHumanToolResults();
		await resolveView().ensureExecution();
		await resolveView().reachSafeBoundary();
	});
	// Aborted and failed turns may not reach turn_end. agent_end follows all native
	// message commits, so it safely reconciles their final Human result as well.
	pi.on("agent_end", () => {
		resolveView().endExecution();
		resolveView().reconcileHumanToolResults();
	});
}
