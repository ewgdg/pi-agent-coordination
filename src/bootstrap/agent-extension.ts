import type {
	AgentSessionRuntime,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionHandler,
	ExtensionUIContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import type {
	HumanPresentationCoordinatorView,
	ModeratorAgentCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "../coordination/workflow-coordinator.ts";
import {
	registerAgentsCommand,
	registerModeratorAgentSurfaces,
	registerOrdinaryAgentSurfaces,
} from "../tools/owner-surfaces.ts";
import {
	installAgentActivityDock,
	type AgentActivitySource,
} from "../presentation/agent-activity-surface.ts";

const CHILD_NATIVE_SESSION_REPLACEMENT_MESSAGE =
	"Return to Owner before replacing or forking the native session.";

export function createAgentBoundExtension(
	resolveView: () => OrdinaryAgentCoordinatorView,
): ExtensionFactory {
	return createParticipantBoundExtension(
		resolveView,
		registerOrdinaryAgentSurfaces,
	);
}

export function createModeratorBoundExtension(
	resolveView: () => ModeratorAgentCoordinatorView,
): ExtensionFactory {
	return createParticipantBoundExtension(
		resolveView,
		registerModeratorAgentSurfaces,
	);
}

export function createPresentationBoundExtension(
	resolveView: () => HumanPresentationCoordinatorView,
): ExtensionFactory {
	return (pi) => {
		registerChildNativeSessionPolicy(pi);
		registerAgentsCommand(pi, resolveView);
		registerAgentActivityDock(pi, resolveView);
		pi.on("input", async (event, ctx) => {
			if (event.source !== "interactive") return { action: "handled" };
			try {
				await resolveView().resumeFromHuman(event.text, event.images);
			} catch (error) {
				ctx.ui.notify(
					`Agent input failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			return { action: "handled" };
		});
	};
}

export function createAgentActivityExtension(
	resolveView: () => HumanPresentationCoordinatorView,
): ExtensionFactory {
	return (pi) => registerAgentActivityDock(pi, resolveView);
}

function createParticipantBoundExtension<
	View extends OrdinaryAgentCoordinatorView | ModeratorAgentCoordinatorView,
>(
	resolveView: () => View,
	registerSurfaces: (pi: ExtensionAPI, resolveView: () => View) => void,
): ExtensionFactory {
	return (pi) => {
		registerChildNativeSessionPolicy(pi);
		registerSurfaces(pi, resolveView);
		registerAgentBoundBehavior(pi, resolveView);
	};
}

function registerAgentActivityDock(
	pi: ExtensionAPI,
	resolveView: () => HumanPresentationCoordinatorView,
): void {
	pi.on("session_start", (_event, ctx) => {
		installResolvedAgentActivityDock(ctx.ui, resolveView);
	});
	// AgentSession publishes model changes only through the extension event path;
	// forward that native invalidation to every scoped activity subscriber.
	pi.on("model_select", () => resolveView().refreshAgentActivity());
}

export function installResolvedAgentActivityDock(
	ui: ExtensionUIContext,
	resolveView: () => HumanPresentationCoordinatorView,
): void {
	const source: AgentActivitySource = {
		snapshot: () => resolveView().agentActivity(),
		addChangeHandler: (handler) =>
			resolveView().addAgentActivityChangeHandler(handler),
	};
	installAgentActivityDock(ui, source);
}

function registerChildNativeSessionPolicy(pi: ExtensionAPI): void {
	pi.on("session_before_fork", (_event, ctx) =>
		cancelChildNativeSessionReplacement(ctx)
	);
	pi.on("session_before_switch", (_event, ctx) =>
		cancelChildNativeSessionReplacement(ctx)
	);
}

function cancelChildNativeSessionReplacement(
	ctx: ExtensionContext,
): { cancel: true } {
	ctx.ui.notify(CHILD_NATIVE_SESSION_REPLACEMENT_MESSAGE, "error");
	return { cancel: true };
}

export function bindHiddenOwnerAgentExtension(options: {
	pi: ExtensionAPI;
	runtime: AgentSessionRuntime;
	bootstrapHandler: ExtensionHandler<SessionStartEvent>;
	resolveView: () => OrdinaryAgentCoordinatorView;
	prepareOwnerReplacement: () => Promise<void>;
}): void {
	const {
		pi,
		runtime,
		bootstrapHandler,
		resolveView,
		prepareOwnerReplacement,
	} = options;
	const ownerExtension = requireOwnerAgentExtension(runtime, bootstrapHandler);

	// Pi loads package extensions publicly. Once this session is authenticated as
	// Owner, the same extension becomes its hidden identity-bound Owner surface.
	ownerExtension.hidden = true;
	registerAgentsCommand(pi, resolveView);
	registerAgentBoundBehavior(pi, resolveView);
	pi.on("session_shutdown", (event) => {
		if (
			event.reason === "fork" ||
			event.reason === "new" ||
			event.reason === "resume"
		) return prepareOwnerReplacement();
	});
}

export function assertOwnerAgentExtensionBindingReady(options: {
	runtime: AgentSessionRuntime;
	bootstrapHandler: ExtensionHandler<SessionStartEvent>;
}): void {
	requireOwnerAgentExtension(options.runtime, options.bootstrapHandler);
}

function requireOwnerAgentExtension(
	runtime: AgentSessionRuntime,
	bootstrapHandler: ExtensionHandler<SessionStartEvent>,
) {
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
	return matchingExtensions[0]!;
}

function registerAgentBoundBehavior(
	pi: ExtensionAPI,
	resolveView: () => OrdinaryAgentCoordinatorView | ModeratorAgentCoordinatorView,
): void {
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
				`Agent input failed: ${error instanceof Error ? error.message : String(error)}`,
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
	pi.on("tool_execution_start", async (event) => {
		resolveView().reconcileHumanToolResults();
		resolveView().reconcileCommittedToolResults();
		await resolveView().ensureExecution();
		resolveView().beginToolExecution(event.toolCallId, event.toolName);
	});
	// Pi awaits turn_end only after the complete issued tool batch and before it
	// constructs the next model context, making this the Steer freeze boundary.
	pi.on("turn_end", async () => {
		resolveView().reconcileHumanToolResults();
		resolveView().reconcileCommittedToolResults();
		await resolveView().ensureExecution();
		await resolveView().reachSafeBoundary();
	});
	// Aborted and failed turns may not reach turn_end. agent_end follows all native
	// message commits, so it safely reconciles their final Human result as well.
	pi.on("agent_end", () => {
		resolveView().reconcileCommittedToolResults();
		resolveView().endExecution();
		resolveView().reconcileHumanToolResults();
	});
}
