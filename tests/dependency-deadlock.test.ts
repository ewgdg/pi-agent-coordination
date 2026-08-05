import assert from "node:assert/strict";
import test from "node:test";

import { detectDependencyDeadlocks } from "../src/coordination/dependency-deadlock.ts";

test("closed dependency cycles normalize independently of input order", () => {
	const deadlocks = detectDependencyDeadlocks({
		eligibleAgentIds: ["delta", "charlie", "bravo", "alpha"],
		requests: [
			{ requestId: "request-bravo-alpha", fromAgentId: "bravo", targetAgentId: "alpha" },
			{ requestId: "request-charlie-self", fromAgentId: "charlie", targetAgentId: "charlie" },
			{ requestId: "request-delta-external", fromAgentId: "delta", targetAgentId: "external" },
			{ requestId: "request-alpha-bravo", fromAgentId: "alpha", targetAgentId: "bravo" },
		],
	});

	assert.deepEqual(deadlocks, [
		{
			agentIds: ["alpha", "bravo"],
			requestIds: ["request-alpha-bravo", "request-bravo-alpha"],
		},
		{
			agentIds: ["charlie"],
			requestIds: ["request-charlie-self"],
		},
	]);
});

test("an otherwise cyclic component is not closed across an external Request edge", () => {
	assert.deepEqual(
		detectDependencyDeadlocks({
			eligibleAgentIds: ["alpha", "bravo"],
			requests: [
				{ requestId: "alpha-bravo", fromAgentId: "alpha", targetAgentId: "bravo" },
				{ requestId: "bravo-alpha", fromAgentId: "bravo", targetAgentId: "alpha" },
				{ requestId: "external-alpha", fromAgentId: "external", targetAgentId: "alpha" },
			],
		}),
		[],
	);
	assert.deepEqual(
		detectDependencyDeadlocks({
			eligibleAgentIds: ["alpha", "bravo"],
			requests: [
				{ requestId: "alpha-bravo", fromAgentId: "alpha", targetAgentId: "bravo" },
				{ requestId: "bravo-alpha", fromAgentId: "bravo", targetAgentId: "alpha" },
				{ requestId: "alpha-external", fromAgentId: "alpha", targetAgentId: "external" },
			],
		}),
		[],
	);
});
