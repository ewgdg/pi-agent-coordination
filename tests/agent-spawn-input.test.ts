import assert from "node:assert/strict";
import test from "node:test";

import { validateAgentSpawnInput } from "../src/protocol/agent-spawn-input.ts";

test("Agent Spawn accepts an unconfigured conversation fork", () => {
	assert.deepEqual(validateAgentSpawnInput({
		request: "Continue from the spawning conversation.",
		conversation: "fork",
		label: "continuation",
	}), {
		request: "Continue from the spawning conversation.",
		conversation: "fork",
		label: "continuation",
	});
});

test("conversation fork rejects Template and Runtime configuration inputs", () => {
	assert.throws(
		() => validateAgentSpawnInput({
			request: "Do not change the forked prompt lineage.",
			conversation: "fork",
			template: "reviewer",
		}),
		/conversation fork cannot select an Agent Template/,
	);
	assert.throws(
		() => validateAgentSpawnInput({
			request: "Do not change the forked prompt lineage.",
			conversation: "fork",
			config: { allowed_tools: ["read"] },
		}),
		/conversation fork cannot provide Runtime configuration/,
	);
});

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

test("Agent Spawn validates independent system-prompt and project-context controls", () => {
	assert.deepEqual(validateAgentSpawnInput({
		request: "Use the native project instructions with a focused prompt.",
		config: {
			systemPrompt: "Focus on the assigned task.",
			systemPromptMode: "append",
			inheritProjectContext: true,
		},
	}), {
		request: "Use the native project instructions with a focused prompt.",
		config: {
			systemPrompt: "Focus on the assigned task.",
			systemPromptMode: "append",
			inheritProjectContext: true,
		},
	});
	assert.throws(
		() => validateAgentSpawnInput({
			request: "A prompt mode needs a prompt body.",
			config: { systemPromptMode: "replace" },
		}),
		/systemPromptMode requires systemPrompt/,
	);
	assert.throws(
		() => validateAgentSpawnInput({
			request: "The aggregate context fields are obsolete.",
			config: { projectContext: "obsolete" },
		}),
		/invalid shape/,
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
