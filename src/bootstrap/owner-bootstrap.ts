import type {
	AgentSession,
	AgentSessionRuntime,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { WorkflowCoordinator } from "../coordination/workflow-coordinator.ts";
import type { InteractiveHostBridge } from "../pi-integration/interactive-host-bridge.ts";
import { adoptOrValidateOwnerIdentity } from "../protocol/owner-identity.ts";
import { registerOwnerSurfaces } from "../tools/owner-surfaces.ts";

type InitializedWorkflow = {
	coordinator: WorkflowCoordinator;
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
}): Promise<void> {
	const { pi, ctx, bridge, entryModulePath } = options;
	const runtime = await bridge.captureRuntime(
		ctx.sessionManager as AgentSession["sessionManager"],
	);
	const existing = initializedWorkflows.get(runtime.session);
	if (existing) {
		registerOwnerSurfaces(pi, existing.coordinator.forAgent(runtime.session.sessionId));
		return;
	}

	const identity = adoptOrValidateOwnerIdentity(runtime, entryModulePath);
	const coordinator = new WorkflowCoordinator(runtime, identity);
	const restoreNativeDispose = bindExactlyOnceShutdown(runtime, coordinator);
	try {
		registerOwnerSurfaces(pi, coordinator.forAgent(identity.agentId));
		initializedWorkflows.set(runtime.session, { coordinator });
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
