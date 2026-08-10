import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionFactory,
	InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	createAgentBoundExtension,
	createModeratorBoundExtension,
} from "../src/bootstrap/agent-extension.ts";
import {
	WorkflowCoordinator,
	type AgentSpawnInput,
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
import {
	executeAndCommitRegisteredTool as executeRegisteredTool,
} from "./support/agent-session.ts";

const MAX_CONDITION_POLL_ATTEMPTS = 5_000;
const FILE_EXTENSION_FIXTURE = fileURLToPath(
	new URL("./fixtures/inherited-extension-fixture.ts", import.meta.url),
);

type NamedInlineExtension = Exclude<InlineExtension, ExtensionFactory>;

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
		"config",
		"description",
		"label",
		"request",
		"template",
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
		["agentId", "disposition", "effectiveConfiguration", "requestId"],
	);
	assert.equal(
		(spawnResult.message.details as { disposition: string }).disposition,
		"pending",
	);
	assert.deepEqual(
		(spawnResult.message.details as AgentSpawnReceipt & {
			effectiveConfiguration: unknown;
		}).effectiveConfiguration,
		{
			cwd: host.cwd,
			model: { provider: "coordination-test", modelId: "deterministic-owner" },
			thinking: "off",
			tools: [
				"agent_message",
				"agent_control",
				"agent_observe",
				"agent_spawn",
				"ask_user_question",
			],
			skills: [],
			extensions: [],
		},
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
	const childSessionFile = await waitForChildSessionFile(
		host.cwd,
		workflowDirectory,
		(spawnResult.message.details as { agentId: string }).agentId,
	);
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

test("a selected Template and immutable overrides resolve against baseline cwd for a real child Run", async () => {
	const host = await createUnboundTestOwnerHost(() => undefined, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime, "<inline:pi-agent-coordination>");
	const templateRoot = join(host.cwd, "template-root");
	const effectiveCwd = join(host.cwd, "subproject");
	await mkdir(templateRoot, { recursive: true });
	await mkdir(join(effectiveCwd, ".agents", "agents"), { recursive: true });
	await writeFile(
		join(templateRoot, "research.md"),
		"---\nname: research-agent\nthinking: high\ntools: read\n---\nTemplate context",
	);
	await writeFile(join(effectiveCwd, "AGENTS.md"), "Native effective-cwd context");
	await writeFile(
		join(effectiveCwd, ".agents", "agents", "research.md"),
		"---\nname: research-agent\nthinking: low\n---\nWrong discovery root",
	);

	let observedSystemPrompt = "";
	let observedTools: string[] = [];
	host.model.setResponses([
		(context) => {
			observedSystemPrompt = context.systemPrompt ?? "";
			observedTools = context.tools?.map(({ name }) => name) ?? [];
			return fauxAssistantMessage("Configured child Run observed.");
		},
	]);
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		packageRoot: host.cwd,
		templateRoots: (baselineCwd, projectTrusted) => {
			assert.equal(baselineCwd, host.cwd);
			assert.equal(projectTrusted, true);
			return [{ scope: "trusted-project", path: templateRoot }];
		},
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator.forModerator(agentId)),
	});
	const view = coordinator.forAgent(identity.agentId);
	const spawnInput = {
		request: "Inspect the configured child Run.",
		template: "research-agent",
		description: "  Research specialist  ",
		config: {
			cwd: "subproject",
			projectContext: "Spawn context",
			projectContextMode: "append" as const,
		},
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: "spawn-configured-child" }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.spawn("spawn-configured-child", spawnInput);
	assert.equal(receipt.disposition, "pending");
	assert.deepEqual(receipt.effectiveConfiguration, {
		cwd: effectiveCwd,
		model: { provider: "coordination-test", modelId: "deterministic-owner" },
		thinking: "high",
		tools: [
			"read",
			"agent_message",
			"agent_control",
			"agent_observe",
			"agent_spawn",
			"ask_user_question",
		],
		skills: [],
		extensions: [],
		projectContext: {
			mode: "append",
			body: "Template context\n\nSpawn context",
		},
	});
	assert.deepEqual(
		view.children().map(({ label, description }) => ({ label, description })),
		[{ label: "research-agent", description: "Research specialist" }],
	);
	await waitForCondition(() => observedSystemPrompt.length > 0);
	assert.match(observedSystemPrompt, /Native effective-cwd context/);
	assert.match(observedSystemPrompt, /Template context/);
	assert.match(observedSystemPrompt, /Spawn context/);
	assert.doesNotMatch(observedSystemPrompt, /Wrong discovery root/);
	for (const toolName of receipt.effectiveConfiguration.tools) {
		assert.ok(observedTools.includes(toolName), `missing model-visible tool ${toolName}`);
	}

	const workflowDirectory = join(
		host.session.sessionManager.getSessionDir(),
		"pi-agent-coordination",
		Buffer.from(host.session.sessionId, "utf8").toString("base64url"),
	);
	const childSessionFile = await waitForChildSessionFile(
		host.cwd,
		workflowDirectory,
		receipt.agentId,
	);
	const childIdentity = SessionManager.open(childSessionFile)
		.getEntries()
		.find((entry) => entry.type === "custom" && entry.customType === "agent-coordination.identity");
	assert.ok(childIdentity && childIdentity.type === "custom");
	assert.deepEqual(
		(childIdentity.data as { configuration: object }).configuration,
		{
			label: "research-agent",
			description: "Research specialist",
			baseline: {
				cwd: host.cwd,
				model: { provider: "coordination-test", modelId: "deterministic-owner" },
				thinking: "off",
				tools: [],
				skills: [],
				extensions: [],
			},
		},
	);

	const agentId = receipt.agentId;
	await waitForCondition(() => {
		const run = view.status(agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_control",
				{ operation: "terminate", agentId },
				{ id: "terminate-configured-child-v1" },
			),
			{ stopReason: "toolUse" },
		),
	);
	const firstTermination = await view.control("terminate-configured-child-v1", {
		operation: "terminate",
		agentId,
	});
	assert.ok("disposition" in firstTermination);
	assert.equal(firstTermination.disposition, "terminated");
	await writeFile(
		join(templateRoot, "research.md"),
		"---\nname: research-agent\nthinking: low\ntools: read\n---\nTemplate context v2",
	);
	let successorSystemPrompt = "";
	host.model.setResponses([
		(context) => {
			successorSystemPrompt = context.systemPrompt ?? "";
			return fauxAssistantMessage("Successor used the current Template.");
		},
	]);
	const successorMessage = {
		operation: "send" as const,
		targetAgentId: agentId,
		content: "Start a successor Run.",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", successorMessage, { id: "start-configured-child-v2" }),
			{ stopReason: "toolUse" },
		),
	);
	const successorReceipt = await view.message("start-configured-child-v2", successorMessage);
	assert.ok("delivery" in successorReceipt);
	assert.equal(successorReceipt.delivery, "pending");
	await waitForCondition(() => successorSystemPrompt.length > 0);
	assert.match(successorSystemPrompt, /Template context v2/);
	assert.doesNotMatch(successorSystemPrompt, /Template context(?:\n|$)/);

	await waitForCondition(() => {
		const run = view.status(agentId).run;
		return run.phase === "dormant" || (run.phase === "live" && run.work === "settled");
	});
	if (view.status(agentId).run.phase === "live") {
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall(
					"agent_control",
					{ operation: "terminate", agentId },
					{ id: "terminate-configured-child-v2" },
				),
				{ stopReason: "toolUse" },
			),
		);
		const secondTermination = await view.control("terminate-configured-child-v2", {
			operation: "terminate",
			agentId,
		});
		assert.ok("disposition" in secondTermination);
		assert.equal(secondTermination.disposition, "terminated");
	}
	await writeFile(
		join(templateRoot, "research.md"),
		"---\nname: research-agent\ncwd: invalid-template-field\n---\n",
	);
	let staleFallbackInvoked = false;
	host.model.setResponses([
		() => {
			staleFallbackInvoked = true;
			return fauxAssistantMessage("This stale fallback must not run.");
		},
	]);
	const blockedMessage = {
		operation: "send" as const,
		targetAgentId: agentId,
		content: "Do not start from stale Template content.",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", blockedMessage, { id: "start-invalid-template" }),
			{ stopReason: "toolUse" },
		),
	);
	const blockedReceipt = await view.message("start-invalid-template", blockedMessage);
	assert.ok("delivery" in blockedReceipt);
	assert.equal(blockedReceipt.delivery, "rejected");
	assert.ok("rejectionReason" in blockedReceipt);
	assert.equal(blockedReceipt.rejectionReason, "target_unavailable");
	assert.equal(staleFallbackInvoked, false);
	assert.equal(view.status(agentId).run.phase, "dormant");
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "start-invalid-template",
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(blockedReceipt) }],
		details: blockedReceipt,
		isError: false,
		timestamp: Date.now(),
	});

	await writeFile(
		join(templateRoot, "research.md"),
		"---\nname: research-agent\nthinking: low\ntools: read\n---\nRepaired Template context",
	);
	let repairedSystemPrompt = "";
	host.model.setResponses([
		(context) => {
			repairedSystemPrompt = context.systemPrompt ?? "";
			return fauxAssistantMessage("Repaired Template started the Run.");
		},
	]);
	const retryInput = {
		operation: "retry" as const,
		messageId: blockedReceipt.messageId,
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", retryInput, { id: "retry-repaired-template" }),
			{ stopReason: "toolUse" },
		),
	);
	const retryReceipt = await view.message("retry-repaired-template", retryInput);
	assert.ok("disposition" in retryReceipt);
	assert.equal(retryReceipt.disposition, "pending");
	await waitForCondition(() => repairedSystemPrompt.length > 0);
	assert.match(repairedSystemPrompt, /Repaired Template context/);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("agent_spawn resolves <inline:llama.cpp> through its named factory instead of as a file path", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "llama.cpp",
			hidden: true,
			factory: () => undefined,
		}],
	});
	host.model.setResponses([
		fauxAssistantMessage("The child started with the named inline extension."),
	]);

	const spawn = await executeRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-with-llama-inline-regression",
		{ request: "Start with the inherited llama.cpp extension." },
	);
	const receipt = spawn.details as AgentSpawnReceipt;
	assert.equal(receipt.disposition, "pending");
	assert.ok("agentId" in receipt);
	assert.deepEqual(receipt.effectiveConfiguration.extensions, ["<inline:llama.cpp>"]);

	await host.runtime.dispose();
});

test("named inline and file-backed extensions are inherited with fresh state through nested Agent Runs", async () => {
	let nextInstanceId = 0;
	const startedInstances: number[] = [];
	const namedExtension: NamedInlineExtension = {
		name: "stateful-inheritance-probe",
		factory(pi) {
			const instanceId = ++nextInstanceId;
			let sessionStarts = 0;
			pi.on("session_start", () => {
				sessionStarts += 1;
				startedInstances.push(instanceId);
			});
			pi.registerTool({
				name: "inline_extension_probe",
				label: "Inline extension probe",
				description: "Reports factory-local state for this Agent Run.",
				parameters: Type.Object({}, { additionalProperties: false }),
				async execute() {
					return {
						content: [{ type: "text", text: `inline instance ${instanceId}` }],
						details: { instanceId, sessionStarts },
					};
				},
			});
		},
	};
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionPaths: [FILE_EXTENSION_FIXTURE],
		additionalExtensionFactories: [namedExtension],
	});
	host.model.setResponses([
		fauxAssistantMessage([
			fauxToolCall("inline_extension_probe", {}, { id: "probe-inline-child" }),
			fauxToolCall("file_extension_probe", {}, { id: "probe-file-child" }),
			fauxToolCall(
				"agent_spawn",
				{ request: "Inherit both extension kinds one generation deeper." },
				{ id: "spawn-inline-grandchild" },
			),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage([
			fauxToolCall("inline_extension_probe", {}, { id: "probe-inline-grandchild" }),
			fauxToolCall("file_extension_probe", {}, { id: "probe-file-grandchild" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("The child inherited fresh extension state."),
		fauxAssistantMessage("The grandchild inherited another fresh extension state."),
	]);

	const ownerProbe = await executeRegisteredTool(
		host.session,
		"inline_extension_probe",
		"probe-inline-owner",
		{},
	);
	assert.deepEqual(ownerProbe.details, { instanceId: 1, sessionStarts: 1 });
	const ownerInstanceId = (ownerProbe.details as { instanceId: number }).instanceId;

	const child = await executeRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-inline-child",
		{ request: "Inherit both extension kinds and remain available." },
	);
	const childReceipt = child.details as AgentSpawnReceipt;
	assert.equal(childReceipt.disposition, "pending");
	assert.ok("agentId" in childReceipt);
	assert.deepEqual(
		new Set(childReceipt.effectiveConfiguration.extensions),
		new Set([FILE_EXTENSION_FIXTURE, "<inline:stateful-inheritance-probe>"]),
	);
	const childProbe = await waitForAgentToolResult(
		host,
		childReceipt.agentId,
		"probe-inline-child",
	);
	assert.deepEqual(
		await waitForAgentToolResult(host, childReceipt.agentId, "probe-file-child"),
		{ loaded: true },
	);
	const childProbeDetails = childProbe as {
		instanceId: number;
		sessionStarts: number;
	};
	assert.equal(childProbeDetails.sessionStarts, 1);
	assert.notEqual(childProbeDetails.instanceId, ownerInstanceId);
	const grandchildSpawn = await waitForAgentToolResult(
		host,
		childReceipt.agentId,
		"spawn-inline-grandchild",
	) as AgentSpawnReceipt;
	assert.equal(grandchildSpawn.disposition, "pending");
	assert.ok("agentId" in grandchildSpawn);
	const grandchildProbe = await waitForAgentToolResult(
		host,
		grandchildSpawn.agentId,
		"probe-inline-grandchild",
	) as { instanceId: number; sessionStarts: number };
	assert.deepEqual(
		await waitForAgentToolResult(
			host,
			grandchildSpawn.agentId,
			"probe-file-grandchild",
		),
		{ loaded: true },
	);
	assert.equal(grandchildProbe.sessionStarts, 1);
	assert.notEqual(grandchildProbe.instanceId, ownerInstanceId);
	assert.notEqual(grandchildProbe.instanceId, childProbeDetails.instanceId);
	assert.deepEqual(startedInstances.sort((left, right) => left - right), [1, 2, 3]);

	let extensionFreeTools: string[] | undefined;
	host.model.setResponses([
		(context) => {
			extensionFreeTools = context.tools?.map(({ name }) => name) ?? [];
			return fauxAssistantMessage(
				"The extension-free child started without inherited extensions.",
			);
		},
	]);
	const extensionFree = await executeRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-without-extensions",
		{
			request: "Start without inherited ordinary extensions.",
			config: { extensions: "none", tools: [] },
		},
	);
	const extensionFreeReceipt = extensionFree.details as AgentSpawnReceipt;
	assert.equal(extensionFreeReceipt.disposition, "pending");
	assert.ok("agentId" in extensionFreeReceipt);
	assert.deepEqual(extensionFreeReceipt.effectiveConfiguration.extensions, []);
	await waitForCondition(() => extensionFreeTools !== undefined);
	assert.equal(extensionFreeTools?.includes("inline_extension_probe"), false);
	assert.equal(extensionFreeTools?.includes("file_extension_probe"), false);

	await host.runtime.dispose();
});

test("missing, duplicate, and anonymous inline factories fail before Agent Identity", async (t) => {
	const namedFactory: ExtensionFactory = () => undefined;
	const cases: Array<{
		name: string;
		factories: InlineExtension[];
		afterLoad?: () => void;
	}> = [];
	const missingDescriptor: NamedInlineExtension = {
		name: "required-inline",
		factory: namedFactory,
	};
	cases.push({
		name: "missing current descriptor",
		factories: [missingDescriptor],
		afterLoad: () => {
			missingDescriptor.name = "renamed-after-owner-load";
		},
	});
	cases.push({
		name: "duplicate named descriptors",
		factories: [
			{ name: "duplicate-inline", factory: namedFactory },
			{ name: "duplicate-inline", factory: namedFactory },
		],
	});
	cases.push({
		name: "anonymous descriptor",
		factories: [namedFactory],
	});

	for (const sample of cases) {
		await t.test(sample.name, async () => {
			const host = await createTestOwnerHost(piAgentCoordination, {
				persistent: true,
				additionalExtensionFactories: sample.factories,
			});
			try {
				sample.afterLoad?.();
				const spawn = await executeRegisteredTool(
					host.session,
					"agent_spawn",
					`spawn-${sample.name.replaceAll(" ", "-")}`,
					{ request: "Do not commit an Agent Identity without inheritable resources." },
				);
				assert.deepEqual(spawn.details, {
					disposition: "not_created",
					failedStage: "identity_commit",
				});
				const children = await executeRegisteredTool(
					host.session,
					"agent_observe",
					`observe-${sample.name.replaceAll(" ", "-")}`,
					{ operation: "children" },
				);
				assert.deepEqual(children.details, { children: [] });
			} finally {
				await host.runtime.dispose();
			}
		});
	}
});

test("successor Runtime preparations re-resolve named inline factories and stay dormant when one disappears", async () => {
	let originalInvocations = 0;
	let replacementInvocations = 0;
	const createProbeFactory = (generation: "original" | "replacement"): ExtensionFactory =>
		(pi) => {
			if (generation === "original") originalInvocations += 1;
			else replacementInvocations += 1;
			pi.registerTool({
				name: "successor_inline_probe",
				label: "Successor inline probe",
				description: "Reports which current factory created this Run.",
				parameters: Type.Object({}, { additionalProperties: false }),
				async execute() {
					return {
						content: [{ type: "text", text: generation }],
						details: { generation },
					};
				},
			});
		};
	const descriptor: NamedInlineExtension = {
		name: "successor-inline-probe",
		factory: createProbeFactory("original"),
	};
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [descriptor],
	});
	host.model.setResponses([
		fauxAssistantMessage("The first Run loaded the original factory."),
		fauxAssistantMessage(
			fauxToolCall("successor_inline_probe", {}, { id: "probe-replacement-inline-run" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The successor Run loaded the replacement factory."),
	]);

	const spawn = await executeRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-successor-inline-probe",
		{ request: "Start with the original inline factory." },
	);
	const receipt = spawn.details as AgentSpawnReceipt;
	assert.equal(receipt.disposition, "pending");
	assert.ok("agentId" in receipt);
	await waitForCondition(() => originalInvocations === 2);
	await waitForAgentTranscriptText(
		host,
		receipt.agentId,
		"The first Run loaded the original factory.",
	);
	await executeRegisteredTool(
		host.session,
		"agent_control",
		"terminate-original-inline-run",
		{ operation: "terminate", agentId: receipt.agentId },
	);

	descriptor.factory = createProbeFactory("replacement");
	const successor = await executeRegisteredTool(
		host.session,
		"agent_message",
		"start-replacement-inline-run",
		{
			operation: "send",
			targetAgentId: receipt.agentId,
			content: "Start a successor with the current inline factory.",
		},
	);
	assert.equal((successor.details as { delivery: string }).delivery, "pending");
	await waitForCondition(() => replacementInvocations === 1);
	assert.deepEqual(
		await waitForAgentToolResult(
			host,
			receipt.agentId,
			"probe-replacement-inline-run",
		),
		{ generation: "replacement" },
	);

	await executeRegisteredTool(
		host.session,
		"agent_control",
		"terminate-replacement-inline-run",
		{ operation: "terminate", agentId: receipt.agentId },
	);
	descriptor.name = "renamed-successor-inline-probe";
	const unavailable = await executeRegisteredTool(
		host.session,
		"agent_message",
		"start-missing-inline-run",
		{
			operation: "send",
			targetAgentId: receipt.agentId,
			content: "This successor must remain unavailable.",
		},
	);
	assert.deepEqual(
		{
			delivery: (unavailable.details as { delivery: string }).delivery,
			rejectionReason: (unavailable.details as { rejectionReason: string }).rejectionReason,
		},
		{ delivery: "rejected", rejectionReason: "target_unavailable" },
	);
	const status = await executeRegisteredTool(
		host.session,
		"agent_observe",
		"observe-missing-inline-successor",
		{ operation: "status", agentId: receipt.agentId },
	);
	assert.equal((status.details as { run: { phase: string } }).run.phase, "dormant");

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

test("ambiguous selected skills fail before Agent Identity", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	const piSkillDirectory = join(host.cwd, ".pi", "skills", "pi-copy");
	const agentsSkillDirectory = join(host.cwd, ".agents", "skills", "agents-copy");
	await mkdir(piSkillDirectory, { recursive: true });
	await mkdir(agentsSkillDirectory, { recursive: true });
	const skill = [
		"---",
		"name: colliding-skill",
		"description: Deliberate collision fixture",
		"---",
		"Exercise the selected resource collision boundary.",
	].join("\n");
	await writeFile(join(piSkillDirectory, "SKILL.md"), skill);
	await writeFile(join(agentsSkillDirectory, "SKILL.md"), skill);
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{
					request: "This request must never acquire a child.",
					config: { skills: ["colliding-skill"] },
				},
				{ id: "spawn-ambiguous-skill" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The child was not created."),
	]);

	await host.session.prompt("Try an ambiguous child skill selection.");
	await host.session.waitForIdle();

	assert.deepEqual(findSpawnReceipt(host.session.sessionManager), {
		disposition: "not_created",
		failedStage: "identity_commit",
	});

	await host.runtime.dispose();
});

test("an untrusted effective cwd cannot contribute selected project resources", async () => {
	const harness = await createCoordinatorHarness({});
	const effectiveCwd = join(harness.host.cwd, "untrusted-project");
	const skillDirectory = join(effectiveCwd, ".agents", "skills", "untrusted-skill");
	await mkdir(skillDirectory, { recursive: true });
	await writeFile(
		join(skillDirectory, "SKILL.md"),
		[
			"---",
			"name: untrusted-skill",
			"description: Must remain unavailable",
			"---",
			"This project resource requires trust.",
		].join("\n"),
	);
	new ProjectTrustStore(harness.host.services.agentDir).set(effectiveCwd, false);

	const receipt = await harness.spawn("spawn-untrusted-project-resource", {
		request: "This request must never acquire a child.",
		config: {
			cwd: "untrusted-project",
			skills: ["untrusted-skill"],
		},
	});

	assert.deepEqual(receipt, {
		disposition: "not_created",
		failedStage: "identity_commit",
	});
	assert.deepEqual(harness.view.children(), []);

	await harness.shutdown();
});

test("effective cwd honors Pi's default project-trust policy", async () => {
	const harness = await createCoordinatorHarness({});
	harness.host.services.settingsManager.setDefaultProjectTrust("always");
	const effectiveCwd = join(harness.host.cwd, "default-trusted-project");
	const skillDirectory = join(effectiveCwd, ".agents", "skills", "trusted-skill");
	await mkdir(skillDirectory, { recursive: true });
	await writeFile(
		join(skillDirectory, "SKILL.md"),
		[
			"---",
			"name: trusted-skill",
			"description: Available under the global trust policy",
			"---",
			"This project resource is trusted by policy.",
		].join("\n"),
	);

	const receipt = await harness.spawn("spawn-default-trusted-project", {
		request: "Use the policy-trusted skill.",
		config: {
			cwd: "default-trusted-project",
			skills: ["trusted-skill"],
		},
	});

	assert.equal(receipt.disposition, "pending");
	assert.deepEqual(receipt.effectiveConfiguration?.skills, ["trusted-skill"]);

	await harness.shutdown();
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
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator.forModerator(agentId)),
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

test("shutdown during child preparation prevents a post-snapshot Agent admission", async () => {
	const host = await createUnboundTestOwnerHost(() => undefined, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime, "<inline:pi-agent-coordination>");
	let shutdownPromise: Promise<void> | undefined;
	let coordinator!: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		childExtensionFactory: (agentId) => {
			shutdownPromise ??= coordinator.shutdown(async () => host.runtime.dispose());
			return createAgentBoundExtension(() => coordinator.forAgent(agentId));
		},
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator.forModerator(agentId)),
	});
	const view = coordinator.forAgent(identity.agentId);
	const input = { request: "This Agent must not join a Workflow already shutting down." };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", input, { id: "spawn-during-shutdown" }),
			{ stopReason: "toolUse" },
		),
	);

	const receipt = await view.spawn("spawn-during-shutdown", input);
	await shutdownPromise;

	assert.deepEqual(receipt, {
		disposition: "not_created",
		failedStage: "identity_commit",
	});
	assert.deepEqual(view.children(), []);
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

test("shutdown after Agent Identity keeps the durable child dormant", async () => {
	let shutdownPromise: Promise<void> | undefined;
	let harness!: Awaited<ReturnType<typeof createCoordinatorHarness>>;
	harness = await createCoordinatorHarness({
		beforeRunStart: () => {
			shutdownPromise ??= harness.shutdown();
		},
	});

	const receipt = await harness.spawn("spawn-identity-before-shutdown");
	await shutdownPromise;

	assert.equal(receipt.disposition, "created_unscheduled");
	assert.equal(receipt.failedStage, "run_start");
	assert.deepEqual(harness.view.children()[0]?.run, {
		phase: "dormant",
		retentionReasons: [],
	});
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

async function waitForChildSessionFile(
	cwd: string,
	sessionDirectory: string,
	agentId: string,
): Promise<string> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		const sessions = await SessionManager.list(cwd, sessionDirectory);
		const child = sessions.find((session) => session.id === agentId);
		if (child) return child.path;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error(`Child Pi session ${agentId} was not created`);
}

async function waitForEntry(
	sessionFile: string,
	predicate: (entry: ReturnType<SessionManager["getEntries"]>[number]) => boolean,
) {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		const entries = SessionManager.open(sessionFile).getEntries();
		if (entries.some(predicate)) return entries;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Expected child transcript entry did not commit");
}

async function waitForAgentTranscriptText(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
	expected: string,
): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		const entries = await agentTranscriptEntries(host, agentId, attempt);
		if (entries && JSON.stringify(entries).includes(expected)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error(`Agent ${agentId} transcript did not include ${expected}`);
}

async function waitForAgentToolResult(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
	toolCallId: string,
): Promise<unknown> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		const entries = await agentTranscriptEntries(host, agentId, attempt);
		const result = entries?.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId,
		);
		if (result?.type === "message" && result.message.role === "toolResult") {
			return result.message.details;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error(`Agent ${agentId} did not commit tool result ${toolCallId}`);
}

async function agentTranscriptEntries(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
	attempt: number,
): Promise<ReturnType<SessionManager["getEntries"]> | undefined> {
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const status = await observe.execute(
		`locate-agent-transcript-${agentId}-${attempt}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const transcriptPath = (status.details as {
		primaryEvidence: { transcriptPath: string | null };
	}).primaryEvidence.transcriptPath;
	return transcriptPath
		? SessionManager.open(transcriptPath).getEntries()
		: undefined;
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Expected condition did not become true");
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
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator.forModerator(agentId)),
		spawnBoundaryHooks: hooks,
	});
	const view = coordinator.forAgent(identity.agentId);

	return {
		host,
		view,
		async spawn(
			toolCallId: string,
			input: AgentSpawnInput = { request: `Creation Request for ${toolCallId}` },
		): Promise<AgentSpawnReceipt> {
			host.session.sessionManager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall(
						"agent_spawn",
						input,
						{ id: toolCallId },
					),
					{ stopReason: "toolUse" },
				),
			);
			return view.spawn(toolCallId, input);
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
