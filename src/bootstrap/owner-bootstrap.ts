import type {
	AgentSession,
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
import {
	installOwnerSettlementParker,
	type OwnerSettlementParkingBinding,
} from "../pi-integration/owner-settlement-parker.ts";
import { adoptOrValidateOwnerIdentity } from "../protocol/owner-identity.ts";
import { OperationalIncidentSurface } from "../presentation/operational-incident-surface.ts";
import { OwnerPostMortemAgentPresenter } from "../presentation/post-mortem-agent-view-surface.ts";
import {
	WorkflowPolicyStore,
	readWorkflowPolicy,
} from "../policy/workflow-policy.ts";
import {
	assertOwnerAgentExtensionBindingReady,
	bindHiddenOwnerAgentExtension,
	installResolvedAgentActivityDock,
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
	const { runtime } = await bridge.capture(
		ctx.sessionManager as AgentSession["sessionManager"],
		ctx.ui,
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
		await existing.coordinator.refreshAgentTemplateSnapshot(runtime.session.sessionId);
		const resolveView = () => existing.coordinator.forAgent(runtime.session.sessionId);
		installResolvedAgentActivityDock(ctx.ui, resolveView);
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
	const identity = adoptOrValidateOwnerIdentity(runtime, {
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
	const coordinator = new WorkflowCoordinator(runtime, identity, {
		entryModulePath,
		operationalIncidentPresentation: new OperationalIncidentSurface(),
		postMortemAgentPresenter: new OwnerPostMortemAgentPresenter(ctx.ui),
		workflowPolicy: policy,
		recoveredWorkflow,
	});
	let parkingBinding: OwnerSettlementParkingBinding | undefined;
	let ownerReplacementPreparation: Promise<void> | undefined;
	const prepareOwnerReplacement = () => {
		if (ownerReplacementPreparation) return ownerReplacementPreparation;
		// Pi owns native Runtime disposal after awaited session shutdown handlers.
		ownerReplacementPreparation = coordinator.shutdown(async () => undefined)
			.finally(() => parkingBinding?.dispose());
		return ownerReplacementPreparation;
	};
	await coordinator.refreshAgentTemplateSnapshot(identity.agentId);
	const resolveView = () => coordinator.forAgent(identity.agentId);
	installResolvedAgentActivityDock(ctx.ui, resolveView);
	bindHiddenOwnerAgentExtension({
		pi,
		runtime,
		bootstrapHandler,
		resolveView,
		prepareOwnerReplacement,
	});
	parkingBinding = installOwnerSettlementParker({
		agent: runtime.session.agent,
		hasOutstandingRequests: () => coordinator.hasOutstandingOwnerRequests(),
		beginParking: (runSignal) =>
			coordinator.beginOwnerSettlementParking(runSignal),
		shutdownSignal: coordinator.ownerShutdownSignal(),
		reportError: (error) => {
			runtime.services.diagnostics.push({
				type: "error",
				message: `Owner settlement parking failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
		},
	});
	initializedWorkflows.set(runtime.session, {
		coordinator,
		policy,
		prepareOwnerReplacement,
	});
	return resolveView;
}
