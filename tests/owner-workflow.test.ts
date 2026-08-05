import assert from "node:assert/strict";
import test from "node:test";

import piAgentCoordination from "../src/index.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

test("interactive Pi boots one observable Owner while preserving native interaction and disposal", async () => {
	const host = await createTestOwnerHost(piAgentCoordination);
	const ownerIdentity = host.session.sessionManager
		.getEntries()
		.find(
			(entry) => entry.type === "custom" && entry.customType === "agent-coordination.identity",
		);
	assert.ok(ownerIdentity && ownerIdentity.type === "custom");
	assert.deepEqual(ownerIdentity.data, {
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
	});

	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const statusResult = await observe.execute(
		"observe-owner",
		{ operation: "status" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(statusResult.details, {
		agentId: host.session.sessionId,
		workflowId: host.session.sessionId,
		label: "owner",
		directSpawnerAgentId: null,
			run: {
				phase: "live",
				work: "settled",
				attention: "none",
				retentionReasons: [{ reason: "owner_host_binding", count: 1 }],
			},
		});

	await host.session.prompt("/agents");
	assert.deepEqual(host.ui.agentViews, [
		{
			title: "Agents",
			options: [
				`owner · ${host.session.sessionId} · live/settled · owner host binding`,
			],
		},
	]);

	await host.session.prompt("Keep native Pi behavior authoritative.");
	await host.session.waitForIdle();
	assert.equal(
		host.session.messages.some(
			(message) =>
				message.role === "assistant" &&
				message.content.some(
					(part) => part.type === "text" && part.text === "Owner interaction preserved.",
				),
		),
		true,
	);

	const originalDispose = host.session.dispose.bind(host.session);
	let disposeCalls = 0;
	host.session.dispose = () => {
		disposeCalls += 1;
		originalDispose();
	};
	await Promise.all([host.runtime.dispose(), host.runtime.dispose()]);
	await host.runtime.dispose();
	assert.equal(disposeCalls, 1);
});
