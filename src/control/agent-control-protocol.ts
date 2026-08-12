import { Type, type Static, type TSchema } from "typebox";
import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";

import type { AgentControlProtocol } from "./agent-control-channel.ts";
import type { AgentMessageReceipt } from "../coordination/message-receipts.ts";
import type { AgentSpawnReceipt } from "../coordination/spawning.ts";
import type { AgentMessageInput } from "../protocol/agent-message-input.ts";
import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import type { HumanAnswer, HumanRequestInput } from "../protocol/human-request.ts";
import type { ModeratorControlInput, ModeratorControlReceipt } from "../protocol/moderator-control.ts";
import type { RunControlInput, RunControlReceipt } from "../protocol/run-control.ts";
import {
	participantCoordinationToolSchemas,
	type AgentObserveInput,
	type AgentObserveResult,
} from "../tools/participant-coordination-tools.ts";

const closed = <const P extends Parameters<typeof Type.Object>[0]>(properties: P) =>
	Type.Object(properties, { additionalProperties: false });
const EmptySchema = closed({});
const NonEmptyStringSchema = Type.String({ minLength: 1 });
const StringListSchema = Type.Array(NonEmptyStringSchema, { uniqueItems: true });
const StringQueueSchema = Type.Array(Type.String());
const AcknowledgementSchema = closed({ accepted: Type.Boolean() });
const QueuedInputCountSchema = Type.Integer({ minimum: 0 });
const RunOutcomeSchema = Type.Union([
	Type.Literal("completed"),
	Type.Literal("interrupted"),
	Type.Literal("failed"),
]);
const DeliveryModeSchema = Type.Union([
	Type.Literal("steer"),
	Type.Literal("followUp"),
]);
const TextContentSchema = closed({
	type: Type.Literal("text"),
	text: Type.String(),
	textSignature: Type.Optional(Type.String()),
});
const ImageContentSchema = closed({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: NonEmptyStringSchema,
});
const ImageListSchema = Type.Array(ImageContentSchema);
const EmptyResponseSchema = closed({});
const EntryPointerSchema = closed({
	agentId: NonEmptyStringSchema,
	entryId: NonEmptyStringSchema,
});
const ToolCallPointerSchema = closed({
	agentId: NonEmptyStringSchema,
	entryId: NonEmptyStringSchema,
	toolCallId: NonEmptyStringSchema,
});
const ToolContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);
const ThinkingContentSchema = closed({
	type: Type.Literal("thinking"),
	thinking: Type.String(),
	thinkingSignature: Type.Optional(Type.String()),
	redacted: Type.Optional(Type.Boolean()),
});
const NativeToolCallSchema = closed({
	type: Type.Literal("toolCall"),
	id: NonEmptyStringSchema,
	name: NonEmptyStringSchema,
	arguments: Type.Record(Type.String(), Type.Unknown()),
	thoughtSignature: Type.Optional(Type.String()),
});
const UsageSchema = closed({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	cacheWrite1h: Type.Optional(Type.Number()),
	reasoning: Type.Optional(Type.Number()),
	totalTokens: Type.Number(),
	cost: closed({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		total: Type.Number(),
	}),
});
const AgentMessageSchema = Type.Unsafe<MessageEndEvent["message"]>(Type.Union([
	closed({
		role: Type.Literal("user"),
		content: Type.Union([Type.String(), Type.Array(ToolContentSchema)]),
		timestamp: Type.Number(),
	}),
	closed({
		role: Type.Literal("assistant"),
		content: Type.Array(Type.Union([TextContentSchema, ThinkingContentSchema, NativeToolCallSchema])),
		api: NonEmptyStringSchema,
		provider: NonEmptyStringSchema,
		model: NonEmptyStringSchema,
		responseModel: Type.Optional(Type.String()),
		responseId: Type.Optional(Type.String()),
		diagnostics: Type.Optional(Type.Array(Type.Unknown())),
		usage: UsageSchema,
		stopReason: Type.Union([
			Type.Literal("pending"), Type.Literal("stop"), Type.Literal("length"),
			Type.Literal("toolUse"), Type.Literal("error"), Type.Literal("aborted"),
			Type.Literal("deferred"),
		]),
		deferred: Type.Optional(Type.Unknown()),
		errorMessage: Type.Optional(Type.String()),
		rawStopReason: Type.Optional(Type.String()),
		timestamp: Type.Number(),
	}),
	closed({
		role: Type.Literal("toolResult"),
		toolCallId: NonEmptyStringSchema,
		toolName: NonEmptyStringSchema,
		content: Type.Array(ToolContentSchema),
		details: Type.Optional(Type.Unknown()),
		usage: Type.Optional(UsageSchema),
		addedToolNames: Type.Optional(StringListSchema),
		isError: Type.Boolean(),
		timestamp: Type.Number(),
	}),
	closed({
		role: Type.Literal("bashExecution"),
		command: Type.String(),
		output: Type.String(),
		exitCode: Type.Optional(Type.Integer()),
		cancelled: Type.Boolean(),
		truncated: Type.Boolean(),
		fullOutputPath: Type.Optional(Type.String()),
		timestamp: Type.Number(),
		excludeFromContext: Type.Optional(Type.Boolean()),
	}),
	closed({
		role: Type.Literal("custom"),
		customType: NonEmptyStringSchema,
		content: Type.Union([Type.String(), Type.Array(ToolContentSchema)]),
		display: Type.Boolean(),
		details: Type.Optional(Type.Unknown()),
		timestamp: Type.Number(),
	}),
	closed({
		role: Type.Literal("branchSummary"),
		summary: Type.String(),
		fromId: NonEmptyStringSchema,
		timestamp: Type.Number(),
	}),
	closed({
		role: Type.Literal("compactionSummary"),
		summary: Type.String(),
		tokensBefore: Type.Number(),
		timestamp: Type.Number(),
	}),
]));
const GuardedHumanToolResultSchema = closed({
	message: Type.Optional(AgentMessageSchema),
	rejectedAnswer: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
});
const RetentionReasonSchema = Type.Union([
	Type.Literal("owner_host_binding"), Type.Literal("pending_delivery"),
	Type.Literal("awaiting_answer"), Type.Literal("answer_owed"),
	Type.Literal("interruption_hold"), Type.Literal("moderator_handling"),
	Type.Literal("interactive_selection"),
]);
const RetentionSchema = closed({ reason: RetentionReasonSchema, count: Type.Integer({ minimum: 1 }) });
const AgentRunStateSchema = Type.Union([
	closed({ phase: Type.Literal("dormant"), retentionReasons: Type.Tuple([]) }),
	closed({
		phase: Type.Union([Type.Literal("starting"), Type.Literal("live"), Type.Literal("ending")]),
		work: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("settled")])),
		attention: Type.Union([Type.Literal("none"), Type.Literal("input_required")]),
		retentionReasons: Type.Array(RetentionSchema),
	}),
]);
const AgentStatusProperties = {
	agentId: NonEmptyStringSchema,
	workflowId: NonEmptyStringSchema,
	label: NonEmptyStringSchema,
	description: Type.Optional(Type.String()),
	directSpawnerAgentId: Type.Union([NonEmptyStringSchema, Type.Null()]),
	primaryEvidence: closed({
		transcriptPath: Type.Union([NonEmptyStringSchema, Type.Null()]),
		inspectedThrough: EntryPointerSchema,
	}),
	run: AgentRunStateSchema,
} as const;
const AgentStatusSchema = closed(AgentStatusProperties);
const RuntimeThinkingSchema = Type.Union([
	Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"),
	Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
]);
const AgentRosterStatusSchema = closed({
	...AgentStatusProperties,
	model: closed({ provider: NonEmptyStringSchema, modelId: NonEmptyStringSchema }),
	thinking: RuntimeThinkingSchema,
	queuedInputCount: QueuedInputCountSchema,
});
const AgentObserveResultSchema = Type.Union([
	AgentStatusSchema,
	closed({ children: Type.Array(AgentStatusSchema) }),
]);
const EffectiveConfigurationSchema = closed({
	cwd: NonEmptyStringSchema,
	model: closed({ provider: NonEmptyStringSchema, modelId: NonEmptyStringSchema }),
	thinking: Type.Union([
		Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"),
		Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
	]),
	tools: StringListSchema,
	skills: StringListSchema,
	extensions: StringListSchema,
	projectContext: Type.Optional(closed({
		mode: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
		body: Type.String(),
	})),
});
const AgentSpawnReceiptSchema = Type.Union([
	closed({
		disposition: Type.Literal("pending"), agentId: NonEmptyStringSchema,
		requestId: NonEmptyStringSchema, effectiveConfiguration: EffectiveConfigurationSchema,
	}),
	closed({
		disposition: Type.Literal("created_unscheduled"), agentId: NonEmptyStringSchema,
		requestId: NonEmptyStringSchema,
		failedStage: Type.Union([Type.Literal("run_start"), Type.Literal("delivery_admission")]),
		effectiveConfiguration: EffectiveConfigurationSchema,
	}),
	closed({ disposition: Type.Literal("not_created"), failedStage: Type.Literal("identity_commit") }),
	closed({
		disposition: Type.Literal("indeterminate"),
		agentId: Type.Optional(NonEmptyStringSchema), requestId: Type.Optional(NonEmptyStringSchema),
		lastConfirmedStage: Type.Optional(Type.Union([Type.Literal("identity"), Type.Literal("run_start")])),
		effectiveConfiguration: Type.Optional(EffectiveConfigurationSchema),
	}),
]);
const DeliveryStateProperties = {
	messageId: NonEmptyStringSchema,
	delivery: Type.Union([Type.Literal("pending"), Type.Literal("indeterminate")]),
} as const;
const RejectedDeliveryProperties = {
	messageId: NonEmptyStringSchema,
	delivery: Type.Literal("rejected"),
	rejectionReason: Type.Union([
		Type.Literal("target_unavailable"), Type.Literal("host_shutting_down"),
		Type.Literal("capacity_exhausted"),
	]),
} as const;
const AgentMessageReceiptSchema = Type.Union([
	closed(DeliveryStateProperties), closed(RejectedDeliveryProperties),
	closed({ ...DeliveryStateProperties, requestId: NonEmptyStringSchema }),
	closed({ ...RejectedDeliveryProperties, requestId: NonEmptyStringSchema }),
	closed({
		messageId: NonEmptyStringSchema, requestId: NonEmptyStringSchema,
		answerId: NonEmptyStringSchema, disposition: Type.Literal("already_answered"),
	}),
	closed({
		messageId: NonEmptyStringSchema, requestId: NonEmptyStringSchema,
		cancellationId: NonEmptyStringSchema, disposition: Type.Literal("already_cancelled"),
	}),
	closed({
		messageId: NonEmptyStringSchema, requestId: NonEmptyStringSchema,
		cancellationId: NonEmptyStringSchema,
		delivery: Type.Union([Type.Literal("pending"), Type.Literal("indeterminate")]),
	}),
	closed({
		messageId: NonEmptyStringSchema, requestId: NonEmptyStringSchema,
		cancellationId: NonEmptyStringSchema, delivery: Type.Literal("rejected"),
		rejectionReason: Type.Union([
			Type.Literal("target_unavailable"), Type.Literal("host_shutting_down"),
			Type.Literal("capacity_exhausted"),
		]),
	}),
	closed({
		disposition: Type.Literal("delivered"), messageId: NonEmptyStringSchema,
		deliveryEvidence: EntryPointerSchema,
	}),
	closed({
		disposition: Type.Literal("not_observed"), messageId: NonEmptyStringSchema,
		inspectedThrough: EntryPointerSchema,
	}),
	closed({
		disposition: Type.Literal("indeterminate"), messageId: NonEmptyStringSchema,
		reason: Type.Union([Type.Literal("inspection_incomplete"), Type.Literal("confirmation_lost")]),
	}),
	closed({ disposition: Type.Literal("pending"), messageId: NonEmptyStringSchema }),
	closed({
		disposition: Type.Literal("rejected"), messageId: NonEmptyStringSchema,
		rejectionReason: Type.Union([
			Type.Literal("target_unavailable"), Type.Literal("host_shutting_down"),
			Type.Literal("evidence_unavailable"), Type.Literal("policy_rejected"),
			Type.Literal("capacity_exhausted"),
		]),
	}),
	closed({
		disposition: Type.Literal("answer_delivered"), messageId: NonEmptyStringSchema,
		requestId: NonEmptyStringSchema, answerId: NonEmptyStringSchema,
		fromAgentId: NonEmptyStringSchema, answer: Type.String(), answerSource: ToolCallPointerSchema,
	}),
	closed({
		disposition: Type.Literal("answer_already_delivered"), messageId: NonEmptyStringSchema,
		requestId: NonEmptyStringSchema, answerId: NonEmptyStringSchema,
		deliveryEvidence: EntryPointerSchema,
	}),
	closed({
		disposition: Type.Literal("request_delivered"), messageId: NonEmptyStringSchema,
		requestId: NonEmptyStringSchema, deliveryEvidence: EntryPointerSchema,
	}),
	closed({
		disposition: Type.Literal("request_pending"), messageId: NonEmptyStringSchema,
		requestId: NonEmptyStringSchema,
	}),
]);
const RunControlReceiptSchema = Type.Union([
	closed({
		agentId: NonEmptyStringSchema,
		disposition: Type.Union([Type.Literal("held"), Type.Literal("already_held"), Type.Literal("not_running")]),
	}),
	closed({ agentId: NonEmptyStringSchema, messageId: NonEmptyStringSchema, delivery: Type.Literal("pending") }),
	closed({
		agentId: NonEmptyStringSchema, messageId: NonEmptyStringSchema, delivery: Type.Literal("rejected"),
		rejectionReason: Type.Union([
			Type.Literal("not_held"), Type.Literal("resume_slot_occupied"), Type.Literal("target_unavailable"),
		]),
	}),
	closed({
		agentId: NonEmptyStringSchema,
		disposition: Type.Union([Type.Literal("terminated"), Type.Literal("not_running")]),
		residualRequests: closed({ incoming: Type.Integer({ minimum: 0 }), outgoing: Type.Integer({ minimum: 0 }) }),
	}),
	closed({
		agentId: NonEmptyStringSchema, disposition: Type.Literal("rejected"),
		rejectionReason: Type.Literal("interactive_selection"),
	}),
]);
const HumanAnswerSchema = closed({ requestId: NonEmptyStringSchema, answer: NonEmptyStringSchema });
const ModeratorControlReceiptSchema = Type.Union([
	closed({
		disposition: Type.Literal("renewed"), toolCall: ToolCallPointerSchema,
		nextReviewInMs: Type.Integer({ minimum: 1 }),
	}),
	closed({ disposition: Type.Literal("stale"), toolCall: ToolCallPointerSchema }),
	closed({ disposition: Type.Literal("resolved") }),
	closed({ disposition: Type.Literal("already_cleared") }),
	closed({
		disposition: Type.Literal("blocked"),
		predicates: Type.Array(Type.Union([
			Type.Literal("incoming_requests"), Type.Literal("outgoing_requests"),
			Type.Literal("obligation_stall"), Type.Literal("run_failure"),
			Type.Literal("dependency_deadlock"), Type.Literal("operation_review"),
		])),
	}),
]);
const ToolIntention = <T extends TSchema>(input: T) => closed({
	toolCallId: NonEmptyStringSchema,
	input,
});
const AgentMessageInputSchema = Type.Unsafe<AgentMessageInput>(
	participantCoordinationToolSchemas.agent_message,
);
const AgentObserveInputSchema = Type.Unsafe<AgentObserveInput>(
	participantCoordinationToolSchemas.agent_observe,
);
const RunControlInputSchema = Type.Unsafe<RunControlInput>(
	participantCoordinationToolSchemas.agent_control,
);
const AgentSpawnInputSchema = Type.Unsafe<AgentSpawnInput>(
	participantCoordinationToolSchemas.agent_spawn,
);
const HumanRequestInputSchema = Type.Unsafe<HumanRequestInput>(
	participantCoordinationToolSchemas.ask_user_question,
);
const ModeratorControlInputSchema = Type.Unsafe<ModeratorControlInput>(
	participantCoordinationToolSchemas.moderator_control,
);
const AgentRuntimeDeliverySchema = Type.Union([
	closed({
		kind: Type.Literal("custom"),
		message: closed({
			customType: Type.Literal("agent-coordination.message-delivery"),
			content: Type.String(),
			display: Type.Literal(true),
			details: closed({
				messages: Type.Array(ToolCallPointerSchema, { minItems: 1, uniqueItems: true }),
			}),
		}),
		triggerTurn: Type.Literal(true),
		deliverAs: Type.Optional(DeliveryModeSchema),
	}),
	closed({
		kind: Type.Literal("user"),
		content: Type.Union([
			Type.String(),
			Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
		]),
		deliverAs: Type.Optional(DeliveryModeSchema),
	}),
]);

const ModeratorRequestSetSchema = closed({
	total: Type.Integer({ minimum: 0 }),
	sources: Type.Array(ToolCallPointerSchema, { uniqueItems: true }),
});
const ModeratorTriggerSchema = Type.Union([
	closed({
		kind: Type.Literal("obligation_stall"),
		agentId: NonEmptyStringSchema,
		obligations: ModeratorRequestSetSchema,
	}),
	closed({
		kind: Type.Literal("run_failure"),
		agentId: NonEmptyStringSchema,
		runSequence: Type.Integer({ minimum: 1 }),
		obligations: ModeratorRequestSetSchema,
	}),
	closed({
		kind: Type.Literal("dependency_deadlock"),
		agentIds: Type.Array(NonEmptyStringSchema, { minItems: 1, uniqueItems: true }),
		requests: ModeratorRequestSetSchema,
	}),
	closed({
		kind: Type.Literal("operation_review"),
		toolCall: ToolCallPointerSchema,
		reviewIntervalMs: Type.Integer({ minimum: 1 }),
	}),
]);
const HumanAttentionItemSchema = closed({
	requestId: NonEmptyStringSchema,
	agentId: NonEmptyStringSchema,
	agentLabel: NonEmptyStringSchema,
	question: Type.String(),
});
const OperationalIncidentAttentionSchema = closed({
	trigger: ModeratorTriggerSchema,
	affectedAgentIds: Type.Array(NonEmptyStringSchema, { minItems: 1, uniqueItems: true }),
	diagnostics: Type.Array(EntryPointerSchema, { uniqueItems: true }),
});
export const AgentSelectorActionSchema = Type.Union([
	closed({ kind: Type.Literal("select_agent"), agentId: NonEmptyStringSchema }),
	closed({
		kind: Type.Literal("decide"),
		requestId: NonEmptyStringSchema,
		agentId: NonEmptyStringSchema,
	}),
]);
export const AgentSelectorSnapshotSchema = closed({
	live: Type.Array(AgentRosterStatusSchema, { uniqueItems: true }),
	dormant: Type.Array(AgentRosterStatusSchema, { uniqueItems: true }),
	selectedAgentId: NonEmptyStringSchema,
	humanAttention: Type.Array(HumanAttentionItemSchema, { uniqueItems: true }),
	operationalAttention: Type.Array(OperationalIncidentAttentionSchema, { uniqueItems: true }),
});
type DeepReadonly<T> = T extends readonly []
	? readonly []
	: T extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
	: T extends object
		? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
		: T;
export type RemoteAgentSelectorAction = DeepReadonly<Static<typeof AgentSelectorActionSchema>>;
export type RemoteAgentSelectorSnapshot = DeepReadonly<Static<typeof AgentSelectorSnapshotSchema>>;
const RemoteAgentSelectorSnapshotSchema = Type.Unsafe<RemoteAgentSelectorSnapshot>(
	AgentSelectorSnapshotSchema,
);

export const RuntimeSnapshotSchema = closed({
	cwd: NonEmptyStringSchema,
	model: closed({ provider: NonEmptyStringSchema, modelId: NonEmptyStringSchema }),
	thinking: RuntimeThinkingSchema,
	tools: StringListSchema,
	skills: StringListSchema,
	skillSources: Type.Array(closed({ name: NonEmptyStringSchema, filePath: NonEmptyStringSchema })),
	extensions: StringListSchema,
	toolExecutionModes: Type.Array(closed({
		name: NonEmptyStringSchema,
		executionMode: Type.Union([Type.Literal("sequential"), Type.Literal("parallel")]),
	})),
	projectTrusted: Type.Boolean(),
	sessionId: NonEmptyStringSchema,
	sessionPath: NonEmptyStringSchema,
	projectContext: Type.Union([
		Type.Null(),
		closed({ filePath: NonEmptyStringSchema, body: Type.String() }),
	]),
});

/** Bridge-proven version-one method payload/result map. */
export const agentControlMethods = {
	"runtime.snapshot": { request: EmptySchema, response: RuntimeSnapshotSchema },
	"runtime.executionBegin": { request: EmptySchema, response: EmptyResponseSchema },
	"runtime.humanInput": {
		request: closed({ text: Type.String(), images: Type.Optional(ImageListSchema) }),
		response: closed({ resumed: Type.Boolean() }),
	},
	"runtime.humanInputMode": {
		request: EmptySchema,
		response: closed({ mode: Type.Union([Type.Literal("agent"), Type.Literal("answer")]) }),
	},
	"runtime.guardHumanToolResult": {
		request: closed({ message: AgentMessageSchema }),
		response: closed({ result: Type.Union([GuardedHumanToolResultSchema, Type.Null()]) }),
	},
	"runtime.toolExecutionStart": {
		request: closed({ toolCallId: NonEmptyStringSchema, toolName: NonEmptyStringSchema }),
		response: EmptyResponseSchema,
	},
	"runtime.safeBoundary": { request: EmptySchema, response: EmptyResponseSchema },
	"runtime.executionEnd": { request: EmptySchema, response: EmptyResponseSchema },
	"coordination.observe": {
		request: AgentObserveInputSchema,
		response: Type.Unsafe<AgentObserveResult>(AgentObserveResultSchema),
	},
	"coordination.message": {
		request: ToolIntention(AgentMessageInputSchema),
		response: Type.Unsafe<AgentMessageReceipt>(AgentMessageReceiptSchema),
	},
	"coordination.control": {
		request: ToolIntention(RunControlInputSchema),
		response: Type.Unsafe<RunControlReceipt>(RunControlReceiptSchema),
	},
	"coordination.spawn": {
		request: ToolIntention(AgentSpawnInputSchema),
		response: Type.Unsafe<AgentSpawnReceipt>(AgentSpawnReceiptSchema),
	},
	"coordination.askHuman": {
		request: ToolIntention(HumanRequestInputSchema),
		response: Type.Unsafe<HumanAnswer>(HumanAnswerSchema),
	},
	"coordination.moderatorControl": {
		request: ToolIntention(ModeratorControlInputSchema),
		response: Type.Unsafe<ModeratorControlReceipt>(ModeratorControlReceiptSchema),
	},
	"presentation.agents.snapshot": {
		request: EmptySchema,
		response: AgentSelectorSnapshotSchema,
	},
	"presentation.agents.select": {
		request: AgentSelectorActionSchema,
		response: EmptyResponseSchema,
	},
	"presentation.reinitialize": {
		request: EmptySchema,
		response: EmptyResponseSchema,
	},
	"run.prompt": {
		request: closed({
			runId: NonEmptyStringSchema,
			input: Type.String(),
			kind: Type.Union([Type.Literal("initial"), Type.Literal("successor")]),
		}),
		response: AcknowledgementSchema,
	},
	"message.deliver": {
		request: closed({
			runId: NonEmptyStringSchema,
			delivery: AgentRuntimeDeliverySchema,
		}),
		response: closed({
			accepted: Type.Boolean(),
			transcriptCommitted: Type.Boolean(),
			modelCycleStarted: Type.Boolean(),
			queuedInputCount: QueuedInputCountSchema,
		}),
	},
	"run.continue": {
		request: closed({ runId: NonEmptyStringSchema }),
		response: AcknowledgementSchema,
	},
	"queue.clear": {
		request: closed({ runId: NonEmptyStringSchema }),
		response: closed({
			steering: StringQueueSchema,
			followUp: StringQueueSchema,
			queuedInputCount: QueuedInputCountSchema,
		}),
	},
	"run.interrupt": {
		request: closed({ runId: NonEmptyStringSchema }),
		response: AcknowledgementSchema,
	},
	"runtime.shutdown": {
		request: closed({ reason: Type.Optional(Type.String()) }),
		response: AcknowledgementSchema,
	},
} as const satisfies AgentControlProtocol["methods"];

/** Bridge-proven version-one event payload map. */
export const agentControlEvents = {
	"runtime.ready": {
		payload: closed({ sessionId: NonEmptyStringSchema, mode: Type.Literal("tui"), hasUI: Type.Literal(true) }),
	},
	"agent.start": {
		payload: closed({
			runId: NonEmptyStringSchema,
			queuedInputCount: QueuedInputCountSchema,
		}),
	},
	"agent.end": {
		payload: closed({
			runId: NonEmptyStringSchema,
			outcome: RunOutcomeSchema,
			willRetry: Type.Boolean(),
			queuedInputCount: QueuedInputCountSchema,
			error: Type.Optional(Type.String()),
		}),
	},
	"agent.settled": {
		payload: closed({
			runId: NonEmptyStringSchema,
			outcome: RunOutcomeSchema,
			queuedInputCount: QueuedInputCountSchema,
		}),
	},
	"presentation.agents.changed": { payload: RemoteAgentSelectorSnapshotSchema },
	"session.shutdown": { payload: closed({ reason: Type.Optional(Type.String()) }) },
	"runtime.fault": {
		payload: closed({ code: NonEmptyStringSchema, message: Type.String() }),
	},
} as const satisfies AgentControlProtocol["events"];

export const agentControlProtocol = {
	methods: agentControlMethods,
	events: agentControlEvents,
} as const satisfies AgentControlProtocol;

export const AgentControlMethodSchema = Type.Union(
	Object.keys(agentControlMethods).map((method) => Type.Literal(method)),
);
export const AgentControlEventSchema = Type.Union(
	Object.keys(agentControlEvents).map((event) => Type.Literal(event)),
);

export type AgentControlMethod = keyof typeof agentControlMethods;
export type AgentControlEvent = keyof typeof agentControlEvents;
