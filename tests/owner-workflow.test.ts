import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const MAX_SESSION_DISCOVERY_ATTEMPTS = 1_000;

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
		primaryEvidence: {
			transcriptPath: null,
			inspectedThrough: {
				agentId: host.session.sessionId,
				entryId: ownerIdentity.id,
			},
		},
		run: {
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [
				{ reason: "owner_host_binding", count: 1 },
				{ reason: "interactive_selection", count: 1 },
			],
		},
	});

	await host.session.prompt("/agents");
	assert.deepEqual(host.ui.agentViews, [
		{
			title: "Agents",
			options: [
				`Live · owner · ${host.session.sessionId} · live/settled · owner host binding, interactive selection`,
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

test("native Owner replacement closes every retained source Workflow session", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("Remain retained until the Owner replaces its native session."),
	]);
	const spawnInput = { request: "Remain retained for native replacement." };
	const spawnToolCallId = "spawn-before-native-owner-replacement";
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: spawnToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(spawn);
	const spawnResult = await spawn.execute(
		spawnToolCallId,
		spawnInput,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const childAgentId = (spawnResult.details as { agentId: string }).agentId;

	host.ui.select = async (_title, options) =>
		options.find((option) => option.includes(childAgentId));
	await host.session.prompt("/agents");
	const childSession = host.runtime.session;
	const nativeChildDispose = childSession.dispose.bind(childSession);
	let childDisposeCalls = 0;
	childSession.dispose = () => {
		childDisposeCalls += 1;
		nativeChildDispose();
	};
	host.ui.select = async (_title, options) =>
		options.find((option) => option.includes(host.session.sessionId));
	await childSession.prompt("/agents");

	await host.runtime.newSession();

	assert.equal(childDisposeCalls, 1);
	assert.ok(host.runtime.session.getToolDefinition("agent_spawn"));
	await host.runtime.dispose();
});

test("orderly shutdown disposes retained child, Moderator, and Owner sessions exactly once", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
	});
	host.model.setResponses([
		fauxAssistantMessage("I settled while still owing the Creation Answer."),
		fauxAssistantMessage("I remain retained as the active Moderator."),
	]);
	const spawnInput = { request: "Remain answer-obligated for shutdown proof." };
	const spawnToolCallId = "spawn-before-complete-shutdown";
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: spawnToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(spawn);
	const spawnResult = await spawn.execute(
		spawnToolCallId,
		spawnInput,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const childAgentId = (spawnResult.details as { agentId: string }).agentId;
	const moderatorAgentId = await waitForModeratorAgentId(host);
	const disposalCounts = new Map([
		[childAgentId, 0],
		[moderatorAgentId, 0],
		[host.session.sessionId, 0],
	]);
	const countDisposal = (session: typeof host.session) => {
		const nativeDispose = session.dispose.bind(session);
		session.dispose = () => {
			disposalCounts.set(
				session.sessionId,
				(disposalCounts.get(session.sessionId) ?? 0) + 1,
			);
			nativeDispose();
		};
	};
	countDisposal(host.session);

	host.ui.select = async (_title, options) =>
		options.find((option) => option.includes(childAgentId));
	await host.session.prompt("/agents");
	const childSession = host.runtime.session;
	assert.equal(childSession.sessionId, childAgentId);
	countDisposal(childSession);
	host.ui.select = async (_title, options) =>
		options.find((option) => option.includes(moderatorAgentId));
	await childSession.prompt("/agents");
	const moderatorSession = host.runtime.session;
	assert.equal(moderatorSession.sessionId, moderatorAgentId);
	countDisposal(moderatorSession);

	await Promise.all([host.runtime.dispose(), host.runtime.dispose()]);
	assert.equal(host.runtime.session.sessionId, host.session.sessionId);
	assert.deepEqual(
		Object.fromEntries(disposalCounts),
		{
			[childAgentId]: 1,
			[moderatorAgentId]: 1,
			[host.session.sessionId]: 1,
		},
	);
});

test("orderly shutdown disposes child and Owner sessions even when child abort fails", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("Remain retained for exhaustive shutdown cleanup."),
	]);
	const spawnInput = { request: "Remain retained for exhaustive shutdown cleanup." };
	const spawnToolCallId = "spawn-before-failing-shutdown";
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: spawnToolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(spawn);
	const spawnResult = await spawn.execute(
		spawnToolCallId,
		spawnInput,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const childAgentId = (spawnResult.details as { agentId: string }).agentId;
	host.ui.select = async (_title, options) =>
		options.find((option) => option.includes(childAgentId));
	await host.session.prompt("/agents");
	const childSession = host.runtime.session;
	host.ui.select = async (_title, options) =>
		options.find((option) => option.includes(host.session.sessionId));
	await childSession.prompt("/agents");

	childSession.abort = async () => {
		throw new Error("injected child abort failure");
	};
	const nativeChildDispose = childSession.dispose.bind(childSession);
	let childDisposeCalls = 0;
	childSession.dispose = () => {
		childDisposeCalls += 1;
		nativeChildDispose();
	};
	const nativeOwnerDispose = host.session.dispose.bind(host.session);
	let ownerDisposeCalls = 0;
	host.session.dispose = () => {
		ownerDisposeCalls += 1;
		nativeOwnerDispose();
	};

	await assert.rejects(
		() => host.runtime.dispose(),
		(error: unknown) =>
			error instanceof AggregateError &&
			error.errors.some(
				(candidate) =>
					candidate instanceof Error &&
					candidate.message === "injected child abort failure",
			),
	);
	assert.equal(childDisposeCalls, 1);
	assert.equal(ownerDisposeCalls, 1);
});

async function waitForModeratorAgentId(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
): Promise<string> {
	const workflowDirectory = `${host.session.sessionManager.getSessionDir()}/pi-agent-coordination/${Buffer.from(
		host.session.sessionId,
		"utf8",
	).toString("base64url")}`;
	for (let attempt = 0; attempt < MAX_SESSION_DISCOVERY_ATTEMPTS; attempt += 1) {
		const sessions = await SessionManager.list(host.cwd, workflowDirectory);
		const moderator = sessions.find(({ path }) =>
			SessionManager.open(path).getEntries().some(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "agent-coordination.moderator-input",
			)
		);
		if (moderator) return moderator.id;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected retained Moderator session was not created");
}
