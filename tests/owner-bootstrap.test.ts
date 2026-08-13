import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";

import piAgentCoordination from "../src/index.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";

test("Owner tool renderers are registered before session_start", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);

	for (const toolName of [
		"agent_spawn",
		"agent_message",
		"agent_observe",
		"agent_control",
	] as const) {
		const tool = host.session.getToolDefinition(toolName);
		assert.ok(tool, toolName);
		assert.equal(typeof tool.renderCall, "function", toolName);
		assert.equal(typeof tool.renderResult, "function", toolName);
	}
	assert.equal(
		host.session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "agent-coordination.identity",
			),
		false,
	);
	await host.runtime.dispose();
});

test("a fresh Owner Identity records its role description", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	await bindTestOwnerHost(host, "tui");

	const identity = host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "custom" && entry.customType === "agent-coordination.identity",
	);
	assert.ok(identity?.type === "custom");
	assert.deepEqual((identity.data as { metadata: unknown }).metadata, {
		label: "Owner",
		description: "Workflow Owner",
	});
	await host.runtime.dispose();
});

test("startup-triggered Owner work waits for coordination admission", async () => {
	const startupBlock = createVoidDeferred();
	const startupBlockEntered = createVoidDeferred();
	const promptReachedStartBoundary = createVoidDeferred();
	const agentStarted = createVoidDeferred();
	let identityPresentAtAgentStart = false;
	let agentStartedBeforeOwnerAdmission = false;
	let ownerAdmissionReleased = false;
	const host = await createUnboundTestOwnerHost(piAgentCoordination, {
		additionalExtensionFactories: [
			{
				name: "startup-user-message",
				hidden: true,
				factory(pi) {
					pi.on("session_start", () => {
						pi.sendUserMessage("Start work after every extension is ready.");
					});
					pi.on("session_start", async () => {
						startupBlockEntered.resolve();
						await startupBlock.promise;
					});
					pi.on("before_agent_start", () => {
						promptReachedStartBoundary.resolve();
					});
					pi.on("agent_start", (_event, ctx) => {
						agentStartedBeforeOwnerAdmission = !ownerAdmissionReleased;
						identityPresentAtAgentStart = ctx.sessionManager
							.getEntries()
							.some(
								(entry) =>
									entry.type === "custom" &&
									entry.customType === "agent-coordination.identity",
							);
						agentStarted.resolve();
					});
				},
			},
		],
	});

	const binding = bindTestOwnerHost(host, "tui");
	await startupBlockEntered.promise;
	await promptReachedStartBoundary.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	ownerAdmissionReleased = true;
	startupBlock.resolve();
	await binding;
	await agentStarted.promise;
	await host.session.waitForIdle();

	assert.equal(agentStartedBeforeOwnerAdmission, false);
	assert.equal(identityPresentAtAgentStart, true);
	await host.runtime.dispose();
});

test("an existing Owner Identity without a description is canonicalized without duplication", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	host.session.sessionManager.appendCustomEntry(
		"agent-coordination.identity",
		ownerIdentityFor(host),
	);

	await bindTestOwnerHost(host, "tui");

	const identityEntries = host.session.sessionManager
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom" && entry.customType === "agent-coordination.identity",
		);
	assert.equal(identityEntries.length, 1);
	assert.deepEqual(identityEntries[0]?.type === "custom" ? identityEntries[0].data : undefined, {
		...ownerIdentityFor(host),
		metadata: { label: "Owner" },
	});
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const status = await observe.execute(
		"observe-canonical-owner-metadata",
		{ operation: "status" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.equal((status.details as { description?: string }).description, "Workflow Owner");
	assert.ok(host.session.getToolDefinition("agent_observe"));
	assert.ok(host.session.getToolDefinition("agent_control"));
	assert.equal(host.session.getToolDefinition("ask_user_question"), undefined);
	const ordinaryAgentExtensions = host.services.resourceLoader
		.getExtensions()
		.extensions.filter((extension) => extension.tools.has("agent_spawn"));
	assert.equal(ordinaryAgentExtensions.length, 1);
	assert.equal(ordinaryAgentExtensions[0]?.hidden, true);
	await host.runtime.dispose();
});

test("an Owner Identity rejects a contradictory role description", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	host.session.sessionManager.appendCustomEntry("agent-coordination.identity", {
		...ownerIdentityFor(host),
		metadata: {
			label: "Owner",
			description: "unrelated role",
		},
	});

	await bindTestOwnerHost(host, "tui");

	assert.equal(
		host.ui.notifications.some(
			({ message, type }) =>
				type === "error" &&
				message.includes('Owner description must be "Workflow Owner"'),
		),
		true,
	);
	assertOwnerToolsRegisteredButInactive(host);
	await host.runtime.dispose();
});

test("a resumed Owner admits coordination evidence after its Identity cutoff", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	host.model.setResponses([
		fauxAssistantMessage("The self-addressed Message is available after restart."),
	]);
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "send",
					targetAgentId: host.session.sessionId,
					content: "Persist legitimate current-scope coordination evidence.",
				},
				{ id: "owner-self-message-before-reopen" },
			),
			{ stopReason: "toolUse" },
		),
	);
	const message = host.session.getToolDefinition("agent_message");
	assert.ok(message);
	await message.execute(
		"owner-self-message-before-reopen",
		{
			operation: "send",
			targetAgentId: host.session.sessionId,
			content: "Persist legitimate current-scope coordination evidence.",
		},
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	await host.session.waitForIdle();
	const sessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(sessionFile);
	await host.runtime.dispose();

	const reopened = await createUnboundTestOwnerHost(piAgentCoordination, {
		cwd: host.cwd,
		agentDir: host.services.agentDir,
		sessionFile,
	});
	await bindTestOwnerHost(reopened, "tui");

	assert.ok(reopened.session.getToolDefinition("agent_observe"));
	assert.equal(
		reopened.ui.notifications.some(({ type }) => type === "error"),
		false,
	);
	await reopened.runtime.dispose();
});

test("resource reload rebinds the hidden Owner Agent extension", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	await bindTestOwnerHost(host, "tui");

	await host.session.reload();

	assert.ok(host.session.getToolDefinition("agent_spawn"));
	const ordinaryAgentExtensions = host.services.resourceLoader
		.getExtensions()
		.extensions.filter((extension) => extension.tools.has("agent_spawn"));
	assert.equal(ordinaryAgentExtensions.length, 1);
	assert.equal(ordinaryAgentExtensions[0]?.hidden, true);
	await host.runtime.dispose();
});

test("an invalid initial Workflow Policy prevents coordination runtime creation", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	const policyPath = join(
		host.services.agentDir,
		"config",
		"pi-agent-coordination.json",
	);
	await mkdir(join(host.services.agentDir, "config"), { recursive: true });
	await writeFile(policyPath, '{"maxConcurrentAgentRuns": 0}', "utf8");

	await bindTestOwnerHost(host, "tui");

	assert.equal(
		host.session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "agent-coordination.identity",
			),
		false,
	);
	assertOwnerToolsRegisteredButInactive(host);
	assert.deepEqual(host.services.diagnostics, [
		{
			type: "error",
			message:
				"Workflow Policy maxConcurrentAgentRuns must be a positive safe integer",
		},
	]);
	await host.runtime.dispose();
});

test("an ambiguous public Owner extension fails before Identity commitment", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	const extensions = host.services.resourceLoader.getExtensions().extensions;
	const publicOwnerExtension = extensions.find((extension) =>
		extension.handlers.get("session_start")?.some(() => true),
	);
	assert.ok(publicOwnerExtension);
	extensions.push(publicOwnerExtension);

	await bindTestOwnerHost(host, "tui");

	assert.equal(
		host.session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "agent-coordination.identity",
			),
		false,
	);
	assertOwnerToolsRegisteredButInactive(host);
	assert.equal(
		host.ui.notifications.some(
			({ message, type }) =>
				type === "error" &&
				message.includes("cannot bind the Owner Agent extension"),
		),
		true,
	);
	extensions.pop();
	await host.runtime.dispose();
});

test("Owner reload publishes one prospective policy or preserves the prior snapshot", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination, { persistent: true });
	const policyDirectory = join(host.services.agentDir, "config");
	const policyPath = join(policyDirectory, "pi-agent-coordination.json");
	await mkdir(policyDirectory, { recursive: true });
	await writeFile(policyPath, '{"maxPendingDeliveriesPerAgent": 1}', "utf8");
	await bindTestOwnerHost(host, "tui");
	host.model.setResponses([
		fauxAssistantMessage("Remain held so Workflow Policy reload can be observed."),
	]);

	const spawned = await executeOwnerTool(host, "agent_spawn", "spawn-policy-child", {
		request: "Remain available for prospective delivery-capacity checks.",
	});
	const childAgentId = (spawned as { agentId: string }).agentId;
	await executeOwnerTool(host, "agent_control", "hold-policy-child", {
		operation: "interrupt",
		agentId: childAgentId,
	});
	const first = await executeOwnerTool(host, "agent_message", "first-policy-message", {
		operation: "send",
		targetAgentId: childAgentId,
		content: "Occupy the initial policy capacity.",
	});
	assert.equal((first as { delivery: string }).delivery, "pending");
	const initiallyRejected = await executeOwnerTool(
		host,
		"agent_message",
		"initially-rejected-policy-message",
		{
			operation: "send",
			targetAgentId: childAgentId,
			content: "Remain canonical after initial capacity rejection.",
		},
	);
	assert.equal(
		(initiallyRejected as { rejectionReason: string }).rejectionReason,
		"capacity_exhausted",
	);

	const transcriptBeforeReload = structuredClone(host.session.sessionManager.getEntries());
	await writeFile(policyPath, '{"maxPendingDeliveriesPerAgent": 2}', "utf8");
	await host.session.reload();
	assert.deepEqual(host.session.sessionManager.getEntries(), transcriptBeforeReload);
	const admittedAfterRaise = await executeOwnerTool(
		host,
		"agent_message",
		"admitted-after-policy-raise",
		{
			operation: "send",
			targetAgentId: childAgentId,
			content: "Use the newly published second slot.",
		},
	);
	assert.equal((admittedAfterRaise as { delivery: string }).delivery, "pending");

	await writeFile(policyPath, '{"maxPendingDeliveriesPerAgent": 0}', "utf8");
	await host.session.reload();
	assert.equal(
		host.services.diagnostics.at(-1)?.message,
		"Workflow Policy maxPendingDeliveriesPerAgent must be a positive safe integer",
	);
	const rejectedAfterInvalidReload = await executeOwnerTool(
		host,
		"agent_message",
		"rejected-after-invalid-policy-reload",
		{
			operation: "send",
			targetAgentId: childAgentId,
			content: "The preserved two-slot snapshot remains exhausted.",
		},
	);
	assert.equal(
		(rejectedAfterInvalidReload as { rejectionReason: string }).rejectionReason,
		"capacity_exhausted",
	);

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
	assertOwnerToolsRegisteredButInactive(host);
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
			metadata: {
				label: "Moderator",
				description: "run failure",
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
	assertOwnerToolsRegisteredButInactive(host);
	assert.equal(host.session.extensionRunner.getCommand("agents"), undefined);
	await host.runtime.dispose();
});

function createVoidDeferred(): Readonly<{
	promise: Promise<void>;
	resolve(): void;
}> {
	let resolvePromise: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function assertOwnerToolsRegisteredButInactive(host: TestOwnerHost): void {
	for (const toolName of [
		"agent_spawn",
		"agent_message",
		"agent_observe",
		"agent_control",
	] as const) {
		assert.equal(typeof host.session.getToolDefinition(toolName)?.renderResult, "function");
		assert.equal(host.session.getActiveToolNames().includes(toolName), false);
	}
}

function ownerIdentityFor(host: TestOwnerHost) {
	return {
		agentId: host.session.sessionId,
		workflowId: host.session.sessionId,
		directSpawnerAgentId: null,
		metadata: { label: "Owner" },
	} as const;
}

async function executeOwnerTool(
	host: TestOwnerHost,
	toolName: "agent_spawn" | "agent_control" | "agent_message",
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(toolName, input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const tool = host.session.getToolDefinition(toolName);
	assert.ok(tool);
	const result = await tool.execute(
		toolCallId,
		input,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	return result.details;
}
