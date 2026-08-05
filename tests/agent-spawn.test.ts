import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import {
	WorkflowCoordinator,
	type AgentSpawnReceipt,
	type SpawnBoundaryHooks,
} from "../src/coordination/workflow-coordinator.ts";
import piAgentCoordination from "../src/index.ts";
import { ProtocolInvariantError } from "../src/protocol/identities.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

test("an authenticated ordinary Agent creates a durable isolated child and admits its Creation Request", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{
					request: "Inspect the coordination boundary and report what is observable.",
					description: "Inspects one coordination boundary",
				},
				{ id: "spawn-default-child" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The child has been created."),
		fauxAssistantMessage("I received isolated initial work."),
	]);
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(spawn);
	assert.deepEqual(Object.keys((spawn.parameters as { properties: object }).properties).sort(), [
		"description",
		"request",
	]);

	await host.session.prompt("Delegate this inspection to a fresh child.");
	await host.session.waitForIdle();

	const spawnResult = host.session.sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "agent_spawn",
		);
	assert.ok(spawnResult && spawnResult.type === "message");
	assert.equal(spawnResult.message.role, "toolResult");
	assert.equal(spawnResult.message.isError, false);
	assert.deepEqual(
		Object.keys(spawnResult.message.details as Record<string, unknown>).sort(),
		["agentId", "disposition", "requestId"],
	);
	assert.equal(
		(spawnResult.message.details as { disposition: string }).disposition,
		"pending",
	);

	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const childrenResult = await observe.execute(
		"observe-children",
		{ operation: "children" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const children = (childrenResult.details as { children: Array<Record<string, unknown>> })
		.children;
	assert.equal(children.length, 1);
	assert.deepEqual(
		{
			agentId: children[0]?.agentId,
			workflowId: children[0]?.workflowId,
			label: children[0]?.label,
			description: children[0]?.description,
			directSpawnerAgentId: children[0]?.directSpawnerAgentId,
		},
		{
			agentId: (spawnResult.message.details as { agentId: string }).agentId,
			workflowId: host.session.sessionId,
			label: "agent",
			description: "Inspects one coordination boundary",
			directSpawnerAgentId: host.session.sessionId,
		},
	);

	const sourceEntry = host.session.sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) => part.type === "toolCall" && part.id === "spawn-default-child",
				),
		);
	assert.ok(sourceEntry);
	const spawnSource = {
		agentId: host.session.sessionId,
		entryId: sourceEntry.id,
		toolCallId: "spawn-default-child",
	};
	const expectedRequestId = createHash("sha256")
		.update(
			[
				"agent-coordination",
				"message",
				spawnSource.agentId,
				spawnSource.entryId,
				spawnSource.toolCallId,
			].join("\0"),
			"utf8",
		)
		.digest("base64url");
	assert.equal(
		(spawnResult.message.details as { requestId: string }).requestId,
		expectedRequestId,
	);

	const workflowDirectory = join(
		host.session.sessionManager.getSessionDir(),
		"pi-agent-coordination",
		Buffer.from(host.session.sessionId, "utf8").toString("base64url"),
	);
	const childSessionFile = await waitForChildSessionFile(host.cwd, workflowDirectory);
	const childTranscript = SessionManager.open(childSessionFile);
	const childEntries = await waitForEntry(
		childSessionFile,
		(entry) => entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery",
	);
	const childIdentity = childEntries.find(
		(entry) => entry.type === "custom" && entry.customType === "agent-coordination.identity",
	);
	assert.ok(childIdentity && childIdentity.type === "custom");
	assert.equal(childIdentity.parentId, null);
	assert.deepEqual(childIdentity.data, {
		agentId: childTranscript.getSessionId(),
		workflowId: host.session.sessionId,
		directSpawnerAgentId: host.session.sessionId,
		spawnSource,
		configuration: {
			label: "agent",
			description: "Inspects one coordination boundary",
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
	const delivery = childEntries.find(
		(entry) => entry.type === "custom_message" &&
			entry.customType === "agent-coordination.message-delivery",
	);
	assert.ok(delivery && delivery.type === "custom_message");
	assert.deepEqual(delivery.details, { messages: [spawnSource] });
	assert.deepEqual(JSON.parse(delivery.content as string), {
		messages: [
			{
				kind: "request",
				requestId: expectedRequestId,
				fromAgentId: host.session.sessionId,
				question: "Inspect the coordination boundary and report what is observable.",
			},
		],
	});
	assert.equal(
		childEntries.some(
			(entry) => entry.type === "message" && entry.message.role === "user",
		),
		false,
	);

	await host.runtime.dispose();
});

test("invalid default-child metadata fails before Agent Identity", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{
					request: "This request must never acquire a child.",
					description: "\n",
				},
				{ id: "spawn-invalid-metadata" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The child was not created."),
	]);

	await host.session.prompt("Try an invalid child description.");
	await host.session.waitForIdle();

	assert.deepEqual(findSpawnReceipt(host.session.sessionManager), {
		disposition: "not_created",
		failedStage: "identity_commit",
	});
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const result = await observe.execute(
		"observe-no-children",
		{ operation: "children" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(result.details, { children: [] });

	await host.runtime.dispose();
});

test("unavailable inherited resources fail before Agent Identity", async () => {
	const ownerOnlyTool: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "owner_only_probe",
			label: "Owner-only probe",
			description: "A test resource unavailable to child sessions.",
			parameters: Type.Object({}, { additionalProperties: false }),
			async execute() {
				return { content: [{ type: "text", text: "probe" }], details: undefined };
			},
		});
	};
	const harness = await createCoordinatorHarness({}, ownerOnlyTool);
	const receipt = await harness.spawn("spawn-missing-inherited-resource");

	assert.deepEqual(receipt, {
		disposition: "not_created",
		failedStage: "identity_commit",
	});
	assert.deepEqual(harness.view.children(), []);

	await harness.shutdown();
});

test("model loss during child preflight fails before Agent Identity", async () => {
	const host = await createUnboundTestOwnerHost(() => undefined, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime, "<inline:pi-agent-coordination>");
	const originalGetModel = host.services.modelRuntime.getModel.bind(host.services.modelRuntime);
	let modelAvailable = true;
	const modelAvailabilityControlledRuntime = host.services
		.modelRuntime as typeof host.services.modelRuntime & {
			getModel: typeof host.services.modelRuntime.getModel;
		};
	modelAvailabilityControlledRuntime.getModel = (
		(provider: string, modelId: string) =>
			modelAvailable ? originalGetModel(provider, modelId) : undefined
	) as typeof host.services.modelRuntime.getModel;
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		childExtensionFactory: (agentId) => {
			modelAvailable = false;
			return createAgentBoundExtension(() => coordinator.forAgent(agentId));
		},
	});
	const view = coordinator.forAgent(identity.agentId);
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "This request should fail before child Identity." },
				{ id: "spawn-missing-inherited-model" },
			),
			{ stopReason: "toolUse" },
		),
	);
	try {
		const receipt = await view.spawn("spawn-missing-inherited-model", {
			request: "This request should fail before child Identity.",
		});

		assert.deepEqual(receipt, {
			disposition: "not_created",
			failedStage: "identity_commit",
		});
		assert.deepEqual(view.children(), []);
	} finally {
		modelAvailabilityControlledRuntime.getModel = originalGetModel;
		await coordinator.shutdown(async () => host.runtime.dispose());
	}
});

test("confirmed post-Identity Run startup failure keeps a visible dormant child", async () => {
	const harness = await createCoordinatorHarness({
		beforeRunStart: () => "confirmed_failure",
	});
	const receipt = await harness.spawn("spawn-run-start-failure");

	assert.equal(receipt.disposition, "created_unscheduled");
	assert.equal(receipt.failedStage, "run_start");
	assert.deepEqual(harness.view.children()[0]?.run, {
		phase: "dormant",
		retentionReasons: [],
	});

	await harness.shutdown();
});

test("Run startup invariant failures are not downgraded to availability receipts", async () => {
	const harness = await createCoordinatorHarness({
		beforeRunStart: () => {
			throw new ProtocolInvariantError("started child Run contradicts its protocol binding");
		},
	});

	await assert.rejects(
		() => harness.spawn("spawn-run-start-invariant-violation"),
		/started child Run contradicts its protocol binding/,
	);

	await harness.shutdown();
});

test("confirmed post-Identity Delivery admission failure keeps the child and Request but releases its Run", async () => {
	const harness = await createCoordinatorHarness({
		beforeDeliveryAdmission: () => "confirmed_failure",
	});
	const receipt = await harness.spawn("spawn-delivery-admission-failure");

	assert.equal(receipt.disposition, "created_unscheduled");
	assert.equal(receipt.failedStage, "delivery_admission");
	assert.deepEqual(harness.view.children()[0]?.run, {
		phase: "dormant",
		retentionReasons: [],
	});

	await harness.shutdown();
});

test("lost Run-start confirmation stays indeterminate after confirmed Identity", async () => {
	const harness = await createCoordinatorHarness({
		afterRunStart: () => "confirmation_lost",
	});
	const receipt = await harness.spawn("spawn-run-start-confirmation-lost");

	assert.equal(receipt.disposition, "indeterminate");
	assert.equal(receipt.lastConfirmedStage, "identity");
	assert.equal(typeof receipt.agentId, "string");
	assert.equal(typeof receipt.requestId, "string");
	assert.equal(harness.view.children()[0]?.run.phase, "live");

	await harness.shutdown();
});

test("lost Identity confirmation stays indeterminate with a canonical dormant child", async () => {
	const harness = await createCoordinatorHarness({
		afterIdentityCommit: () => "confirmation_lost",
	});
	const receipt = await harness.spawn("spawn-identity-confirmation-lost");

	assert.equal(receipt.disposition, "indeterminate");
	assert.equal("lastConfirmedStage" in receipt, false);
	assert.equal(typeof receipt.agentId, "string");
	assert.equal(typeof receipt.requestId, "string");
	assert.deepEqual(harness.view.children()[0]?.run, {
		phase: "dormant",
		retentionReasons: [],
	});

	await harness.shutdown();
});

test("lost Delivery confirmation stays indeterminate after confirmed Run start", async () => {
	const harness = await createCoordinatorHarness({
		afterDeliveryAdmission: () => "confirmation_lost",
	});
	const receipt = await harness.spawn("spawn-delivery-confirmation-lost");

	assert.equal(receipt.disposition, "indeterminate");
	assert.equal(receipt.lastConfirmedStage, "run_start");
	assert.equal(typeof receipt.agentId, "string");
	assert.equal(typeof receipt.requestId, "string");
	assert.equal(harness.view.children()[0]?.run.phase, "live");

	await harness.shutdown();
});

test("contradictory child Identity evidence is an invariant violation", async () => {
	const harness = await createCoordinatorHarness({
		afterIdentityCommit: ({ sessionManager, identity }) => {
			sessionManager.appendCustomEntry("agent-coordination.identity", {
				...identity,
				spawnSource: { ...identity.spawnSource, toolCallId: "contradictory-source" },
			});
		},
	});

	await assert.rejects(
		() => harness.spawn("spawn-contradictory-identity"),
		/invariant_violation: child transcript contains 2 ordinary Identity entries/,
	);

	await harness.shutdown();
});

test("forged Creation Request Delivery evidence is an invariant violation", async () => {
	const harness = await createCoordinatorHarness({
		afterIdentityCommit: ({ sessionManager, identity }) => {
			sessionManager.appendCustomMessageEntry(
				"agent-coordination.message-delivery",
				JSON.stringify({
					messages: [
						{
							kind: "request",
							requestId: "wrong-request",
							fromAgentId: identity.directSpawnerAgentId,
							question: "This projection does not match its source.",
						},
					],
				}),
				true,
				{ messages: [identity.spawnSource] },
			);
		},
	});

	await assert.rejects(
		() => harness.spawn("spawn-with-forged-creation-request-delivery"),
		/Creation Request .* Delivery differs from its source/,
	);

	await harness.shutdown();
});

test("direct children remain in physical Agent Spawn call order", async () => {
	const harness = await createCoordinatorHarness({});
	const receipts = await harness.spawnMany([
		"spawn-first-ordered-child",
		"spawn-second-ordered-child",
	]);

	assert.deepEqual(
		harness.view.children().map(({ agentId }) => agentId),
		receipts,
	);

	await harness.shutdown();
});

async function waitForChildSessionFile(cwd: string, sessionDirectory: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const sessions = await SessionManager.list(cwd, sessionDirectory);
		if (sessions[0]) return sessions[0].path;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Child Pi session file was not created");
}

async function waitForEntry(
	sessionFile: string,
	predicate: (entry: ReturnType<SessionManager["getEntries"]>[number]) => boolean,
) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const entries = SessionManager.open(sessionFile).getEntries();
		if (entries.some(predicate)) return entries;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected child transcript entry did not commit");
}

function findSpawnReceipt(sessionManager: SessionManager): AgentSpawnReceipt {
	const result = sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "agent_spawn",
		);
	assert.ok(result && result.type === "message" && result.message.role === "toolResult");
	return result.message.details as AgentSpawnReceipt;
}

async function createCoordinatorHarness(
	hooks: SpawnBoundaryHooks,
	ownerExtension: ExtensionFactory = () => undefined,
) {
	const host = await createUnboundTestOwnerHost(ownerExtension, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime, "<inline:pi-agent-coordination>");
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		spawnBoundaryHooks: hooks,
	});
	const view = coordinator.forAgent(identity.agentId);

	return {
		view,
		async spawn(toolCallId: string): Promise<AgentSpawnReceipt> {
			host.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall(
						"agent_spawn",
						{ request: `Creation Request for ${toolCallId}` },
						{ id: toolCallId },
					),
					{ stopReason: "toolUse" },
				),
			);
			return view.spawn(toolCallId, { request: `Creation Request for ${toolCallId}` });
		},
		async spawnMany(toolCallIds: string[]) {
			host.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					toolCallIds.map((toolCallId) =>
						fauxToolCall(
							"agent_spawn",
							{ request: `Creation Request for ${toolCallId}` },
							{ id: toolCallId },
						),
					),
					{ stopReason: "toolUse" },
				),
			);
			const agentIds: string[] = [];
			for (const toolCallId of toolCallIds) {
				const receipt = await view.spawn(toolCallId, {
					request: `Creation Request for ${toolCallId}`,
				});
				assert.ok("agentId" in receipt && typeof receipt.agentId === "string");
				agentIds.push(receipt.agentId);
			}
			return agentIds;
		},
		shutdown: () => coordinator.shutdown(async () => host.runtime.dispose()),
	};
}
