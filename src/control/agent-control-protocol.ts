import { Type } from "typebox";

import type { AgentControlProtocol } from "./agent-control-channel.ts";

const closed = <const P extends Parameters<typeof Type.Object>[0]>(properties: P) =>
	Type.Object(properties, { additionalProperties: false });
const EmptySchema = closed({});
const NonEmptyStringSchema = Type.String({ minLength: 1 });
const StringListSchema = Type.Array(NonEmptyStringSchema, { uniqueItems: true });
const AcknowledgementSchema = closed({ accepted: Type.Boolean() });
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

/** Bridge-proven version-one method payload/result map. */
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
	"agent.start": { payload: closed({ runId: NonEmptyStringSchema }) },
	"agent.end": {
		payload: closed({
			runId: NonEmptyStringSchema,
			outcome: RunOutcomeSchema,
			error: Type.Optional(Type.String()),
		}),
	},
	"agent.settled": { payload: closed({ runId: NonEmptyStringSchema, outcome: RunOutcomeSchema }) },
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
