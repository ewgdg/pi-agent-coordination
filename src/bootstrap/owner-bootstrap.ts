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

type InitializedWorkflow = {
	coordinator: WorkflowCoordinator;
	policy: WorkflowPolicyStore;
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
		});
		return;
	}

	const initialPolicy = await readWorkflowPolicy(runtime.services.agentDir);
	if (!initialPolicy.ok) {
		runtime.services.diagnostics.push(initialPolicy.diagnostic);
		throw new Error(initialPolicy.diagnostic.message);
	}
	const policy = new WorkflowPolicyStore(initialPolicy.snapshot);
	const identity = adoptOrValidateOwnerIdentity(runtime, entryModulePath);
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(runtime, identity, {
		entryModulePath,
		humanSessionSelection: bindHumanSessionSelection(runtime, identity.agentId),
		humanRequestPresentation: new HumanRequestSurface(ctx.ui),
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		workflowPolicy: policy,
	});
	const restoreNativeDispose = bindExactlyOnceShutdown(runtime, coordinator);
	try {
		bindHiddenOwnerAgentExtension({
			pi,
			runtime,
			bootstrapHandler,
			resolveView: () => coordinator.forAgent(identity.agentId),
		});
		initializedWorkflows.set(runtime.session, { coordinator, policy });
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
