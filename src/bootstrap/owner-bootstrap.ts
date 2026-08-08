import type {
	AgentSession,
	AgentSessionRuntime,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { WorkflowCoordinator } from "../coordination/workflow-coordinator.ts";
import type { InteractiveHostBridge } from "../pi-integration/interactive-host-bridge.ts";
import {
	openChildViewOverlay,
} from "../presentation/child-view-overlay.ts";
import { adoptOrValidateOwnerIdentity } from "../protocol/owner-identity.ts";
import { HumanRequestSurface } from "../presentation/human-request-surface.ts";
import { OperationalIncidentSurface } from "../presentation/operational-incident-surface.ts";
import { SelectedAgentStatusSurface } from "../presentation/selected-agent-status.ts";
import { bindHumanSessionSelection } from "../pi-integration/interactive-session-selection.ts";
import {
	WorkflowPolicyStore,
	readWorkflowPolicy,
} from "../policy/workflow-policy.ts";
import {
	assertOwnerAgentExtensionBindingReady,
	bindHiddenOwnerAgentExtension,
	createAgentBoundExtension,
	createModeratorBoundExtension,
} from "./agent-extension.ts";
import { discoverColdWorkflow } from "./cold-host-discovery.ts";

type InitializedWorkflow = {
	coordinator: WorkflowCoordinator;
	policy: WorkflowPolicyStore;
	prepareOwnerReplacement(): Promise<void>;
};

const WORKFLOW_REGISTRY_KEY = "__piAgentCoordinationOwnerWorkflows";
const globalWorkflowRegistry = globalThis as typeof globalThis & {
	[WORKFLOW_REGISTRY_KEY]?: WeakMap<AgentSession, InitializedWorkflow>;
};
// Resource reload re-registers surfaces but must keep one coordinator and one
// shutdown owner for the retained native session.
const initializedWorkflows = (globalWorkflowRegistry[WORKFLOW_REGISTRY_KEY] ??= new WeakMap());

export async function initializeOwnerWorkflow(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	bridge: InteractiveHostBridge;
	entryModulePath: string;
	bootstrapHandler: ExtensionHandler<SessionStartEvent>;
	event: SessionStartEvent;
	hostModule: { InteractiveMode: { prototype: object } };
}): Promise<void> {
	const { pi, ctx, bridge, entryModulePath, bootstrapHandler, event, hostModule } = options;
	const hostPrototype = hostModule.InteractiveMode.prototype;
	const runtime = await bridge.captureRuntime(
		ctx.sessionManager as AgentSession["sessionManager"],
	);
	const existing = initializedWorkflows.get(runtime.session);
	if (existing) {
		if (event.reason === "reload") {
			const reloaded = await readWorkflowPolicy(runtime.services.agentDir);
			if (reloaded.ok) {
				existing.policy.publish(reloaded.snapshot);
			} else {
				runtime.services.diagnostics.push(reloaded.diagnostic);
			}
		}
		registerChildViewPrototypeCommand({
			pi,
			hostPrototype,
			coordinator: existing.coordinator,
		});
		bindHiddenOwnerAgentExtension({
			pi,
			runtime,
			bootstrapHandler,
			resolveView: () => existing.coordinator.forAgent(runtime.session.sessionId),
			prepareOwnerReplacement: existing.prepareOwnerReplacement,
		});
		return;
	}
	assertOwnerAgentExtensionBindingReady({ runtime, bootstrapHandler });

	const initialPolicy = await readWorkflowPolicy(runtime.services.agentDir);
	if (!initialPolicy.ok) {
		runtime.services.diagnostics.push(initialPolicy.diagnostic);
		throw new Error(initialPolicy.diagnostic.message);
	}
	const policy = new WorkflowPolicyStore(initialPolicy.snapshot);
	const identity = adoptOrValidateOwnerIdentity(runtime, entryModulePath, {
		allowCopiedCoordinationContext: event.reason === "fork",
	});
	const recoveredWorkflow = await discoverColdWorkflow({
		ownerIdentity: identity,
		ownerSessionManager: runtime.session.sessionManager,
	});
	if (recoveredWorkflow.quarantinedCandidateCount > 0) {
		ctx.ui.notify(
			`${recoveredWorkflow.quarantinedCandidateCount} Agent transcript candidate${recoveredWorkflow.quarantinedCandidateCount === 1 ? " was" : "s were"} quarantined; independently verified Agents remain available.`,
			"warning",
		);
	}
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(runtime, identity, {
		entryModulePath,
		humanSessionSelection: bindHumanSessionSelection(runtime, identity.agentId),
		humanRequestPresentation: new HumanRequestSurface(ctx.ui),
		operationalIncidentPresentation: new OperationalIncidentSurface(ctx.ui),
		selectedAgentStatusPresentation: new SelectedAgentStatusSurface(ctx.ui),
		childExtensionFactory: (agentId) => {
			const childExtension = createAgentBoundExtension(
				() => coordinator.forAgent(agentId),
			);
			return (childPi) => {
				childExtension(childPi);
				// PROTOTYPE (#62): the overlay command must also be reachable from a
				// selected child's native editor (the swap path rebinds the child's
				// UI context to the interactive TUI). Remove with the prototype.
				registerChildViewPrototypeCommand({
					pi: childPi,
					hostPrototype,
					coordinator,
				});
			};
		},
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator.forModerator(agentId)),
		workflowPolicy: policy,
		recoveredWorkflow,
	});
	const restoreNativeDispose = bindExactlyOnceShutdown(runtime, coordinator);
	let ownerReplacementPreparation: Promise<void> | undefined;
	const prepareOwnerReplacement = () => {
		if (ownerReplacementPreparation) return ownerReplacementPreparation;
		// Pi replaces the AgentSession without calling the intercepted runtime
		// disposer. Restore it before the new Workflow installs its own wrapper.
		restoreNativeDispose();
		ownerReplacementPreparation = coordinator.shutdown(async () => undefined);
		return ownerReplacementPreparation;
	};
	try {
		bindHiddenOwnerAgentExtension({
			pi,
			runtime,
			bootstrapHandler,
			resolveView: () => coordinator.forAgent(identity.agentId),
			prepareOwnerReplacement,
		});
		registerChildViewPrototypeCommand({
			pi,
			hostPrototype,
			coordinator,
		});
		initializedWorkflows.set(runtime.session, {
			coordinator,
			policy,
			prepareOwnerReplacement,
		});
	} catch (error) {
		restoreNativeDispose();
		throw error;
	}
}

// PROTOTYPE (#62): `/child-view` opens the full-window overlay for the child
// the Owner currently has selected. Throwaway trigger for the overlay
// validation; remove with the prototype.
function registerChildViewPrototypeCommand(options: {
	pi: ExtensionAPI;
	hostPrototype: object;
	coordinator: WorkflowCoordinator;
}): void {
	const { pi, hostPrototype, coordinator } = options;
	pi.registerCommand("child-view", {
		description: "[prototype] open the full-window overlay for the selected child Agent",
		handler: async (_args, commandCtx) => {
			if (commandCtx.mode !== "tui" || !commandCtx.hasUI) return;
			const session = coordinator.prototypeSelectedChildSession();
			if (!session) {
				commandCtx.ui.notify(
					"[child-view] select a live child Agent first",
					"warning",
				);
				return;
			}
			await openChildViewOverlay({
				prototype: hostPrototype,
				ui: commandCtx.ui,
				session,
				agentLabel: session.sessionManager.getSessionId(),
			});
		},
	});
}

function bindExactlyOnceShutdown(
	runtime: AgentSessionRuntime,
	coordinator: WorkflowCoordinator,
): () => void {
	const nativeDispose = runtime.dispose.bind(runtime);
	const coordinatedDispose = () => coordinator.shutdown(nativeDispose);
	runtime.dispose = coordinatedDispose;
	return () => {
		if (runtime.dispose === coordinatedDispose) runtime.dispose = nativeDispose;
	};
}
