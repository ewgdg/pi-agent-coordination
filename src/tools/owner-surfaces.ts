import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
	HumanPresentationCoordinatorView,
	ModeratorAgentCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "../coordination/workflow-coordinator.ts";
import { openAgentSelectorSurface } from "../presentation/agent-selector-surface.ts";
import {
	openAgentViewSurface,
	startPhysicalAgentViewSurface,
	type PhysicalAgentViewSurface,
} from "../presentation/agent-view-surface.ts";
import {
	createAgentSelectionSession,
	createAgentSelectorSnapshot,
} from "../process-runtime/remote-agent-selector.ts";
import {
	registerParticipantCoordinationTools,
	type ParticipantCoordinationRole,
	type ParticipantCoordinationToolHandlers,
} from "./participant-coordination-tools.ts";

type AgentCoordinatorView =
	| OrdinaryAgentCoordinatorView
	| ModeratorAgentCoordinatorView;
type ViewResolver = () => AgentCoordinatorView;

const OWNER_AGENT_TOOL_NAMES = new Set([
	"agent_message",
	"agent_spawn",
	"agent_observe",
	"agent_control",
]);

export function activateOwnerAgentTools(pi: ExtensionAPI): void {
	pi.setActiveTools([
		...new Set([...pi.getActiveTools(), ...OWNER_AGENT_TOOL_NAMES]),
	]);
}

export function deactivateOwnerAgentTools(pi: ExtensionAPI): void {
	pi.setActiveTools(
		pi.getActiveTools().filter((toolName) => !OWNER_AGENT_TOOL_NAMES.has(toolName)),
	);
}

export function registerAgentsCommand(
	pi: ExtensionAPI,
	resolveView: () => HumanPresentationCoordinatorView,
): void {
	pi.registerCommand("agents", {
		description: "Show Agents in the current Workflow",
		handler: async (_args, ctx) => {
			const view = resolveView();
			const selectedAgentId = view.status().agentId;
			const selection = createAgentSelectionSession(view, selectedAgentId);
			let physicalSurface: PhysicalAgentViewSurface | undefined;
			const action = await openAgentSelectorSurface(ctx.ui, {
				...createAgentSelectorSnapshot(view, selectedAgentId),
				async prepareSelection(action, ownerTui) {
					await selection.prepare(action);
					const preparedAgentView = selection.preparedView();
					if (!preparedAgentView) return;
					physicalSurface = startPhysicalAgentViewSurface(preparedAgentView, {
						ownerTui,
						requestShutdown: () => ctx.shutdown(),
					});
					await physicalSurface?.ready;
				},
				onSelectionError(error) {
					ctx.ui.notify(
						`Agent view failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				},
			});
			if (action?.kind === "decide") {
				try {
					await selection.complete(action);
				} catch (error) {
					physicalSurface?.close();
					ctx.ui.notify(
						`Human Request selection failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
			}
			if (action) {
				const preparedAgentView = selection.preparedView();
				if (preparedAgentView && !physicalSurface) {
					await openAgentViewSurface(ctx.ui, preparedAgentView, {
						requestShutdown: () => ctx.shutdown(),
					});
				} else {
					void physicalSurface?.closed.catch((error) => ctx.ui.notify(
						`Agent view failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					));
				}
			}
		},
	});
}

export function registerOrdinaryAgentSurfaces(
	pi: ExtensionAPI,
	resolveView: () => OrdinaryAgentCoordinatorView,
): void {
	registerParticipantCoordinationTools(
		pi,
		"ordinary",
		participantCoordinatorHandlers("ordinary", resolveView),
	);
	registerAgentsCommand(pi, resolveView);
}

export function registerOwnerAgentTools(
	pi: ExtensionAPI,
	resolveView: () => OrdinaryAgentCoordinatorView,
): void {
	registerParticipantCoordinationTools(
		pi,
		"owner",
		participantCoordinatorHandlers("owner", resolveView),
	);
}

export function registerModeratorAgentSurfaces(
	pi: ExtensionAPI,
	resolveView: () => ModeratorAgentCoordinatorView,
): void {
	registerParticipantCoordinationTools(
		pi,
		"moderator",
		participantCoordinatorHandlers("moderator", resolveView),
	);
	registerAgentsCommand(pi, resolveView);
}

export function participantCoordinatorHandlers(
	role: "ordinary",
	resolveView: () => OrdinaryAgentCoordinatorView,
): ParticipantCoordinationToolHandlers<"ordinary">;
export function participantCoordinatorHandlers(
	role: "owner",
	resolveView: () => OrdinaryAgentCoordinatorView,
): ParticipantCoordinationToolHandlers<"owner">;
export function participantCoordinatorHandlers(
	role: "moderator",
	resolveView: () => ModeratorAgentCoordinatorView,
): ParticipantCoordinationToolHandlers<"moderator">;
export function participantCoordinatorHandlers(
	role: ParticipantCoordinationRole,
	resolveView: ViewResolver,
): ParticipantCoordinationToolHandlers<ParticipantCoordinationRole> {
	const common = {
		message: (toolCallId: string, input: Parameters<AgentCoordinatorView["message"]>[1]) =>
			resolveView().message(toolCallId, input),
		async observe(input: { operation: "status" | "children"; agentId?: string }) {
			const view = resolveView();
			return input.operation === "children"
				? { children: view.children(input.agentId) }
				: view.status(input.agentId);
		},
		control: (toolCallId: string, input: Parameters<AgentCoordinatorView["control"]>[1]) =>
			resolveView().control(toolCallId, input),
	};
	if (role === "moderator") {
		const moderatorView = resolveView as () => ModeratorAgentCoordinatorView;
		return {
			...common,
			askUserQuestion: (toolCallId, input, signal) =>
				moderatorView().askHuman(toolCallId, input, signal),
			moderatorControl: (toolCallId, input) =>
				moderatorView().moderatorControl(toolCallId, input),
		};
	}
	const ordinaryView = resolveView as () => OrdinaryAgentCoordinatorView;
	const spawn = (toolCallId: string, input: Parameters<OrdinaryAgentCoordinatorView["spawn"]>[1]) =>
		ordinaryView().spawn(toolCallId, input);
	return role === "ordinary"
		? {
			...common,
			spawn,
			askUserQuestion: (toolCallId, input, signal) =>
				ordinaryView().askHuman(toolCallId, input, signal),
		}
		: { ...common, spawn };
}
