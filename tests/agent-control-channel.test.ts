import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";

import {
	FramedAgentControlChannel,
	type AgentControlProtocol,
} from "../src/control/agent-control-channel.ts";
import { createInMemoryControlTransportPair } from "../src/control/in-memory-control-transport.ts";

const echoProtocol = {
	methods: {
		"test.echo": {
			request: Type.Object(
				{ value: Type.String() },
				{ additionalProperties: false },
			),
			response: Type.Object(
				{ echoed: Type.String() },
				{ additionalProperties: false },
			),
		},
	},
	events: {},
} as const satisfies AgentControlProtocol;

const identity = {
	protocolVersion: 1 as const,
	workflowId: "workflow-control-channel",
	agentId: "agent-control-channel",
};

test("Control Channel correlates one validated request across a transport-neutral byte stream", async (t) => {
	const [ownerTransport, childTransport] = createInMemoryControlTransportPair();
	const owner = new FramedAgentControlChannel({
		identity,
		protocol: echoProtocol,
		transport: ownerTransport,
	});
	const child = new FramedAgentControlChannel({
		identity,
		protocol: echoProtocol,
		transport: childTransport,
	});
	t.after(async () => {
		await Promise.all([owner.close(), child.close()]);
	});

	child.onRequest(async ({ method, payload }) => {
		assert.equal(method, "test.echo");
		assert.deepEqual(payload, { value: "process boundary" });
		return { echoed: payload.value };
	});

	assert.deepEqual(
		await owner.request("test.echo", { value: "process boundary" }),
		{ echoed: "process boundary" },
	);
});
