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

test("only outgoing external dependencies open a waiting cycle", () => {
	assert.deepEqual(
		detectDependencyDeadlocks({
			eligibleAgentIds: ["alpha", "bravo"],
			requests: [
				{ requestId: "alpha-bravo", fromAgentId: "alpha", targetAgentId: "bravo" },
				{ requestId: "bravo-alpha", fromAgentId: "bravo", targetAgentId: "alpha" },
				{ requestId: "external-alpha", fromAgentId: "external", targetAgentId: "alpha" },
			],
		}),
		[{ agentIds: ["alpha", "bravo"], requestIds: ["alpha-bravo", "bravo-alpha"] }],
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

test("an upstream dependant cannot provide progress to a closed waiting cycle", () => {
	assert.deepEqual(detectDependencyDeadlocks({ eligibleAgentIds: ["child", "grandchild"], requests: [
		{ requestId: "root", fromAgentId: "owner", targetAgentId: "child" },
		{ requestId: "work", fromAgentId: "child", targetAgentId: "grandchild" },
		{ requestId: "reverse", fromAgentId: "grandchild", targetAgentId: "child" },
	]}), [{ agentIds: ["child", "grandchild"], requestIds: ["reverse", "work"] }]);
});
