import { Type } from "typebox";

import type { AgentControlProtocol } from "./agent-control-channel.ts";

const closed = <const P extends Parameters<typeof Type.Object>[0]>(properties: P) =>
	Type.Object(properties, { additionalProperties: false });
const EmptySchema = closed({});
const NonEmptyStringSchema = Type.String({ minLength: 1 });
const StringListSchema = Type.Array(NonEmptyStringSchema, { uniqueItems: true });
const AcknowledgementSchema = closed({ accepted: Type.Boolean() });
const DeliverySemanticsSchema = Type.Union([
	Type.Literal("steer"),
	Type.Literal("followUp"),
	Type.Literal("nextTurn"),
]);
const RunOutcomeSchema = Type.Union([
	Type.Literal("completed"),
	Type.Literal("interrupted"),
	Type.Literal("failed"),
]);

export const RuntimeSnapshotSchema = closed({
	cwd: NonEmptyStringSchema,
	model: closed({ provider: NonEmptyStringSchema, modelId: NonEmptyStringSchema }),
	thinking: Type.Union([
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
		Type.Literal("max"),
	]),
	tools: StringListSchema,
	skills: StringListSchema,
	extensions: StringListSchema,
	sessionId: NonEmptyStringSchema,
});

const QueuedDeliverySchema = closed({
	deliveryId: NonEmptyStringSchema,
	content: Type.String(),
	semantics: DeliverySemanticsSchema,
});
const QueueSnapshotSchema = closed({
	deliveries: Type.Array(QueuedDeliverySchema),
});

/**
 * Version-one method payload/result map. Direction is determined by which side
 * installs a handler; the framing layer remains fully symmetric.
 */
export const agentControlMethods = {
	"runtime.snapshot": { request: EmptySchema, response: RuntimeSnapshotSchema },
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
			messageId: NonEmptyStringSchema,
			content: Type.String(),
			semantics: DeliverySemanticsSchema,
		}),
		response: AcknowledgementSchema,
	},
	"transcript.append": {
		request: closed({ customType: NonEmptyStringSchema, data: Type.Unknown() }),
		response: closed({ entryId: NonEmptyStringSchema }),
	},
	"queue.inspect": { request: EmptySchema, response: QueueSnapshotSchema },
	"queue.clear": { request: EmptySchema, response: QueueSnapshotSchema },
	"queue.restore": { request: QueueSnapshotSchema, response: AcknowledgementSchema },
	"run.interrupt": {
		request: closed({ runId: NonEmptyStringSchema }),
		response: AcknowledgementSchema,
	},
	"runtime.shutdown": {
		request: closed({ reason: Type.Optional(Type.String()) }),
		response: AcknowledgementSchema,
	},
	"coordination.spawn": {
		request: closed({ toolCallId: NonEmptyStringSchema, input: Type.Unknown() }),
		response: closed({ agentId: NonEmptyStringSchema }),
	},
	"coordination.message": {
		request: closed({ toolCallId: NonEmptyStringSchema, input: Type.Unknown() }),
		response: closed({ messageId: NonEmptyStringSchema, delivery: DeliverySemanticsSchema }),
	},
	"coordination.observe": {
		request: closed({ agentId: Type.Optional(NonEmptyStringSchema) }),
		response: closed({ snapshot: Type.Unknown() }),
	},
	"coordination.control": {
		request: closed({ toolCallId: NonEmptyStringSchema, input: Type.Unknown() }),
		response: closed({ receipt: Type.Unknown() }),
	},
	"coordination.moderatorControl": {
		request: closed({ toolCallId: NonEmptyStringSchema, input: Type.Unknown() }),
		response: closed({ receipt: Type.Unknown() }),
	},
	"human.request": {
		request: closed({
			requestId: NonEmptyStringSchema,
			question: NonEmptyStringSchema,
		}),
		response: closed({ answer: NonEmptyStringSchema }),
	},
	"agentView.acquire": {
		request: closed({ agentId: NonEmptyStringSchema, generation: Type.Integer({ minimum: 1 }) }),
		response: AcknowledgementSchema,
	},
	"agentView.switch": {
		request: closed({ agentId: NonEmptyStringSchema, generation: Type.Integer({ minimum: 1 }) }),
		response: AcknowledgementSchema,
	},
	"agentView.close": {
		request: closed({ generation: Type.Integer({ minimum: 1 }) }),
		response: AcknowledgementSchema,
	},
	"agentView.input": {
		request: closed({ generation: Type.Integer({ minimum: 1 }), data: Type.String() }),
		response: AcknowledgementSchema,
	},
	"agentView.resize": {
		request: closed({
			generation: Type.Integer({ minimum: 1 }),
			columns: Type.Integer({ minimum: 1 }),
			rows: Type.Integer({ minimum: 1 }),
		}),
		response: AcknowledgementSchema,
	},
} as const satisfies AgentControlProtocol["methods"];

export const agentControlEvents = {
	"runtime.ready": {
		payload: closed({ sessionId: NonEmptyStringSchema, mode: Type.Literal("tui"), hasUI: Type.Literal(true) }),
	},
	"runtime.configurationChanged": { payload: RuntimeSnapshotSchema },
	"agent.start": { payload: closed({ runId: NonEmptyStringSchema }) },
	"agent.end": {
		payload: closed({
			runId: NonEmptyStringSchema,
			outcome: RunOutcomeSchema,
			error: Type.Optional(Type.String()),
		}),
	},
	"agent.settled": { payload: closed({ runId: NonEmptyStringSchema, outcome: RunOutcomeSchema }) },
	"session.infoChanged": { payload: closed({ sessionId: NonEmptyStringSchema }) },
	"session.shutdown": { payload: closed({ reason: Type.Optional(Type.String()) }) },
	"runtime.attentionChanged": { payload: closed({ needsAttention: Type.Boolean() }) },
	"runtime.fault": {
		payload: closed({ code: NonEmptyStringSchema, message: Type.String() }),
	},
	"workflow.snapshot": { payload: closed({ revision: Type.Integer({ minimum: 0 }), snapshot: Type.Unknown() }) },
	"agentView.frame": {
		payload: closed({
			generation: Type.Integer({ minimum: 1 }),
			sequence: Type.Integer({ minimum: 1 }),
			frame: Type.Unknown(),
		}),
	},
	"agentView.closed": {
		payload: closed({ generation: Type.Integer({ minimum: 1 }), reason: Type.Optional(Type.String()) }),
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
