import assert from "node:assert/strict";
import test from "node:test";

import { validateAgentSpawnInput } from "../src/protocol/agent-spawn-input.ts";

test("Agent Spawn rejects extension path arrays at input validation", () => {
	assert.throws(
		() => validateAgentSpawnInput({
			request: "Inspect the child Runtime.",
			config: { extensions: ["/extensions/arbitrary.ts"] },
		}),
		/Agent Spawn config\.extensions must be "inherit" or "none"/,
	);
});
