import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

import type { AgentStatus } from "../coordination/agent-record.ts";
import type { AgentMessageReceipt } from "../coordination/message-receipts.ts";
import type { AgentLabelResolver } from "../presentation/agent-identity.ts";
import type { AgentSpawnReceipt } from "../coordination/spawning.ts";
import type { AgentMessageInput } from "../protocol/agent-message-input.ts";
import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import type {
	AgentWaitInput,
	AgentWaitProgress,
	AgentWaitResult,
} from "../protocol/agent-wait.ts";
import type { HumanAnswer, HumanRequestInput } from "../protocol/human-request.ts";
import type {
	ModeratorControlInput,
	ModeratorControlReceipt,
} from "../protocol/moderator-control.ts";
import type { RunControlInput, RunControlReceipt } from "../protocol/run-control.ts";
import type { AgentTemplateCatalogueSnapshot } from "../templates/agent-templates.ts";
import {
	renderAgentControlCall,
	renderAgentControlResult,
	renderAgentObserveCall,
	renderAgentObserveResult,
	renderAgentWaitCall,
	renderAgentWaitResult,
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
import { renderAgentTemplatePromptGuide } from "./agent-template-prompt-guide.ts";

export type ParticipantCoordinationRole = "ordinary" | "moderator" | "owner";

const AGENT_MESSAGE_PROMPT_GUIDE = `<agent_message>
For send and request, targetAgent accepts an exact Agent label, full Agent ID, or unique Agent ID suffix. Full IDs and suffixes resolve Workflow-wide. Labels resolve only among the caller, its Direct Spawner, and its direct children; Owner and Moderator labels resolve Workflow-wide. An ambiguous target is rejected rather than guessed.

When agent_message returns messageStatus "sent", the Message was admitted for asynchronous Delivery and may still be queued; it does not mean delivered.

A delivered Agent Request, including a Creation Request, creates one Answer obligation for the recipient.

While an Answer Obligation is active, agent_message operation "send" to that Request's requester is rejected. Keep provisional findings local. Use "answer" for the curated result, or issue a reverse "request" when requester input or a decision is needed. Ordinary "send" to other Agents remains available.

agent_message operation "answer" supplies Answer text only. The coordinator binds it to the Agent's sole active delivered incoming Request. After the operation returns, the Answer is the terminal response to that Request. Do not add an assistant-message recap or summary. Unless another obligation or independent task remains, end the turn immediately. Leave passive waiting and later continuation to the runtime.

agent_message operation "send" creates no Answer expectation. Continue normally and poll only when Delivery proof matters.
</agent_message>`;

const AGENT_DELEGATION_PROMPT_GUIDE = `<agent_delegation>
When agent_message operation "request" or agent_spawn delegates work, partition it into bounded, non-overlapping work units before sending the Request.

Reuse an existing Agent with agent_message operation "request" only when context acquired through its earlier work materially reduces rediscovery. When useful, set contextPreparation with both workScale and contextDependence so the idle recipient can prepare a bounded working zone before Delivery. Omit it to keep ordinary Pi compaction behavior. Spawn a fresh Agent when prior context is not relevant to the new work.

After either tool returns requestMessageId with messageStatus "sent", the responder owns the delegated work until its Answer arrives or the Request is cancelled. Continue only explicitly disjoint work that would still be needed if the responder returned a complete, correct Answer. Otherwise end the turn. The runtime waits for turn-triggering input and continues the existing flow when it arrives. Intentional duplicate investigation is appropriate only when the Request explicitly asks for an independent cross-check.
</agent_delegation>`;

const AGENT_WAIT_PROMPT_GUIDE = `<agent_wait>
Use agent_wait only when one next decision requires every outstanding Answer together and avoiding one model turn per Answer matters. Do not use agent_wait to monitor ordinary progress. If strict fan-in is unnecessary, let ordinary Answer Delivery reactivate the Agent. Ordinary Messages do not satisfy Agent Requests. Do not poll merely to wait.

If agent_wait returns disposition "preempted", handle the delivered inbound Agent Request first. If one decision still requires every outstanding Answer, call agent_wait again afterward; preemption does not consume Answers or create Answer Delivery proof.
</agent_wait>`;

const AGENT_SPAWN_PROMPT_GUIDE = `<agent_spawn>
A successful agent_spawn returns spawnStatus "created", confirming that the child exists. Its Creation Request follows the shared Agent Delegation rules.

Use agent_spawn \`conversation: "fork"\` only for a cache-affine continuation of the completed current conversation. A conversation fork cannot select a template or provide config.
</agent_spawn>`;

const AGENT_CONTROL_PROMPT_GUIDE = `<agent_control>
agent_control operation "terminate" ends one exact Agent Run. It does not remove the durable Agent, cancel Agent Requests, affect descendants, or prevent a later successor Run. A terminate receipt's residualRequests reports the unresolved incoming and outgoing Request counts left on that Agent.

If termination abandons work from a Request you authored, use agent_message operation "cancel" with its requestMessageId before delegating replacement work or calling agent_wait. If the work remains needed, reactivate the same Agent with an ordinary Message instead. Do not assume Run termination resolves delegated work.
</agent_control>`;

export type AgentObservePhase = "starting" | "live" | "ending" | "dormant";

export type AgentObserveScope =
	| "authorized"
	| "direct_children"
	| Readonly<{ directSpawnerAgentId: string }>;

export type AgentSearchInput = Readonly<{
	operation: "search";
	scope: AgentObserveScope;
	query?: string;
	agentIdSuffix?: string;
	phase?: AgentObservePhase;
	limit?: number;
}>;

export type AgentObserveInput =
	| Readonly<{
		operation: "status";
		agentId?: string;
	}>
	| AgentSearchInput;

export type AgentSearchResult = Readonly<{
	matches: readonly AgentStatus[];
	hasMore: boolean;
}>;

export type AgentObserveResult = AgentStatus | AgentSearchResult;

type CommonParticipantCoordinationToolHandlers = Readonly<{
	message(
		toolCallId: string,
		input: AgentMessageInput,
	): Promise<AgentMessageReceipt>;
	wait(
		toolCallId: string,
		input: AgentWaitInput,
		signal: AbortSignal | undefined,
		onProgress?: (progress: AgentWaitProgress) => void,
	): Promise<AgentWaitResult>;
	observe(input: AgentObserveInput): Promise<AgentObserveResult>;
	control(
		toolCallId: string,
		input: RunControlInput,
	): Promise<RunControlReceipt>;
}>;

type SpawnParticipantCoordinationToolHandler = Readonly<{
	spawn(toolCallId: string, input: AgentSpawnInput): Promise<AgentSpawnReceipt>;
	agentTemplateSnapshot(): AgentTemplateCatalogueSnapshot | Promise<AgentTemplateCatalogueSnapshot>;
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

const contextPreparationParameters = Type.Object(
	{
		workScale: Type.Union([
			Type.Literal("small"),
			Type.Literal("medium"),
			Type.Literal("large"),
		]),
		contextDependence: Type.Union([
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
		]),
	},
	{ additionalProperties: false },
);

const agentMessageParameters = objectRootUnion(Type.Union([
	Type.Object(
		{
			operation: Type.Literal("send"),
			targetAgent: Type.String({
				minLength: 1,
				description: "Exact Agent label, full Agent ID, or unique Agent ID suffix",
			}),
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
			targetAgent: Type.String({
				minLength: 1,
				description: "Exact Agent label, full Agent ID, or unique Agent ID suffix",
			}),
			question: Type.String({ minLength: 1 }),
			deliveryMode: Type.Optional(
				Type.Union([
					Type.Literal("deferred"),
					Type.Literal("steer"),
				]),
			),
			contextPreparation: Type.Optional(contextPreparationParameters),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("answer"),
			answer: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("cancel"),
			requestMessageId: Type.String({ minLength: 1 }),
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

const agentWaitParameters = Type.Object({}, { additionalProperties: false });

const agentSpawnConfigurationParameters = Type.Object(
	{
		model: Type.Optional(
			Type.Object(
				{
					id: Type.Union([
						Type.String({ pattern: "^[^/]+/.+$" }),
						Type.Literal("inherit"),
					]),
					thinking: Type.Union([
						Type.Literal("off"),
						Type.Literal("minimal"),
						Type.Literal("low"),
						Type.Literal("medium"),
						Type.Literal("high"),
						Type.Literal("xhigh"),
						Type.Literal("max"),
						Type.Literal("inherit"),
					]),
				},
				{ additionalProperties: false },
			),
		),
		cwd: Type.Optional(Type.String({ minLength: 1 })),
		allowedTools: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
		),
		skills: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
		),
		extensions: Type.Optional(
			Type.Union([
				Type.Literal("inherit"),
				Type.Literal("none"),
			]),
		),
		systemPrompt: Type.Optional(Type.String()),
		systemPromptMode: Type.Optional(
			Type.Union([Type.Literal("append"), Type.Literal("replace")]),
		),
		inheritProjectContext: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const agentSpawnParameters = objectRootUnion(Type.Union([
	Type.Object(
		{
			request: Type.String({ minLength: 1 }),
			conversation: Type.Literal("fork"),
			label: Type.Optional(Type.String({ minLength: 1 })),
			description: Type.Optional(Type.String({ minLength: 1 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			request: Type.String({ minLength: 1 }),
			template: Type.Optional(
				Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
			),
			label: Type.Optional(Type.String({ minLength: 1 })),
			description: Type.Optional(Type.String({ minLength: 1 })),
			config: Type.Optional(agentSpawnConfigurationParameters),
		},
		{ additionalProperties: false },
	),
]));

const agentObservePhase = Type.Union([
	Type.Literal("starting"),
	Type.Literal("live"),
	Type.Literal("ending"),
	Type.Literal("dormant"),
]);
// The pattern only rejects whitespace-only inputs; search matching remains substring-based.
const agentSearchNonBlankString = Type.String({ minLength: 1, pattern: "\\S" });
const agentSearchOptionalProperties = {
	query: Type.Optional(agentSearchNonBlankString),
	agentIdSuffix: Type.Optional(agentSearchNonBlankString),
	phase: Type.Optional(agentObservePhase),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
};
const agentSearchDirectChildrenParameters = Type.Object(
	{
		operation: Type.Literal("search"),
		scope: Type.Literal("direct_children"),
		...agentSearchOptionalProperties,
	},
	{ additionalProperties: false },
);
const agentSearchNamedSpawnerParameters = Type.Object(
	{
		operation: Type.Literal("search"),
		scope: Type.Object(
			{ directSpawnerAgentId: agentSearchNonBlankString },
			{ additionalProperties: false },
		),
		...agentSearchOptionalProperties,
	},
	{ additionalProperties: false },
);
const agentSearchAuthorizedQueryParameters = Type.Object(
	{
		operation: Type.Literal("search"),
		scope: Type.Literal("authorized"),
		...agentSearchOptionalProperties,
		query: agentSearchNonBlankString,
	},
	{ additionalProperties: false },
);
const agentSearchAuthorizedSuffixParameters = Type.Object(
	{
		operation: Type.Literal("search"),
		scope: Type.Literal("authorized"),
		...agentSearchOptionalProperties,
		agentIdSuffix: agentSearchNonBlankString,
	},
	{ additionalProperties: false },
);
const agentSearchAuthorizedPhaseParameters = Type.Object(
	{
		operation: Type.Literal("search"),
		scope: Type.Literal("authorized"),
		...agentSearchOptionalProperties,
		phase: agentObservePhase,
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
	agentSearchDirectChildrenParameters,
	agentSearchNamedSpawnerParameters,
	agentSearchAuthorizedQueryParameters,
	agentSearchAuthorizedSuffixParameters,
	agentSearchAuthorizedPhaseParameters,
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
	agent_wait: agentWaitParameters,
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
	resolveAgentLabel: AgentLabelResolver = () => undefined,
	agentTemplateSnapshot?: AgentTemplateCatalogueSnapshot,
): void {
	const availableHandlers = handlers as AvailableHandlers;
	pi.registerTool<typeof agentMessageParameters, AgentMessageReceipt>({
		name: "agent_message",
		label: "Message Agent",
		description:
			"Send one immutable Message or correlated Request to a known Agent in this Workflow.",
		promptSnippet: "Send, request, answer, cancel, poll, or retry direct Agent communication.",
		promptGuidelines: [
			AGENT_MESSAGE_PROMPT_GUIDE,
			AGENT_DELEGATION_PROMPT_GUIDE,
		],
		executionMode: "sequential",
		parameters: agentMessageParameters,
		renderCall: (args, _theme, context) =>
			renderAgentMessageCall(args, _theme, resolveAgentLabel, context.expanded),
		renderResult: renderAgentMessageResult,
		async execute(toolCallId, parameters) {
			return toolResult(await availableHandlers.message(toolCallId, parameters));
		},
	});
	pi.registerTool<typeof agentWaitParameters, AgentWaitResult | AgentWaitProgress>({
		name: "agent_wait",
		label: "Wait for Answers",
		description:
			"Wait until every outstanding outbound Agent Request has a committed Answer, unless an inbound Agent Request preempts the wait for attention.",
		promptSnippet:
			"Join all outstanding Agent Request Answers unless an inbound Agent Request preempts the wait.",
		promptGuidelines: [AGENT_WAIT_PROMPT_GUIDE],
		executionMode: "sequential",
		parameters: agentWaitParameters,
		renderCall: renderAgentWaitCall,
		renderResult: (result, options, theme, context) =>
			renderAgentWaitResult(
				result,
				options,
				theme,
				context,
				resolveAgentLabel,
			),
		async execute(toolCallId, parameters, signal, onUpdate) {
			return toolResult(
				await availableHandlers.wait(
					toolCallId,
					parameters,
					signal,
					(progress) => onUpdate?.({
						content: [{
							type: "text",
							text: `Waiting for ${progress.waitingFor.length} Agent Answer${
								progress.waitingFor.length === 1 ? "" : "s"
							}.`,
						}],
						details: progress,
					}),
				),
			);
		},
	});
	if (role !== "moderator") {
		pi.registerTool<typeof agentSpawnParameters, AgentSpawnReceipt>({
			name: "agent_spawn",
			label: "Spawn Agent",
			description:
				"Create one fresh durable child Agent with isolated context or a cache-affine conversation fork, then deliver its initial Creation Request.",
			promptSnippet: "Create a fresh child Agent with isolated work or a cache-affine conversation fork.",
			promptGuidelines: [
				AGENT_SPAWN_PROMPT_GUIDE,
				AGENT_DELEGATION_PROMPT_GUIDE,
				...(agentTemplateSnapshot === undefined
					? []
					: [renderAgentTemplatePromptGuide(agentTemplateSnapshot)]),
			],
			executionMode: "sequential",
			parameters: agentSpawnParameters,
			renderCall: (args, theme, context) =>
				renderAgentSpawnCall(args, theme, context.expanded),
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
			? "Passively observe any known Agent in this Workflow or search authorized Agent scopes."
			: "Passively observe an authorized Agent or search its authorized Agent scope.",
		promptSnippet: role === "moderator"
			? "Pull bounded status or search results for Workflow Agents relevant to diagnosis."
			: "Observe exact status or search authorized Agents by metadata and Run phase.",
		executionMode: "sequential",
		parameters: agentObserveParameters,
		renderCall: (args, theme) =>
			renderAgentObserveCall(args, theme, resolveAgentLabel),
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
		promptGuidelines: [AGENT_CONTROL_PROMPT_GUIDE],
		executionMode: "sequential",
		parameters: agentControlParameters,
		renderCall: (args, theme) =>
			renderAgentControlCall(args, theme, resolveAgentLabel),
		renderResult: (result, options, theme) =>
			renderAgentControlResult(result, options, theme, resolveAgentLabel),
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
				"Renew an exact Operation Review interval or resolve handling after every mechanically checkable predicate clears. A Run Failure clears as soon as a successor Run starts; any remaining Answer Obligation is ordinary Workflow work.",
			promptSnippet:
				"Renew an exact reviewed call deliberately, or resolve immediately when the original condition clears.",
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
