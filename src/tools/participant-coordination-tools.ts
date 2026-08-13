import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

import type { AgentStatus } from "../coordination/agent-record.ts";
import type { AgentMessageReceipt } from "../coordination/message-receipts.ts";
import type { AgentSpawnReceipt } from "../coordination/spawning.ts";
import type { AgentMessageInput } from "../protocol/agent-message-input.ts";
import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import type { HumanAnswer, HumanRequestInput } from "../protocol/human-request.ts";
import type {
	ModeratorControlInput,
	ModeratorControlReceipt,
} from "../protocol/moderator-control.ts";
import type { RunControlInput, RunControlReceipt } from "../protocol/run-control.ts";
import {
	renderAgentControlCall,
	renderAgentControlResult,
	renderAgentObserveCall,
	renderAgentObserveResult,
	renderHumanRequestCall,
	renderHumanRequestResult,
	renderModeratorControlCall,
	renderModeratorControlResult,
} from "./coordination-renderers.ts";
import {
	renderAgentMessageCall,
	renderAgentMessageResult,
} from "./message-renderer.ts";
import {
	renderAgentSpawnCall,
	renderAgentSpawnResult,
} from "./spawn-renderer.ts";

export type ParticipantCoordinationRole = "ordinary" | "moderator" | "owner";

export type AgentObserveInput = Readonly<{
	operation: "status" | "children";
	agentId?: string;
}>;

export type AgentObserveResult = AgentStatus | Readonly<{
	children: readonly AgentStatus[];
}>;

type CommonParticipantCoordinationToolHandlers = Readonly<{
	message(
		toolCallId: string,
		input: AgentMessageInput,
	): Promise<AgentMessageReceipt>;
	observe(input: AgentObserveInput): Promise<AgentObserveResult>;
	control(
		toolCallId: string,
		input: RunControlInput,
	): Promise<RunControlReceipt>;
}>;

type SpawnParticipantCoordinationToolHandler = Readonly<{
	spawn(toolCallId: string, input: AgentSpawnInput): Promise<AgentSpawnReceipt>;
}>;

type HumanParticipantCoordinationToolHandler = Readonly<{
	askUserQuestion(
		toolCallId: string,
		input: HumanRequestInput,
		signal: AbortSignal | undefined,
	): Promise<HumanAnswer>;
}>;

type ModeratorParticipantCoordinationToolHandler = Readonly<{
	moderatorControl(
		toolCallId: string,
		input: ModeratorControlInput,
	): Promise<ModeratorControlReceipt>;
}>;

export type ParticipantCoordinationToolHandlers<
	Role extends ParticipantCoordinationRole,
> = CommonParticipantCoordinationToolHandlers & (
	Role extends "ordinary"
		? SpawnParticipantCoordinationToolHandler & HumanParticipantCoordinationToolHandler
		: Role extends "moderator"
			? HumanParticipantCoordinationToolHandler & ModeratorParticipantCoordinationToolHandler
			: SpawnParticipantCoordinationToolHandler
);

const agentMessageParameters = objectRootUnion(Type.Union([
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
]));

const agentSpawnParameters = Type.Object(
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

const agentObserveParameters = objectRootUnion(Type.Union([
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
]));

const agentControlParameters = objectRootUnion(Type.Union([
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
]));

const askUserQuestionParameters = Type.Object(
	{
		question: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

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

const moderatorControlParameters = objectRootUnion(Type.Union([
	Type.Object(
		{
			operation: Type.Literal("renew_review_deadline"),
			toolCall: Type.Object(
				{
					agentId: Type.String({ minLength: 1 }),
					entryId: Type.String({ minLength: 1 }),
					toolCallId: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
			nextReviewInMs: Type.Integer({ minimum: 1 }),
			rationale: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("resolve"),
			summary: Type.String({ minLength: 1 }),
			rationale: Type.String({ minLength: 1 }),
			evidencePointers: Type.Optional(Type.Array(evidencePointer)),
		},
		{ additionalProperties: false },
	),
]));

export const participantCoordinationToolSchemas = {
	agent_message: agentMessageParameters,
	agent_spawn: agentSpawnParameters,
	agent_observe: agentObserveParameters,
	agent_control: agentControlParameters,
	ask_user_question: askUserQuestionParameters,
	moderator_control: moderatorControlParameters,
} as const;

type AvailableHandlers = CommonParticipantCoordinationToolHandlers &
	Partial<SpawnParticipantCoordinationToolHandler> &
	Partial<HumanParticipantCoordinationToolHandler> &
	Partial<ModeratorParticipantCoordinationToolHandler>;

export function registerParticipantCoordinationTools<
	Role extends ParticipantCoordinationRole,
>(
	pi: ExtensionAPI,
	role: Role,
	handlers: ParticipantCoordinationToolHandlers<Role>,
): void {
	const availableHandlers = handlers as AvailableHandlers;
	pi.registerTool<typeof agentMessageParameters, AgentMessageReceipt>({
		name: "agent_message",
		label: "Message Agent",
		description:
			"Send one immutable Message or correlated Request to a known Agent in this Workflow.",
		promptSnippet: "Send, request, answer, cancel, poll, or retry direct Agent communication.",
		executionMode: "sequential",
		parameters: agentMessageParameters,
		renderCall: renderAgentMessageCall,
		renderResult: renderAgentMessageResult,
		async execute(toolCallId, parameters) {
			return toolResult(await availableHandlers.message(toolCallId, parameters));
		},
	});
	if (role !== "moderator") {
		pi.registerTool<typeof agentSpawnParameters, AgentSpawnReceipt>({
			name: "agent_spawn",
			label: "Spawn Agent",
			description:
				"Create one fresh durable child Agent with inherited runtime configuration and deliver its initial Creation Request.",
			promptSnippet: "Create one fresh child Agent and give it isolated initial work.",
			executionMode: "sequential",
			parameters: agentSpawnParameters,
			renderCall: renderAgentSpawnCall,
			renderResult: renderAgentSpawnResult,
			async execute(toolCallId, parameters) {
				return toolResult(await availableHandlers.spawn!(toolCallId, parameters));
			},
		});
	}

	pi.registerTool<typeof agentObserveParameters, AgentObserveResult>({
		name: "agent_observe",
		label: "Observe Agent",
		description: role === "moderator"
			? "Passively observe any known Agent in this Workflow or enumerate ordinary children."
			: "Passively observe an authorized Agent or its direct children.",
		promptSnippet: role === "moderator"
			? "Pull bounded status for Workflow Agents relevant to diagnosis."
			: "Observe authorized Agents and their bounded live Run state.",
		executionMode: "sequential",
		parameters: agentObserveParameters,
		renderCall: renderAgentObserveCall,
		renderResult: renderAgentObserveResult,
		async execute(_toolCallId, parameters) {
			return toolResult(await availableHandlers.observe(parameters));
		},
	});
	pi.registerTool<typeof agentControlParameters, RunControlReceipt>({
		name: "agent_control",
		label: "Control Agent Run",
		description:
			"Interrupt, explicitly resume, or terminate one authorized exact Agent Run.",
		promptSnippet: role === "moderator"
			? "Supervise any current non-Owner Run needed to restore safe progress."
			: "Supervise an immediate child Run, or any non-Owner Run when acting as Workflow Owner.",
		executionMode: "sequential",
		parameters: agentControlParameters,
		renderCall: renderAgentControlCall,
		renderResult: renderAgentControlResult,
		async execute(toolCallId, parameters) {
			return toolResult(await availableHandlers.control(toolCallId, parameters));
		},
	});
	if (role !== "owner") {
		pi.registerTool<typeof askUserQuestionParameters, HumanAnswer>({
			name: "ask_user_question",
			label: "Ask User",
			description:
				"Ask the human one nonblank free-form question and wait for one nonblank free-form Answer.",
			promptSnippet:
				"Block until the human supplies judgment through this Agent's native editor.",
			executionMode: "sequential",
			parameters: askUserQuestionParameters,
			renderShell: "self",
			renderCall: renderHumanRequestCall,
			renderResult: renderHumanRequestResult,
			async execute(toolCallId, parameters, signal) {
				return toolResult(
					await availableHandlers.askUserQuestion!(toolCallId, parameters, signal),
				);
			},
		});
	}

	if (role === "moderator") {
		pi.registerTool<typeof moderatorControlParameters, ModeratorControlReceipt>({
			name: "moderator_control",
			label: "Control Moderation",
			description:
				"Renew an exact Operation Review interval or resolve handling after every mechanically checkable predicate clears.",
			promptSnippet:
				"Renew an exact reviewed call deliberately, or record a Resolution and revalidate the original condition.",
			executionMode: "sequential",
			parameters: moderatorControlParameters,
			renderCall: renderModeratorControlCall,
			renderResult: renderModeratorControlResult,
			async execute(toolCallId, parameters) {
				return toolResult(
					await availableHandlers.moderatorControl!(toolCallId, parameters),
				);
			},
		});
	}
}

function toolResult<Details>(details: Details): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: JSON.stringify(details) }],
		details,
	};
}

function objectRootUnion<T extends TSchema>(schema: T): T {
	// DeepSeek validates the function schema root before evaluating its variants.
	// Keep TypeBox's discriminated union for Pi validation while exposing the
	// object root required by OpenAI-compatible providers.
	return Object.assign(schema, { type: "object" as const });
}
