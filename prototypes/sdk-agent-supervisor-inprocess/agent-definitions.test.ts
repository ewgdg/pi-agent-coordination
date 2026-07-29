import assert from "node:assert/strict";
import test from "node:test";

import {
	getChildAgentDefinitions,
} from "./agent-definitions.ts";

test("the fixed prototype roster exposes direct children at each level", () => {
	assert.deepEqual(
		getChildAgentDefinitions("owner").map(({ key }) => key),
		["researcher", "builder"],
	);
	assert.deepEqual(
		getChildAgentDefinitions("researcher").map(({ key }) => key),
		["source-scout", "synthesizer"],
	);
	assert.deepEqual(
		getChildAgentDefinitions("builder").map(({ key }) => key),
		["reviewer"],
	);
	assert.deepEqual(getChildAgentDefinitions("source-scout"), []);
});
