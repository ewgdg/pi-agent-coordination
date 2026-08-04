import assert from "node:assert/strict";
import test from "node:test";

import piAgentCoordination from "../src/index.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";

test("an existing exact Owner Identity is validated without duplication", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	host.session.sessionManager.appendCustomEntry(
		"agent-coordination.identity",
		ownerIdentityFor(host),
	);

	await bindTestOwnerHost(host, "tui");

	assert.equal(
		host.session.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" && entry.customType === "agent-coordination.identity",
			).length,
		1,
	);
	assert.ok(host.session.getToolDefinition("agent_observe"));
	await host.runtime.dispose();
});

test("a child bootstrap cannot be reclassified as Workflow Owner", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	host.session.sessionManager.appendCustomEntry("agent-coordination.identity", {
		...ownerIdentityFor(host),
		workflowId: "workflow-owner",
		directSpawnerAgentId: "direct-spawner",
		spawnSource: {
			agentId: "direct-spawner",
			entryId: "assistant-entry",
			toolCallId: "spawn-call",
		},
	});

	await bindTestOwnerHost(host, "tui");
	assert.equal(
		host.ui.notifications.some(
			({ message, type }) =>
				type === "error" && message.includes("current Pi session is a child Agent"),
		),
		true,
	);
	assert.equal(host.session.getToolDefinition("agent_observe"), undefined);
	assert.equal(host.session.extensionRunner.getCommand("agents"), undefined);
	await host.runtime.dispose();
});

test("a Moderator bootstrap cannot be reclassified as Workflow Owner", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	host.session.sessionManager.appendCustomMessageEntry(
		"agent-coordination.moderator-input",
		"{}",
		true,
		{
			agentId: host.session.sessionId,
			workflowId: "workflow-owner",
			configuration: {
				label: "moderator",
				description: "run failure",
				baseline: ownerIdentityFor(host).configuration.baseline,
			},
		},
	);

	await bindTestOwnerHost(host, "tui");
	assert.equal(
		host.ui.notifications.some(
			({ message, type }) =>
				type === "error" && message.includes("current Pi session is a Moderator"),
		),
		true,
	);
	assert.equal(host.session.getToolDefinition("agent_observe"), undefined);
	assert.equal(host.session.extensionRunner.getCommand("agents"), undefined);
	await host.runtime.dispose();
});

function ownerIdentityFor(host: TestOwnerHost) {
	return {
		agentId: host.session.sessionId,
		workflowId: host.session.sessionId,
		directSpawnerAgentId: null,
		configuration: {
			label: "owner",
			baseline: {
				cwd: host.cwd,
				model: { provider: "coordination-test", modelId: "deterministic-owner" },
				thinking: "off",
				tools: [],
				skills: [],
				extensions: [],
			},
		},
	} as const;
}
