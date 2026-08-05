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
import { adoptOrValidateOwnerIdentity } from "../protocol/owner-identity.ts";
import { HumanRequestSurface } from "../presentation/human-request-surface.ts";
import { bindHumanSessionSelection } from "../pi-integration/interactive-session-selection.ts";
import {
	WorkflowPolicyStore,
	readWorkflowPolicy,
} from "../policy/workflow-policy.ts";
import {
	bindHiddenOwnerAgentExtension,
	createAgentBoundExtension,
} from "./agent-extension.ts";
import { discoverColdWorkflow } from "./cold-host-discovery.ts";

type InitializedWorkflow = {
	coordinator: WorkflowCoordinator;
	policy: WorkflowPolicyStore;
	prepareOwnerFork(): Promise<void>;
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
}): Promise<void> {
	const { pi, ctx, bridge, entryModulePath, bootstrapHandler, event } = options;
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
		bindHiddenOwnerAgentExtension({
			pi,
			runtime,
			bootstrapHandler,
			resolveView: () => existing.coordinator.forAgent(runtime.session.sessionId),
			prepareOwnerFork: existing.prepareOwnerFork,
		});
		return;
	}

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
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		workflowPolicy: policy,
		recoveredWorkflow,
	});
	const restoreNativeDispose = bindExactlyOnceShutdown(runtime, coordinator);
	let ownerForkPreparation: Promise<void> | undefined;
	const prepareOwnerFork = () => {
		if (ownerForkPreparation) return ownerForkPreparation;
		// Pi replaces the AgentSession without calling the intercepted runtime
		// disposer. Restore it before the new Workflow installs its own wrapper.
		restoreNativeDispose();
		ownerForkPreparation = coordinator.shutdown(async () => undefined);
		return ownerForkPreparation;
	};
	try {
		bindHiddenOwnerAgentExtension({
			pi,
			runtime,
			bootstrapHandler,
			resolveView: () => coordinator.forAgent(identity.agentId),
			prepareOwnerFork,
		});
		initializedWorkflows.set(runtime.session, {
			coordinator,
			policy,
			prepareOwnerFork,
		});
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
