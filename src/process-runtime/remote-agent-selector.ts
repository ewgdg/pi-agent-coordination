import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
	RemoteAgentSelectorAction,
	RemoteAgentSelectorSnapshot,
} from "../control/agent-control-protocol.ts";
import type { HumanPresentationCoordinatorView } from "../coordination/workflow-coordinator.ts";
import {
	openAgentSelectorSurface,
	type AgentSelectorAction,
} from "../presentation/agent-selector-surface.ts";
import type { DurableAgentView } from "../presentation/agent-view-surface.ts";
import type {
	ControlBackedChildPresentationHandlers,
	OwnerParticipantPresentationHandlers,
} from "./remote-participant-control.ts";

export type AgentSelectionSession = Readonly<{
	prepare(action: AgentSelectorAction, signal?: AbortSignal): Promise<void>;
	complete(action: AgentSelectorAction, signal?: AbortSignal): Promise<void>;
	preparedView(): DurableAgentView | undefined;
}>;

/** Capture every selector input at one scoped Owner presentation boundary. */
export function createAgentSelectorSnapshot(
	view: HumanPresentationCoordinatorView,
	selectedAgentId = view.status().agentId,
): RemoteAgentSelectorSnapshot {
	const roster = view.selectionRoster();
	return {
		live: [...roster.live],
		dormant: [...roster.dormant],
		selectedAgentId,
		humanAttention: [...view.humanAttention()],
		operationalAttention: [...view.operationalAttention()],
	};
}

/**
 * Owns one selector decision's preparation and rollback semantics. The previous
 * selection is an Agent identity, never a transport or attachment identity.
 */
export function createAgentSelectionSession(
	view: HumanPresentationCoordinatorView,
	selectedAgentId: string,
): AgentSelectionSession {
	let preparedAgentView: DurableAgentView | undefined;
	const isPendingDecision = (decision: Extract<AgentSelectorAction, { kind: "decide" }>) =>
		view.humanAttention().some(
			(item) => item.requestId === decision.requestId && item.agentId === decision.agentId,
		);
	const restorePreviousSelection = async () => {
		if (preparedAgentView) await preparedAgentView.close();
		else await view.openAgentView(selectedAgentId);
		preparedAgentView = undefined;
	};
	return {
		async prepare(action, signal) {
			throwIfCancelled(signal);
			if (action.kind === "decide" && !isPendingDecision(action)) {
				throw new Error("stale_request: Human Request is no longer pending");
			}
			preparedAgentView = await view.openAgentView(action.agentId);
			if (signal?.aborted || (action.kind === "decide" && !isPendingDecision(action))) {
				// Preparation may have acquired or retargeted the attachment while the
				// selector retained focus. Cancellation and stale Attention both undo it.
				await restorePreviousSelection();
				throwIfCancelled(signal);
				throw new Error("stale_request: Human Request is no longer pending");
			}
		},
		async complete(action, signal) {
			if (action.kind !== "decide") {
				if (signal?.aborted) {
					await restorePreviousSelection();
					throwIfCancelled(signal);
				}
				return;
			}
			try {
				throwIfCancelled(signal);
				await view.focusHumanAnswer(action.agentId, action.requestId);
				throwIfCancelled(signal);
			} catch (error) {
				await restorePreviousSelection();
				throw error;
			}
		},
		preparedView: () => preparedAgentView,
	};
}

/** Build the authenticated child's Owner-side presentation boundary. */
export function createOwnerAgentPresentationHandlers(
	resolveView: () => HumanPresentationCoordinatorView,
	selectedAgentId: string,
): OwnerParticipantPresentationHandlers {
	return {
		snapshot: () => createAgentSelectorSnapshot(resolveView(), selectedAgentId),
		async select(action, signal) {
			const selection = createAgentSelectionSession(resolveView(), selectedAgentId);
			await selection.prepare(action as AgentSelectorAction, signal);
			await selection.complete(action as AgentSelectorAction, signal);
		},
	};
}

/** Register the real child-local selector against its truthful Pi TUI context. */
export function registerRemoteAgentsCommand(
	pi: ExtensionAPI,
	presentation: ControlBackedChildPresentationHandlers,
): void {
	pi.registerCommand("agents", {
		description: "Show Agents in the current Workflow",
		handler: async (_args, ctx) => {
			const snapshot = await presentation.snapshot();
			await openAgentSelectorSurface(ctx.ui, {
				...snapshot,
				prepareSelection: (action) =>
					presentation.select(action as RemoteAgentSelectorAction),
				onSelectionError(error) {
					ctx.ui.notify(
						`Agent view failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				},
			});
		},
	});
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new DOMException("The Control request was cancelled", "AbortError");
}
