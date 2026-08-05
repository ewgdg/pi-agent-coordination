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
import {
	bindHiddenOwnerAgentExtension,
	createAgentBoundExtension,
} from "./agent-extension.ts";

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
	bootstrapHandler: ExtensionHandler<SessionStartEvent>;
}): Promise<void> {
	const { pi, ctx, bridge, entryModulePath, bootstrapHandler } = options;
	const runtime = await bridge.captureRuntime(
		ctx.sessionManager as AgentSession["sessionManager"],
	);
	const existing = initializedWorkflows.get(runtime.session);
	if (existing) {
		bindHiddenOwnerAgentExtension({
			pi,
			runtime,
			bootstrapHandler,
			resolveView: () => existing.coordinator.forAgent(runtime.session.sessionId),
		});
		return;
	}

	const identity = adoptOrValidateOwnerIdentity(runtime, entryModulePath);
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(runtime, identity, {
		entryModulePath,
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
	});
	const restoreNativeDispose = bindExactlyOnceShutdown(runtime, coordinator);
	try {
		bindHiddenOwnerAgentExtension({
			pi,
			runtime,
			bootstrapHandler,
			resolveView: () => coordinator.forAgent(identity.agentId),
		});
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
