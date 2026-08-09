import type {
	AgentSession,
	AgentSessionRuntime,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import {
	type OrdinaryAgentCoordinatorView,
	WorkflowCoordinator,
} from "../coordination/workflow-coordinator.ts";
import type { InteractiveHostBridge } from "../pi-integration/interactive-host-bridge.ts";
import { adoptOrValidateOwnerIdentity } from "../protocol/owner-identity.ts";
import { HumanRequestSurface } from "../presentation/human-request-surface.ts";
import { OperationalIncidentSurface } from "../presentation/operational-incident-surface.ts";
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
}): Promise<() => OrdinaryAgentCoordinatorView> {
	const { pi, ctx, bridge, entryModulePath, bootstrapHandler, event } = options;
	const { runtime, projectionHost } = await bridge.capture(
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
		const resolveView = () => existing.coordinator.forAgent(runtime.session.sessionId);
		bindHiddenOwnerAgentExtension({
			pi,
			runtime,
			bootstrapHandler,
			resolveView,
			prepareOwnerReplacement: existing.prepareOwnerReplacement,
		});
		return resolveView;
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
		humanRequestPresentation: new HumanRequestSurface(ctx.ui),
		operationalIncidentPresentation: new OperationalIncidentSurface(ctx.ui),
		projectionHost,
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
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
	const resolveView = () => coordinator.forAgent(identity.agentId);
	try {
		bindHiddenOwnerAgentExtension({
			pi,
			runtime,
			bootstrapHandler,
			resolveView,
			prepareOwnerReplacement,
		});
		initializedWorkflows.set(runtime.session, {
			coordinator,
			policy,
			prepareOwnerReplacement,
		});
		return resolveView;
	} catch (error) {
		restoreNativeDispose();
		throw error;
	}
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
