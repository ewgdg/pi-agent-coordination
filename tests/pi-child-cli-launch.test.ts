import assert from "node:assert/strict";
import test from "node:test";

import { buildPiChildCliLaunch } from "../src/process-runtime/pi-child-cli-launch.ts";

test("Pi child CLI launch uses the exact session and immutable explicit resources", () => {
	assert.deepEqual(
		buildPiChildCliLaunch({
			cliPath: "/package/pi/dist/cli.js",
			sessionPath: "/sessions/child.jsonl",
			configuration: {
				cwd: "/work/project",
				model: { provider: "anthropic", modelId: "claude-test" },
				thinking: "high",
				allowedTools: ["read", "agent_message", "agent_spawn"],
				skills: ["review", "testing"],
				extensions: ["/extensions/first.ts", "/extensions/second.ts"],
			},
			skillPaths: ["/skills/review/SKILL.md", "/skills/testing/SKILL.md"],
			bridgeExtensionPath: "/package/src/process-runtime/child-runtime-bridge.ts",
			inputExtensionPath: "/package/src/process-runtime/child-runtime-input.ts",
			contextArtifactPath: "/runtime/child-project-context.md",
			projectTrusted: true,
		}),
		{
			command: process.execPath,
			cwd: "/work/project",
			arguments: [
				"/package/pi/dist/cli.js",
				"--session", "/sessions/child.jsonl",
				"--model", "anthropic/claude-test",
				"--thinking", "high",
				"--tools", "read,agent_message,agent_spawn",
				"--no-extensions",
				// The bridge must bind Control before inherited session_start handlers
				// can synchronously activate child work.
				"--extension", "/package/src/process-runtime/child-runtime-bridge.ts",
				"--extension", "/extensions/first.ts",
				"--extension", "/extensions/second.ts",
				// Input coordination runs after inherited extension preflights.
				"--extension", "/package/src/process-runtime/child-runtime-input.ts",
				"--no-skills",
				"--skill", "/skills/review/SKILL.md",
				"--skill", "/skills/testing/SKILL.md",
				"--no-context-files",
				"--append-system-prompt", "/runtime/child-project-context.md",
				"--approve",
				"--tui-mode", "fullscreen",
			],
		},
	);
});

test("Pi child CLI launch fails before spawn when resolved resources are ambiguous", () => {
	const common = {
		cliPath: "/package/pi/dist/cli.js",
		sessionPath: "/sessions/child.jsonl",
		configuration: {
			cwd: "/work/project",
			model: { provider: "anthropic", modelId: "claude-test" },
			thinking: "high" as const,
			allowedTools: ["read"],
			skills: ["review"],
			extensions: ["/extensions/first.ts"],
		},
		bridgeExtensionPath: "/package/src/process-runtime/child-runtime-bridge.ts",
		inputExtensionPath: "/package/src/process-runtime/child-runtime-input.ts",
		projectTrusted: false,
	};

	assert.throws(
		() => buildPiChildCliLaunch({ ...common, skillPaths: [] }),
		/skill path count/,
	);
	assert.throws(
		() => buildPiChildCliLaunch({
			...common,
			skillPaths: ["/skills/review/SKILL.md"],
			bridgeExtensionPath: "/extensions/first.ts",
		}),
		/bridge extension.*inherited extension/i,
	);
	assert.throws(
		() => buildPiChildCliLaunch({
			...common,
			skillPaths: ["/skills/review/SKILL.md"],
			inputExtensionPath: "/extensions/first.ts",
		}),
		/input extension.*inherited extension/i,
	);
});
