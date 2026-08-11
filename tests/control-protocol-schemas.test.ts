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
		"run.prompt",
		"message.deliver",
		"transcript.append",
		"queue.inspect",
		"queue.clear",
		"queue.restore",
		"run.interrupt",
		"runtime.shutdown",
		"coordination.spawn",
		"coordination.message",
		"coordination.observe",
		"coordination.control",
		"coordination.moderatorControl",
		"human.request",
		"agentView.acquire",
		"agentView.switch",
		"agentView.close",
		"agentView.input",
		"agentView.resize",
	]);
	assert.deepEqual(Object.keys(agentControlEvents), [
		"runtime.ready",
		"runtime.configurationChanged",
		"agent.start",
		"agent.end",
		"agent.settled",
		"session.infoChanged",
		"session.shutdown",
		"runtime.attentionChanged",
		"runtime.fault",
		"workflow.snapshot",
		"agentView.frame",
		"agentView.closed",
	]);
	assert.equal(Check(AgentControlMethodSchema, "runtime.snapshot"), true);
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
	assert.equal(Check(RuntimeSnapshotSchema, {
		cwd: "/project",
		model: { provider: "provider", modelId: "model" },
		thinking: "high",
		tools: ["read"],
		skills: [],
		extensions: [],
		sessionId: "session",
	}), true);
});
