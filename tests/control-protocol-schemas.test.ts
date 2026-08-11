import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import {
	AgentControlEventSchema,
	agentControlEvents,
	AgentControlMethodSchema,
	agentControlMethods,
	RuntimeSnapshotSchema,
} from "../src/control/agent-control-protocol.ts";
import {
	ChildProcessBootstrapSchema,
	ControlEndpointSchema,
	ControlFrameSchema,
	validateChildProcessBootstrap,
} from "../src/control/control-protocol-schemas.ts";

const identity = { protocolVersion: 1, workflowId: "workflow", agentId: "agent" } as const;

test("Control Endpoint and child bootstrap descriptors are closed and versioned", () => {
	const endpoint = { transport: "unix", address: "/tmp/control.sock" } as const;
	const bootstrap = {
		protocolVersion: 1,
		endpoint,
		connectionToken: "token",
		workflowId: "workflow",
		agentId: "agent",
		role: "ordinary",
		expectedSessionId: "session",
	} as const;
	assert.equal(Check(ControlEndpointSchema, endpoint), true);
	assert.deepEqual(validateChildProcessBootstrap(bootstrap), bootstrap);
	assert.equal(Check(ChildProcessBootstrapSchema, { ...bootstrap, protocolVersion: 2 }), false);
	assert.equal(Check(ChildProcessBootstrapSchema, { ...bootstrap, unixPath: endpoint.address }), false);
	assert.equal(Check(ControlEndpointSchema, { ...endpoint, extra: true }), false);
});

test("Control frame schema is a closed hello/request/response/event/cancel union", () => {
	const frames = [
		{ ...identity, type: "hello", connectionToken: "token", expectedSessionId: "session" },
		{ ...identity, type: "request", requestId: "1", method: "runtime.snapshot", payload: {} },
		{ ...identity, type: "response", requestId: "1", ok: true, result: {} },
		{ ...identity, type: "response", requestId: "1", ok: false, error: { code: "failed", message: "no" } },
		{ ...identity, type: "event", sequence: 1, event: "runtime.ready", payload: {} },
		{ ...identity, type: "cancel", requestId: "1" },
	];
	for (const frame of frames) assert.equal(Check(ControlFrameSchema, frame), true);
	assert.equal(Check(ControlFrameSchema, { ...frames[1], unexpected: true }), false);
	assert.equal(Check(ControlFrameSchema, { ...identity, type: "response", requestId: "1", ok: true }), false);
	assert.equal(Check(ControlFrameSchema, {
		...identity,
		type: "response",
		requestId: "1",
		ok: false,
		error: { code: "failed", message: "no" },
		result: {},
	}), false);
});

test("every version-one method and event has TypeBox payload/result schemas", () => {
	assert.deepEqual(Object.keys(agentControlMethods), [
		"runtime.snapshot",
		"runtime.executionBegin",
		"runtime.humanInput",
		"runtime.humanInputMode",
		"runtime.guardHumanToolResult",
		"runtime.toolExecutionStart",
		"runtime.safeBoundary",
		"runtime.executionEnd",
		"coordination.observe",
		"coordination.message",
		"coordination.control",
		"coordination.spawn",
		"coordination.askHuman",
		"coordination.moderatorControl",
		"run.prompt",
		"message.deliver",
		"run.continue",
		"queue.clear",
		"run.interrupt",
		"runtime.shutdown",
	]);
	assert.deepEqual(Object.keys(agentControlEvents), [
		"runtime.ready",
		"agent.start",
		"agent.end",
		"agent.settled",
		"session.shutdown",
		"runtime.fault",
	]);
	assert.equal(Check(AgentControlMethodSchema, "runtime.snapshot"), true);
	assert.equal(Check(AgentControlMethodSchema, "message.deliver"), true);
	assert.equal(Check(AgentControlMethodSchema, "run.continue"), true);
	assert.equal(Check(AgentControlMethodSchema, "queue.clear"), true);
	assert.equal(Check(AgentControlMethodSchema, "run.interrupt"), true);
	assert.equal(Check(AgentControlMethodSchema, "runtime.unknown"), false);
	assert.equal(Check(AgentControlEventSchema, "agent.settled"), true);
	assert.equal(Check(AgentControlEventSchema, "agent.unknown"), false);
	for (const definition of Object.values(agentControlMethods)) {
		assert.equal(typeof definition.request, "object");
		assert.equal(typeof definition.response, "object");
	}
	for (const definition of Object.values(agentControlEvents)) {
		assert.equal(typeof definition.payload, "object");
	}
	assert.equal(Check(agentControlEvents["agent.start"].payload, {
		runId: "run-1",
		queuedInputCount: 1,
	}), true);
	assert.equal(Check(agentControlEvents["agent.end"].payload, {
		runId: "run-1",
		outcome: "interrupted",
		willRetry: false,
		queuedInputCount: 0,
	}), true);
	assert.equal(Check(agentControlEvents["agent.settled"].payload, {
		runId: "run-1",
		outcome: "interrupted",
		queuedInputCount: 0,
	}), true);
	assert.equal(Check(RuntimeSnapshotSchema, {
		cwd: "/project",
		model: { provider: "provider", modelId: "model" },
		thinking: "high",
		tools: ["read"],
		skills: [{ name: "review", filePath: "/skills/review/SKILL.md" }],
		extensions: ["/extensions/review.ts"],
		projectTrusted: true,
		sessionId: "session",
		sessionPath: "/sessions/session.jsonl",
		projectContext: null,
	}), true);
	assert.equal(Check(agentControlMethods["runtime.humanInput"].request, {
		text: "continue",
		images: [{ type: "image", data: "base64", mimeType: "image/png" }],
	}), true);
	assert.equal(Check(agentControlMethods["runtime.humanInput"].request, {
		text: "continue",
		extra: true,
	}), false);
	assert.equal(Check(agentControlMethods["coordination.message"].request, {
		toolCallId: "call-message",
		input: { operation: "send", targetAgentId: "target", content: "hello" },
	}), true);
	assert.equal(Check(agentControlMethods["coordination.observe"].response, {
		children: [{
			agentId: "child",
			workflowId: "workflow",
			label: "Child",
			directSpawnerAgentId: "owner",
			primaryEvidence: {
				transcriptPath: null,
				inspectedThrough: { agentId: "child", entryId: "entry" },
			},
			run: { phase: "dormant", retentionReasons: [] },
		}],
	}), true);
	assert.equal(Check(agentControlMethods["coordination.observe"].response, {
		children: [{ agentId: "child" }],
	}), false);
	assert.equal(Check(agentControlMethods["message.deliver"].request, {
		runId: "run-1",
		delivery: {
			kind: "user",
			content: [
				{ type: "text", text: "Direction", textSignature: "signature" },
				{ type: "image", data: "base64", mimeType: "image/png" },
			],
			deliverAs: "steer",
		},
	}), true);
	assert.equal(Check(agentControlMethods["message.deliver"].request, {
		runId: "run-1",
		delivery: {
			kind: "custom",
			message: {
				customType: "agent-coordination.message-delivery",
				content: "{\"messages\":[]}",
				display: true,
				details: {
					messages: [{ agentId: "sender", entryId: "entry", toolCallId: "call" }],
				},
			},
			triggerTurn: true,
			deliverAs: "followUp",
		},
	}), true);
	assert.equal(Check(agentControlMethods["message.deliver"].request, {
		runId: "run-1",
		delivery: { kind: "user", content: "Direction", retry: true },
	}), false);
	assert.equal(Check(agentControlMethods["message.deliver"].response, {
		accepted: true,
		transcriptCommitted: true,
		modelCycleStarted: true,
		queuedInputCount: 0,
	}), true);
	assert.equal(Check(agentControlMethods["run.interrupt"].request, {}), false);
	assert.equal(Check(agentControlMethods["run.interrupt"].request, {
		runId: "run-1",
	}), true);
	assert.equal(Check(agentControlMethods["queue.clear"].request, {}), false);
	assert.equal(Check(agentControlMethods["queue.clear"].request, {
		runId: "run-1",
	}), true);
	assert.equal(Check(agentControlMethods["queue.clear"].response, {
		steering: ["one"],
		followUp: ["two"],
		queuedInputCount: 0,
	}), true);
});
