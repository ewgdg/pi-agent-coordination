import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
	HumanPresentationCoordinatorView,
	ModeratorAgentCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "../coordination/workflow-coordinator.ts";
import { openAgentSelectorSurface } from "../presentation/agent-selector-surface.ts";
import { openAgentViewSurface } from "../presentation/agent-view-surface.ts";
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
			const roster = view.selectionRoster();
			const selectedAgent = view.status();
			const isPendingDecision = (decision: {
				requestId: string;
				agentId: string;
			}) => view.humanAttention().some(
				(item) =>
					item.requestId === decision.requestId &&
					item.agentId === decision.agentId,
			);
			let preparedAgentView:
				| Awaited<ReturnType<typeof view.openAgentView>>
				| undefined;
			const restorePreviousSelection = async () => {
				if (preparedAgentView) await preparedAgentView.close();
				else await view.openAgentView(selectedAgent.agentId);
				preparedAgentView = undefined;
			};
			const action = await openAgentSelectorSurface(ctx.ui, {
				...roster,
				selectedAgentId: selectedAgent.agentId,
				humanAttention: view.humanAttention(),
				operationalAttention: view.operationalAttention(),
				async prepareSelection(selection) {
					if (
						selection.kind === "decide" &&
						!isPendingDecision(selection)
					) {
						throw new Error("stale_request: Human Request is no longer pending");
					}
					preparedAgentView = await view.openAgentView(selection.agentId);
					if (
						selection.kind === "decide" &&
						!isPendingDecision(selection)
					) {
						// Preparation may have acquired or retargeted a view while the
						// selector retained focus. Undo that change if the Request won the race.
						await restorePreviousSelection();
						throw new Error("stale_request: Human Request is no longer pending");
					}
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
					await view.focusHumanAnswer(action.agentId, action.requestId);
				} catch (error) {
					await restorePreviousSelection();
					ctx.ui.notify(
						`Human Request selection failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
			}
			if (action) {
				if (preparedAgentView) {
					await openAgentViewSurface(ctx.ui, preparedAgentView, {
						requestShutdown: () => ctx.shutdown(),
					});
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
		participantCoordinatorAdapter("ordinary", resolveView),
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
		participantCoordinatorAdapter("owner", resolveView),
	);
}

export function registerModeratorAgentSurfaces(
	pi: ExtensionAPI,
	resolveView: () => ModeratorAgentCoordinatorView,
): void {
	registerParticipantCoordinationTools(
		pi,
		"moderator",
		participantCoordinatorAdapter("moderator", resolveView),
	);
	registerAgentsCommand(pi, resolveView);
}

function participantCoordinatorAdapter(
	role: "ordinary",
	resolveView: () => OrdinaryAgentCoordinatorView,
): ParticipantCoordinationToolHandlers<"ordinary">;
function participantCoordinatorAdapter(
	role: "owner",
	resolveView: () => OrdinaryAgentCoordinatorView,
): ParticipantCoordinationToolHandlers<"owner">;
function participantCoordinatorAdapter(
	role: "moderator",
	resolveView: () => ModeratorAgentCoordinatorView,
): ParticipantCoordinationToolHandlers<"moderator">;
function participantCoordinatorAdapter(
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
