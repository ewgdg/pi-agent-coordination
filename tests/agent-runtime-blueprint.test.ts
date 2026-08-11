import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	commitAgentRuntimeBlueprint,
	resolveCommittedAgentRuntimeBlueprint,
	type AgentRuntimeBlueprint,
} from "../src/protocol/agent-runtime-blueprint.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/custom-entry-types.ts";

const blueprint: AgentRuntimeBlueprint = {
	agentId: "agent-blueprint",
	role: "ordinary",
	configuration: {
		cwd: "/workspace/project",
		model: { provider: "anthropic", modelId: "claude-test" },
		thinking: "high",
		tools: ["read", "agent_message", "agent_spawn"],
		skills: ["review"],
		extensions: ["/extensions/review.ts"],
		projectContext: { mode: "append", body: "Agent-specific constraints" },
	},
	projectTrusted: true,
	skillSources: [{ name: "review", path: "/skills/review/SKILL.md" }],
	agentsFiles: [
		{ path: "/workspace/AGENTS.md", content: "Project instructions" },
		{ path: "<agent-configuration:agent-blueprint>", content: "Agent-specific constraints" },
	],
};

test("prepared Agent Runtime blueprint is committed as immutable pre-launch evidence", () => {
	const transcript = SessionManager.inMemory("/workspace/project", {
		id: blueprint.agentId,
	});
	transcript.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: blueprint.agentId,
	});

	commitAgentRuntimeBlueprint(transcript, blueprint);

	assert.deepEqual(
		resolveCommittedAgentRuntimeBlueprint({
			sessionId: blueprint.agentId,
			entries: transcript.getEntries(),
		}),
		blueprint,
	);
	assert.throws(
		() => commitAgentRuntimeBlueprint(transcript, blueprint),
		/blueprint evidence already exists/,
	);
});

test("prepared Agent Runtime blueprint binds selected skill names to exact sources", () => {
	const malformed = {
		...blueprint,
		skillSources: [{ name: "other", path: "/skills/review/SKILL.md" }],
	};
	assert.throws(
		() => resolveCommittedAgentRuntimeBlueprint({
			sessionId: blueprint.agentId,
			entries: [{
				type: "custom",
				id: "blueprint-entry",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				customType: "agent-coordination.runtime-blueprint",
				data: malformed,
			}],
		}),
		/skill sources do not match selected skills/,
	);
});
