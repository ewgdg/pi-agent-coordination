import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	WorkflowCoordinator,
	type AgentSpawnInput,
	type AgentSpawnReceipt,
	type SpawnBoundaryHooks,
} from "../src/coordination/workflow-coordinator.ts";
import piAgentCoordination from "../src/index.ts";
import { resolveCommittedAgentRuntimeBlueprint } from "../src/protocol/agent-runtime-blueprint.ts";
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
import { capturedSessionManager } from "./support/captured-session-managers.ts";

const MAX_CONDITION_POLL_ATTEMPTS = 5_000;

test("an authenticated ordinary Agent creates a durable isolated child and admits its Creation Request", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		processVisibleModel: true,
	});
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
	const effectiveConfiguration = (
		spawnResult.message.details as AgentSpawnReceipt & {
			effectiveConfiguration: AgentSpawnReceipt["effectiveConfiguration"];
		}
	).effectiveConfiguration;
	assert.equal(effectiveConfiguration.extensions.length, 1);
	assert.match(effectiveConfiguration.extensions[0]!, /process-model-broker-extension\.mjs$/);
	const processExtensions = effectiveConfiguration.extensions;
	assert.deepEqual(
		effectiveConfiguration,
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
			extensions: processExtensions,
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
				tools: [
					"agent_message",
					"agent_spawn",
					"agent_observe",
					"agent_control",
				],
				skills: [],
				extensions: processExtensions,
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
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime, "<inline:pi-agent-coordination>");
	const templateRoot = join(host.cwd, "template-root");
	const effectiveCwd = join(host.cwd, "subproject");
	await mkdir(templateRoot, { recursive: true });
	await mkdir(join(effectiveCwd, ".agents", "agents"), { recursive: true });
	new ProjectTrustStore(host.services.agentDir).set(effectiveCwd, true);
	await writeFile(
		join(templateRoot, "research.md"),
		"---\nname: research-agent\nthinking: off\ntools: read\n---\nTemplate context",
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
	assert.equal(receipt.effectiveConfiguration.extensions.length, 1);
	assert.match(
		receipt.effectiveConfiguration.extensions[0]!,
		/process-model-broker-extension\.mjs$/,
	);
	const processExtensions = receipt.effectiveConfiguration.extensions;
	assert.deepEqual(receipt.effectiveConfiguration, {
		cwd: effectiveCwd,
		model: { provider: "coordination-test", modelId: "deterministic-owner" },
		thinking: "off",
		tools: [
			"read",
			"agent_message",
			"agent_control",
			"agent_observe",
			"agent_spawn",
			"ask_user_question",
		],
		skills: [],
		extensions: processExtensions,
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
		effectiveCwd,
		workflowDirectory,
		receipt.agentId,
	);
	const configuredChildTranscript = SessionManager.open(childSessionFile);
	const configuredChildEntries = configuredChildTranscript.getEntries();
	const childIdentity = configuredChildEntries.find(
		(entry) => entry.type === "custom" && entry.customType === "agent-coordination.identity",
	);
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
				extensions: processExtensions,
			},
		},
	);
	const runtimeBlueprint = resolveCommittedAgentRuntimeBlueprint({
		sessionId: configuredChildTranscript.getSessionId(),
		entries: configuredChildEntries,
	});
	assert.equal(runtimeBlueprint.agentId, receipt.agentId);
	assert.equal(runtimeBlueprint.role, "ordinary");
	assert.deepEqual(runtimeBlueprint.configuration, receipt.effectiveConfiguration);
	assert.equal(runtimeBlueprint.projectTrusted, true);
	assert.deepEqual(runtimeBlueprint.skillSources, []);
	assert.deepEqual(runtimeBlueprint.agentsFiles, [
		{ path: join(effectiveCwd, "AGENTS.md"), content: "Native effective-cwd context" },
		{
			path: `<agent-configuration:${receipt.agentId}>`,
			content: "Template context\n\nSpawn context",
		},
	]);

	const agentId = receipt.agentId;
	await waitForCondition(() => {
		const run = view.status(agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	const terminationInput = { operation: "terminate" as const, agentId };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", terminationInput, {
				id: "terminate-configured-child-v1",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const termination = await view.control(
		"terminate-configured-child-v1",
		terminationInput,
	);
	assert.ok("disposition" in termination);
	assert.equal(termination.disposition, "terminated");
	await writeFile(
		join(templateRoot, "research.md"),
		"---\nname: research-agent\nthinking: off\ntools: read\n---\nChanged Template context",
	);
	await writeFile(join(effectiveCwd, "AGENTS.md"), "Changed effective-cwd context");
	let successorSystemPrompt = "";
	host.model.setResponses([
		(context) => {
			successorSystemPrompt = context.systemPrompt ?? "";
			return fauxAssistantMessage("Committed blueprint successor observed.");
		},
	]);
	const successorInput = {
		operation: "send" as const,
		targetAgentId: agentId,
		content: "Start a successor from the already committed blueprint.",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", successorInput, { id: "start-configured-child-v2" }),
			{ stopReason: "toolUse" },
		),
	);
	const successorReceipt = await view.message(
		"start-configured-child-v2",
		successorInput,
	);
	assert.ok("delivery" in successorReceipt);
	assert.equal(successorReceipt.delivery, "pending");
	await waitForCondition(() => successorSystemPrompt.length > 0);
	assert.match(successorSystemPrompt, /Native effective-cwd context/);
	assert.match(successorSystemPrompt, /Template context/);
	assert.match(successorSystemPrompt, /Spawn context/);
	assert.doesNotMatch(successorSystemPrompt, /Changed (?:Template|effective-cwd) context/);
	assert.deepEqual(
		resolveCommittedAgentRuntimeBlueprint({
			sessionId: agentId,
			entries: SessionManager.open(childSessionFile).getEntries(),
		}),
		runtimeBlueprint,
	);
	await coordinator.shutdown(async () => host.runtime.dispose());
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
	await mkdir(harness.host.services.agentDir, { recursive: true });
	await writeFile(
		join(harness.host.services.agentDir, "settings.json"),
		`${JSON.stringify({ defaultProjectTrust: "always" }, null, 2)}\n`,
	);
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
	assert.ok(receipt.agentId);
	const childSession = capturedSessionManager(receipt.agentId);
	const runtimeBlueprint = resolveCommittedAgentRuntimeBlueprint({
		sessionId: childSession.getSessionId(),
		entries: childSession.getEntries(),
	});
	assert.deepEqual(runtimeBlueprint.skillSources, [{
		name: "trusted-skill",
		path: join(skillDirectory, "SKILL.md"),
	}]);
	assert.equal(runtimeBlueprint.projectTrusted, true);

	await harness.shutdown();
});

test("unavailable inherited tools remain in the committed blueprint when process startup rejects them", async () => {
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

	assert.equal(receipt.disposition, "created_unscheduled");
	assert.ok("agentId" in receipt);
	assert.equal(receipt.failedStage, "run_start");
	assert.deepEqual(harness.view.children()[0]?.run, {
		phase: "dormant",
		retentionReasons: [],
	});
	const childSession = capturedSessionManager(receipt.agentId);
	const runtimeBlueprint = resolveCommittedAgentRuntimeBlueprint({
		sessionId: receipt.agentId,
		entries: childSession.getEntries(),
	});
	assert.deepEqual(runtimeBlueprint.configuration, receipt.effectiveConfiguration);
	assert.ok(runtimeBlueprint.configuration.tools.includes("owner_only_probe"));
	assert.equal(runtimeBlueprint.configuration.extensions.length, 1);
	assert.match(
		runtimeBlueprint.configuration.extensions[0]!,
		/process-model-broker-extension\.mjs$/,
	);

	await harness.shutdown();
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
		afterRunStart: (context) => {
			assert.deepEqual(Object.keys(context).sort(), ["handle", "identity"]);
			assert.equal(context.handle.sequence > 0, true);
			return "confirmation_lost";
		},
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
		afterIdentityCommit: ({ identity }) => {
			capturedSessionManager(identity.agentId).appendCustomEntry(
				"agent-coordination.identity",
				{
				...identity,
					spawnSource: { ...identity.spawnSource, toolCallId: "contradictory-source" },
				},
			);
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
		afterIdentityCommit: ({ identity }) => {
			capturedSessionManager(identity.agentId).appendCustomMessageEntry(
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
	const host = await createUnboundTestOwnerHost(ownerExtension, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime, "<inline:pi-agent-coordination>");
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
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
