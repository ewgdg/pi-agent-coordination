import assert from "node:assert/strict";
import test from "node:test";

import { validateAgentSpawnInput } from "../src/protocol/agent-spawn-input.ts";

test("Agent Spawn accepts allowed_tools as the tool capability ceiling", () => {
	assert.deepEqual(validateAgentSpawnInput({
		request: "Inspect the child Runtime.",
		config: { allowed_tools: ["read", "extension_tool"] },
	}), {
		request: "Inspect the child Runtime.",
		config: { allowed_tools: ["read", "extension_tool"] },
	});
	assert.throws(
		() => validateAgentSpawnInput({
			request: "Do not retain the obsolete exact-tool field.",
			config: { tools: ["read"] },
		}),
		/invalid shape/,
	);
});

test("Agent Spawn rejects extension path arrays at input validation", () => {
	assert.throws(
		() => validateAgentSpawnInput({
			request: "Inspect the child Runtime.",
			config: { extensions: ["/extensions/arbitrary.ts"] },
		}),
		/Agent Spawn config\.extensions must be "inherit" or "none"/,
	);
});

test("Agent Spawn validates paired model overrides with explicit inheritance", () => {
	assert.deepEqual(validateAgentSpawnInput({
		request: "Use an explicit model with inherited thinking.",
		config: {
			model: { id: "provider/model", thinking: "inherit" },
		},
	}), {
		request: "Use an explicit model with inherited thinking.",
		config: {
			model: {
				id: "provider/model",
				thinking: "inherit",
			},
		},
	});
	assert.deepEqual(validateAgentSpawnInput({
		request: "Use an inherited model with explicit thinking.",
		config: {
			model: { id: "inherit", thinking: "max" },
		},
	}).config?.model, { id: "inherit", thinking: "max" });
	for (const model of [
		{ id: "provider/model" },
	]) {
		assert.throws(
			() => validateAgentSpawnInput({ request: "Invalid pair.", config: { model } }),
			/invalid shape/,
		);
	}
	assert.deepEqual(validateAgentSpawnInput({
		request: "Explicitly inherit both values.",
		config: { model: { id: "inherit", thinking: "inherit" } },
	}).config?.model, { id: "inherit", thinking: "inherit" });
	assert.throws(
		() => validateAgentSpawnInput({
			request: "Standalone thinking is obsolete.",
			config: { thinking: "high" },
		}),
		/invalid shape/,
	);
});
