import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { OwnerCoordinatorView } from "../coordination/workflow-coordinator.ts";

export function registerOwnerSurfaces(pi: ExtensionAPI, view: OwnerCoordinatorView): void {
	pi.registerTool({
		name: "agent_observe",
		label: "Observe Agent",
		description: "Observe the authenticated Workflow Owner's durable identity and live Run state.",
		promptSnippet: "Observe this Workflow Owner's live Run state.",
		executionMode: "sequential",
		parameters: Type.Object(
			{
				operation: Type.Literal("status"),
				agentId: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, parameters) {
			const status = view.status(parameters.agentId);
			return {
				content: [{ type: "text", text: JSON.stringify(status) }],
				details: status,
			};
		},
	});

	pi.registerCommand("agents", {
		description: "Show Agents in the current Workflow",
		handler: async (_args, ctx) => {
			const status = view.status();
			const binding = status.run.retentionReasons[0].replaceAll("_", " ");
			await ctx.ui.select("Agents", [
				`${status.label} · ${status.agentId} · ${status.run.phase}/${status.run.work} · ${binding}`,
			]);
		},
	});
}
