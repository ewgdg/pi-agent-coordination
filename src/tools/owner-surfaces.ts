import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { OrdinaryAgentCoordinatorView } from "../coordination/workflow-coordinator.ts";
import {
	renderAgentMessageCall,
	renderAgentMessageResult,
} from "./message-renderer.ts";

type ViewResolver = () => OrdinaryAgentCoordinatorView;

export function registerOrdinaryAgentSurfaces(
	pi: ExtensionAPI,
	resolveView: ViewResolver,
): void {
	const messageParameters = Type.Union([
		Type.Object(
			{
				operation: Type.Literal("send"),
				targetAgentId: Type.String({ minLength: 1 }),
				content: Type.String({ minLength: 1 }),
				deliveryMode: Type.Optional(
					Type.Union([
						Type.Literal("deferred"),
						Type.Literal("steer"),
					]),
				),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				operation: Type.Literal("request"),
				targetAgentId: Type.String({ minLength: 1 }),
				question: Type.String({ minLength: 1 }),
				deliveryMode: Type.Optional(
					Type.Union([
						Type.Literal("deferred"),
						Type.Literal("steer"),
					]),
				),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				operation: Type.Literal("answer"),
				requestId: Type.String({ minLength: 1 }),
				answer: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				operation: Type.Literal("cancel"),
				requestId: Type.String({ minLength: 1 }),
				reason: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				operation: Type.Literal("poll"),
				messageId: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				operation: Type.Literal("retry"),
				messageId: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
	]);
	const spawnParameters = Type.Object(
		{
			request: Type.String({ minLength: 1 }),
			description: Type.Optional(Type.String({ minLength: 1 })),
		},
		{ additionalProperties: false },
	);
	const observeParameters = Type.Union([
		Type.Object(
			{
				operation: Type.Literal("status"),
				agentId: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				operation: Type.Literal("children"),
				agentId: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
	]);
	pi.registerTool({
		name: "agent_message",
		label: "Message Agent",
		description:
			"Send one immutable Message or correlated Request to a known Agent in this Workflow.",
		promptSnippet: "Send, request, answer, cancel, poll, or retry direct Agent communication.",
		executionMode: "sequential",
		parameters: messageParameters,
		renderCall: renderAgentMessageCall,
		renderResult: renderAgentMessageResult,
		async execute(toolCallId, parameters) {
			const receipt = await resolveView().message(toolCallId, parameters);
			return {
				content: [{ type: "text", text: JSON.stringify(receipt) }],
				details: receipt,
			};
		},
	});
	pi.registerTool({
		name: "agent_spawn",
		label: "Spawn Agent",
		description:
			"Create one fresh durable child Agent with inherited runtime configuration and deliver its initial Creation Request.",
		promptSnippet: "Create one fresh child Agent and give it isolated initial work.",
		executionMode: "sequential",
		parameters: spawnParameters,
		async execute(toolCallId, parameters) {
			const receipt = await resolveView().spawn(toolCallId, parameters);
			return {
				content: [{ type: "text", text: JSON.stringify(receipt) }],
				details: receipt,
			};
		},
	});

	pi.registerTool<typeof observeParameters, unknown>({
		name: "agent_observe",
		label: "Observe Agent",
		description: "Passively observe an authorized Agent or its direct children.",
		promptSnippet: "Observe authorized Agents and their bounded live Run state.",
		executionMode: "sequential",
		parameters: observeParameters,
		async execute(_toolCallId, parameters) {
			if (parameters.operation === "children") {
				const children = resolveView().children(parameters.agentId);
				const details = { children };
				return {
					content: [{ type: "text", text: JSON.stringify(details) }],
					details,
				};
			}
			const status = resolveView().status(parameters.agentId);
			return {
				content: [{ type: "text", text: JSON.stringify(status) }],
				details: status,
			};
		},
	});

	pi.registerCommand("agents", {
		description: "Show Agents in the current Workflow",
		handler: async (_args, ctx) => {
			const view = resolveView();
			const status = view.status();
			const children = view.children();
			await ctx.ui.select("Agents", [formatAgentRow(status), ...children.map(formatAgentRow)]);
		},
	});
}

function formatAgentRow(status: ReturnType<OrdinaryAgentCoordinatorView["status"]>): string {
	const run = status.run;
	const work = "work" in run && run.work ? `/${run.work}` : "";
	const binding = run.retentionReasons.length === 0
		? undefined
		: run.retentionReasons.map((retention) => [
			retention.reason.replaceAll("_", " "),
			retention.count > 1 ? `×${retention.count}` : undefined,
		].filter(Boolean).join(" ")).join(", ");
	return [
		`${status.label} · ${status.agentId} · ${run.phase}${work}`,
		binding,
	].filter(Boolean).join(" · ");
}
