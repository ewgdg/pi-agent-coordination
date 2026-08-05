import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
	ModeratorAgentCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "../coordination/workflow-coordinator.ts";
import {
	MAX_AUTOMATIC_MODERATOR_ATTEMPTS,
	type OperationalIncidentAttention,
} from "../coordination/operational-incidents.ts";
import {
	formatOperationalIncidentHeadline,
	operationalIncidentRequestEvidence,
} from "../presentation/operational-incident-surface.ts";
import {
	renderAgentMessageCall,
	renderAgentMessageResult,
} from "./message-renderer.ts";
import {
	renderAgentSpawnCall,
	renderAgentSpawnResult,
} from "./spawn-renderer.ts";

type AgentCoordinatorView =
	| OrdinaryAgentCoordinatorView
	| ModeratorAgentCoordinatorView;
type ViewResolver = () => AgentCoordinatorView;

export function registerOrdinaryAgentSurfaces(
	pi: ExtensionAPI,
	resolveView: () => OrdinaryAgentCoordinatorView,
): void {
	registerAgentSurfaces(pi, resolveView, { spawn: true, moderatorControl: false });
}

export function registerModeratorAgentSurfaces(
	pi: ExtensionAPI,
	resolveView: () => ModeratorAgentCoordinatorView,
): void {
	registerAgentSurfaces(pi, resolveView, { spawn: false, moderatorControl: true });
}

function registerAgentSurfaces(
	pi: ExtensionAPI,
	resolveView: ViewResolver,
	role: Readonly<{ spawn: boolean; moderatorControl: boolean }>,
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
			template: Type.Optional(
				Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
			),
			label: Type.Optional(Type.String({ minLength: 1 })),
			description: Type.Optional(Type.String({ minLength: 1 })),
			config: Type.Optional(
				Type.Object(
					{
						model: Type.Optional(
							Type.Object(
								{
									provider: Type.String({ minLength: 1 }),
									modelId: Type.String({ minLength: 1 }),
								},
								{ additionalProperties: false },
							),
						),
						thinking: Type.Optional(
							Type.Union([
								Type.Literal("off"),
								Type.Literal("minimal"),
								Type.Literal("low"),
								Type.Literal("medium"),
								Type.Literal("high"),
								Type.Literal("xhigh"),
								Type.Literal("max"),
							]),
						),
						cwd: Type.Optional(Type.String({ minLength: 1 })),
						tools: Type.Optional(
							Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
						),
						skills: Type.Optional(
							Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
						),
						extensions: Type.Optional(
							Type.Union([
								Type.Literal("inherit"),
								Type.Literal("none"),
								Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
							]),
						),
						projectContext: Type.Optional(Type.String()),
						projectContextMode: Type.Optional(
							Type.Union([Type.Literal("append"), Type.Literal("replace")]),
						),
					},
					{ additionalProperties: false },
				),
			),
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
	const controlParameters = Type.Union([
		Type.Object(
			{
				operation: Type.Literal("interrupt"),
				agentId: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				operation: Type.Literal("resume"),
				agentId: Type.String({ minLength: 1 }),
				content: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				operation: Type.Literal("terminate"),
				agentId: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
	]);
	const humanOption = Type.Object(
		{
			label: Type.String({ minLength: 1 }),
			description: Type.Optional(Type.String({ minLength: 1 })),
		},
		{ additionalProperties: false },
	);
	const humanQuestion = Type.Union([
		Type.Object(
			{
				kind: Type.Literal("select_one"),
				header: Type.String({ minLength: 1 }),
				prompt: Type.String({ minLength: 1 }),
				options: Type.Array(humanOption, {
					minItems: 1,
					uniqueItems: true,
				}),
				allowOther: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				kind: Type.Literal("select_many"),
				header: Type.String({ minLength: 1 }),
				prompt: Type.String({ minLength: 1 }),
				options: Type.Array(humanOption, {
					minItems: 1,
					uniqueItems: true,
				}),
				allowOther: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				kind: Type.Literal("text"),
				header: Type.String({ minLength: 1 }),
				prompt: Type.String({ minLength: 1 }),
				multiline: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
	]);
	const humanRequestParameters = Type.Object(
		{
			questions: Type.Array(humanQuestion, { minItems: 1 }),
		},
		{ additionalProperties: false },
	);
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
	if (role.spawn) {
		const ordinaryView = resolveView as () => OrdinaryAgentCoordinatorView;
		pi.registerTool({
			name: "agent_spawn",
			label: "Spawn Agent",
			description:
				"Create one fresh durable child Agent with inherited runtime configuration and deliver its initial Creation Request.",
			promptSnippet: "Create one fresh child Agent and give it isolated initial work.",
			executionMode: "sequential",
			parameters: spawnParameters,
			renderCall: renderAgentSpawnCall,
			renderResult: renderAgentSpawnResult,
			async execute(toolCallId, parameters) {
				const receipt = await ordinaryView().spawn(toolCallId, parameters);
				return {
					content: [{ type: "text", text: JSON.stringify(receipt) }],
					details: receipt,
				};
			},
		});
	}

	pi.registerTool<typeof observeParameters, unknown>({
		name: "agent_observe",
		label: "Observe Agent",
		description: role.moderatorControl
			? "Passively observe any known Agent in this Workflow or enumerate ordinary children."
			: "Passively observe an authorized Agent or its direct children.",
		promptSnippet: role.moderatorControl
			? "Pull bounded status for Workflow Agents relevant to diagnosis."
			: "Observe authorized Agents and their bounded live Run state.",
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
	pi.registerTool<typeof controlParameters, unknown>({
		name: "agent_control",
		label: "Control Agent Run",
		description:
			"Interrupt, explicitly resume, or terminate one authorized exact Agent Run.",
		promptSnippet: role.moderatorControl
			? "Supervise any current non-Owner Run needed to restore safe progress."
			: "Supervise an immediate child Run, or any non-Owner Run when acting as Workflow Owner.",
		executionMode: "sequential",
		parameters: controlParameters,
		async execute(toolCallId, parameters) {
			const receipt = await resolveView().control(toolCallId, parameters);
			return {
				content: [{ type: "text", text: JSON.stringify(receipt) }],
				details: receipt,
			};
		},
	});
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask Human",
		description:
			"Ask the human one or more structured Questions and wait for one complete positional Answer.",
		promptSnippet:
			"Use for decisions that require human select-one, select-many, or non-empty text input.",
		executionMode: "sequential",
		parameters: humanRequestParameters,
		async execute(toolCallId, parameters, signal) {
			const answer = await resolveView().askHuman(
				toolCallId,
				parameters,
				signal,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(answer) }],
				details: answer,
			};
		},
	});

	if (role.moderatorControl) {
		const moderatorView = resolveView as () => ModeratorAgentCoordinatorView;
		const evidencePointer = Type.Union([
			Type.Object(
				{
					agentId: Type.String({ minLength: 1 }),
					entryId: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					agentId: Type.String({ minLength: 1 }),
					entryId: Type.String({ minLength: 1 }),
					toolCallId: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
		]);
		const moderatorControlParameters = Type.Object(
			{
				operation: Type.Literal("resolve"),
				summary: Type.String({ minLength: 1 }),
				rationale: Type.String({ minLength: 1 }),
				evidencePointers: Type.Optional(Type.Array(evidencePointer)),
			},
			{ additionalProperties: false },
		);
		pi.registerTool({
			name: "moderator_control",
			label: "Resolve Moderation",
			description:
				"Resolve operational handling only after every mechanically checkable predicate clears.",
			promptSnippet:
				"Record the handling summary and rationale, then revalidate the original condition.",
			executionMode: "sequential",
			parameters: moderatorControlParameters,
			async execute(toolCallId, parameters) {
				const receipt = await moderatorView().moderatorControl(
					toolCallId,
					parameters,
				);
				return {
					content: [{ type: "text", text: JSON.stringify(receipt) }],
					details: receipt,
				};
			},
		});
	}

	pi.registerCommand("agents", {
		description: "Show Agents in the current Workflow",
		handler: async (_args, ctx) => {
			const view = resolveView();
			const roster = view.selectionRoster();
			const statusRows = [
				...roster.live.map((status) => ({
					status,
					option: `Live · ${formatAgentRow(status)}`,
				})),
				...roster.dormant.map((status) => ({
					status,
					option: `Dormant · ${formatAgentRow(status)}`,
				})),
			];
			const attention = view.humanAttention();
			const attentionOptions = attention.map(
				(item, index) =>
					`DECIDE ${index + 1} · ${item.agentLabel} · ${item.questionCount} Question${item.questionCount === 1 ? "" : "s"}`,
			);
				const operationalAttention = view.operationalAttention();
				const operationalOptions = operationalAttention.map(
					(item, index) => formatOperationalIncidentOption(item, index),
				);
			const selected = await ctx.ui.select("Agents", [
				...attentionOptions,
				...operationalOptions,
				...statusRows.map(({ option }) => option),
			]);
			const attentionIndex = selected === undefined
				? -1
				: attentionOptions.indexOf(selected);
			if (attentionIndex >= 0) {
				await view.focusHumanRequest(attention[attentionIndex]!.requestId);
				return;
			}
			if (selected !== undefined && operationalOptions.includes(selected)) return;
			const selectedStatus = statusRows.find(({ option }) => option === selected)?.status;
			if (selectedStatus) await view.selectForHuman(selectedStatus.agentId);
		},
	});
}

export function formatOperationalIncidentOption(
	attention: OperationalIncidentAttention,
	index: number,
): string {
	const requests = operationalIncidentRequestEvidence(attention);
	return [
		`ATTENTION ${index + 1}`,
		formatOperationalIncidentHeadline(attention),
		`Requests ${requests.total}`,
		...requests.sources.map(
			(pointer) => `Request ${pointer.agentId}/${pointer.entryId}/${pointer.toolCallId}`,
		),
		...attention.diagnostics.slice(0, MAX_AUTOMATIC_MODERATOR_ATTEMPTS).map(
			(pointer) => `Diagnostic ${pointer.agentId}/${pointer.entryId}`,
		),
	].join(" · ");
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
