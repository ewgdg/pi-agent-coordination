import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import {
	createAgentBoundExtension,
	createModeratorBoundExtension,
} from "../src/bootstrap/agent-extension.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

const MAX_CONDITION_POLL_ATTEMPTS = 1_000;

test("a settled answer-obligated Agent creates one atomic Obligation Stall Moderator", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	let moderatorTools: string[] = [];
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Answer this Creation Request after completing the work." },
				{ id: "spawn-stalled-agent" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The child is now responsible for the Request."),
		fauxAssistantMessage("I settled without discharging the Answer obligation."),
		(context) => {
			moderatorTools = context.tools?.map(({ name }) => name).sort() ?? [];
			return fauxAssistantMessage("I will inspect the stalled obligation.");
		},
	]);

	await host.session.prompt("Create an Agent that will demonstrate a Stall.");
	await host.session.waitForIdle();

	const moderator = await waitForModerator(host);
	const ownerIdentity = host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "agent-coordination.identity",
	);
	assert.ok(ownerIdentity && ownerIdentity.type === "custom");
	const spawnSourceEntry = host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === "spawn-stalled-agent",
			),
	);
	assert.ok(spawnSourceEntry);
	const spawnSource = {
		agentId: host.session.sessionId,
		entryId: spawnSourceEntry.id,
		toolCallId: "spawn-stalled-agent",
	};
	const moderatorTranscript = SessionManager.open(moderator.path);
	const moderatorInput = moderatorTranscript.getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(moderatorInput && moderatorInput.type === "custom_message");
	assert.equal(moderatorInput.parentId, null);
	assert.equal(moderatorInput.display, true);
	assert.deepEqual(moderatorInput.details, {
		agentId: moderator.id,
		workflowId: host.session.sessionId,
		configuration: {
			label: "moderator",
			description: "obligation stall",
			baseline: (ownerIdentity.data as {
				configuration: { baseline: unknown };
			}).configuration.baseline,
		},
	});
	const input = JSON.parse(moderatorInput.content as string) as {
		trigger: {
			kind: string;
			agentId: string;
			obligations: { total: number; sources: unknown[] };
		};
		inspectedThrough: Array<{ agentId: string; entryId: string }>;
	};
	assert.equal(input.trigger.kind, "obligation_stall");
	assert.equal(input.trigger.obligations.total, 1);
	assert.deepEqual(input.trigger.obligations.sources, [spawnSource]);
	assert.deepEqual(input.inspectedThrough, [
		{
			agentId: input.trigger.agentId,
			entryId: await transcriptTailFor(host, input.trigger.agentId),
		},
	]);
	assert.deepEqual(moderatorTools, [
		"agent_control",
		"agent_message",
		"agent_observe",
		"ask_user_question",
		"moderator_control",
	]);

	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const statusResult = await observe.execute(
		"observe-created-moderator",
		{ operation: "status", agentId: moderator.id },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.deepEqual(
		{
			agentId: (statusResult.details as { agentId: string }).agentId,
			label: (statusResult.details as { label: string }).label,
			directSpawnerAgentId: (statusResult.details as {
				directSpawnerAgentId: string | null;
			}).directSpawnerAgentId,
		},
		{ agentId: moderator.id, label: "moderator", directSpawnerAgentId: null },
	);

	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal((await findModerators(host)).length, 1);

	await host.runtime.dispose();
});

test("Moderator Resolution is blocked while the Obligation Stall remains", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Leave this Answer obligation unresolved." },
				{ id: "spawn-resolution-blocker" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The unresolved Request is delegated."),
		fauxAssistantMessage("I settled without an Answer."),
		fauxAssistantMessage(
			fauxToolCall(
				"moderator_control",
				{
					operation: "resolve",
					summary: "The Agent remains stalled.",
					rationale: "The qualifying Answer obligation is still unresolved.",
				},
				{ id: "resolve-active-stall" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Resolution remains blocked."),
	]);

	await host.session.prompt("Create a blocked moderation case.");
	await host.session.waitForIdle();
	const moderator = await waitForModerator(host);
	const result = await waitForTranscriptEntry(
		moderator.path,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === "resolve-active-stall",
	);
	assert.ok(result.type === "message" && result.message.role === "toolResult");
	assert.equal(result.message.isError, false);
	assert.deepEqual(result.message.details, {
		disposition: "blocked",
		predicates: ["obligation_stall"],
	});
	assert.equal((await findModerators(host)).length, 1);

	await host.runtime.dispose();
});

test("a Moderator observes the Workflow and controls only non-Owner Runs", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Settle with an Answer obligation for supervision." },
				{ id: "spawn-moderator-control-target" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The control target is delegated."),
		fauxAssistantMessage("I settled without answering."),
		(context) => {
			const input = context.messages.flatMap((message) => {
				if (message.role !== "user") return [];
				if (typeof message.content === "string") return [message.content];
				return message.content.flatMap((part) =>
					part.type === "text" ? [part.text] : []
				);
			}).find((content) => content.includes('"kind":"obligation_stall"'));
			assert.ok(input);
			const affectedAgentId = (JSON.parse(input) as {
				trigger: { agentId: string };
			}).trigger.agentId;
			return fauxAssistantMessage(
				[
					fauxToolCall(
						"agent_observe",
						{ operation: "status", agentId: affectedAgentId },
						{ id: "moderator-observe-affected" },
					),
					fauxToolCall(
						"agent_control",
						{ operation: "interrupt", agentId: affectedAgentId },
						{ id: "moderator-interrupt-affected" },
					),
					fauxToolCall(
						"agent_control",
						{ operation: "interrupt", agentId: host.session.sessionId },
						{ id: "moderator-interrupt-owner" },
					),
				],
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage(
			fauxToolCall(
				"moderator_control",
				{
					operation: "resolve",
					summary: "The affected Run is held for safe diagnosis.",
					rationale: "The Hold restores an explicit progress boundary.",
				},
				{ id: "resolve-after-restoring-progress" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Moderation resolved after restoring progress."),
	]);

	await host.session.prompt("Create a Moderator supervision case.");
	await host.session.waitForIdle();
	const moderator = await waitForModerator(host);
	const observed = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "moderator-observe-affected",
	);
	assert.ok(observed.type === "message" && observed.message.role === "toolResult");
	assert.equal(observed.message.isError, false);
	const affectedAgentId = (observed.message.details as { agentId: string }).agentId;

	const controlled = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "moderator-interrupt-affected",
	);
	assert.ok(controlled.type === "message" && controlled.message.role === "toolResult");
	assert.equal(controlled.message.isError, false);
	assert.equal(
		(controlled.message.details as { disposition: string }).disposition,
		"held",
	);
	const affected = await observeStatus(host, affectedAgentId);
	assert.equal(
		affected.run.retentionReasons.some(({ reason }) => reason === "interruption_hold"),
		true,
	);

	const ownerControl = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "moderator-interrupt-owner",
	);
	assert.ok(ownerControl.type === "message" && ownerControl.message.role === "toolResult");
	assert.equal(ownerControl.message.isError, true);
	const resolution = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "resolve-after-restoring-progress",
	);
	assert.ok(resolution.type === "message" && resolution.message.role === "toolResult");
	assert.deepEqual(resolution.message.details, { disposition: "resolved" });

	await host.runtime.dispose();
});

test("a Moderator escalates through an ordinary Owner Request before Resolution", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Leave an Answer obligation requiring Owner judgment." },
				{ id: "spawn-moderator-escalation-case" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The escalation case is delegated."),
		fauxAssistantMessage("I settled without resolving the Owner's intent."),
		fauxAssistantMessage(
			[
				fauxToolCall(
					"agent_message",
					{
						operation: "request",
						targetAgentId: host.session.sessionId,
						question: "Should restoring this work take priority over current Owner work?",
					},
					{ id: "moderator-request-owner-judgment" },
				),
				fauxToolCall(
					"moderator_control",
					{
						operation: "resolve",
						summary: "Owner judgment is still outstanding.",
						rationale: "Priority cannot be inferred mechanically.",
					},
					{ id: "resolve-before-owner-answer" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The Owner Request is visible."),
		fauxAssistantMessage("I will wait for the Owner Answer."),
	]);

	await host.session.prompt("Create a moderation escalation case.");
	await host.session.waitForIdle();
	const moderator = await waitForModerator(host);
	const requestResult = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "moderator-request-owner-judgment",
	);
	assert.ok(requestResult.type === "message" && requestResult.message.role === "toolResult");
	assert.equal(requestResult.message.isError, false);
	const requestId = (requestResult.message.details as { requestId: string }).requestId;
	const requestSource = SessionManager.open(moderator.path).getEntries().find(
		(entry) => entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" &&
					part.id === "moderator-request-owner-judgment",
			),
	);
	assert.ok(requestSource);
	assert.equal(
		requestId,
		deriveMessageIdentity({
			agentId: moderator.id,
			entryId: requestSource.id,
			toolCallId: "moderator-request-owner-judgment",
		}),
	);

	await waitForCondition(async () => {
		const owner = await observeStatus(host, host.session.sessionId);
		const moderatorStatus = await observeStatus(host, moderator.id);
		return owner.run.retentionReasons.some(
			({ reason }) => reason === "answer_owed",
		) && moderatorStatus.run.retentionReasons.some(
			({ reason }) => reason === "awaiting_answer",
		);
	});
	const blocked = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "resolve-before-owner-answer",
	);
	assert.ok(blocked.type === "message" && blocked.message.role === "toolResult");
	assert.deepEqual(blocked.message.details, {
		disposition: "blocked",
		predicates: ["outgoing_requests", "obligation_stall"],
	});

	host.model.setResponses([
		fauxAssistantMessage("The Owner Answer is now available to the Moderator."),
	]);
	await answerAsOwner(
		host,
		requestId,
		"Restore the obligated work before taking unrelated new work.",
		"answer-moderator-escalation",
	);
	await waitForCondition(async () => {
		const owner = await observeStatus(host, host.session.sessionId);
		const moderatorStatus = await observeStatus(host, moderator.id);
		return !owner.run.retentionReasons.some(
			({ reason }) => reason === "answer_owed",
		) && !moderatorStatus.run.retentionReasons.some(
			({ reason }) => reason === "awaiting_answer",
		);
	});

	await host.runtime.dispose();
});

test("external Answer clearance releases Moderator handling", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Answer after the Owner sends one reminder." },
				{ id: "spawn-externally-cleared-agent" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The child may need a reminder."),
		fauxAssistantMessage("I settled before answering."),
		fauxAssistantMessage("I am inspecting while the obligation remains."),
	]);

	await host.session.prompt("Create an externally cleared Stall.");
	await host.session.waitForIdle();
	const moderator = await waitForModerator(host);
	const moderatorInput = SessionManager.open(moderator.path).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(moderatorInput && moderatorInput.type === "custom_message");
	const parsedInput = JSON.parse(moderatorInput.content as string) as {
		trigger: {
			agentId: string;
			obligations: {
				sources: Array<{ agentId: string; entryId: string; toolCallId: string }>;
			};
		};
	};
	const requestSource = parsedInput.trigger.obligations.sources[0];
	assert.ok(requestSource);
	const requestId = deriveMessageIdentity(requestSource);

	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "answer",
					requestId,
					answer: "The reminder restored enough context to answer.",
				},
				{ id: "answer-after-reminder" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				{
					questions: [
						{
							kind: "text",
							header: "Pause",
							prompt: "Keep this Run active after its Answer commits.",
							multiline: false,
						},
					],
				},
				{ id: "wait-after-answer-clearance" },
			),
			{ stopReason: "toolUse" },
		),
	]);
	await sendOwnerMessage(
		host,
		parsedInput.trigger.agentId,
		"Please finish the Answer you still owe.",
		"remind-stalled-agent",
	);

	await waitForCondition(async () => {
		const child = await observeStatus(host, parsedInput.trigger.agentId);
		return !child.run.retentionReasons.some(
			({ reason }) => reason === "answer_owed",
		);
	});
	await waitForCondition(async () => {
		const status = await observeStatus(host, moderator.id);
		return status.run.phase === "live" &&
			!status.run.retentionReasons.some(
				({ reason }) => reason === "moderator_handling",
			);
	});
	assert.equal((await findModerators(host)).length, 1);
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"moderator_control",
				{
					operation: "resolve",
					summary: "The original Answer obligation cleared independently.",
					rationale: "No mechanically qualifying obligation remains.",
				},
				{ id: "resolve-after-external-clearance" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The condition was already clear."),
	]);
	await sendOwnerMessage(
		host,
		moderator.id,
		"Record the disposition now that the obligation is clear.",
		"wake-moderator-after-clearance",
	);
	const clearedResolution = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "resolve-after-external-clearance",
	);
	assert.ok(
		clearedResolution.type === "message" &&
		clearedResolution.message.role === "toolResult",
	);
	assert.deepEqual(clearedResolution.message.details, {
		disposition: "already_cleared",
	});

	await host.runtime.dispose();
});

test("a cleared Stall can recur with the same obligations and receive a fresh Moderator", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Keep this Answer obligation until after one supervised resume." },
				{ id: "spawn-recurring-stall-agent" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The recurring Stall case is delegated."),
		fauxAssistantMessage("I settled before answering."),
		fauxAssistantMessage("I am handling the first continuous Stall."),
	]);

	await host.session.prompt("Create a recurring Obligation Stall.");
	await host.session.waitForIdle();
	const firstModerator = await waitForModerator(host);
	const affectedAgentId = moderatorAffectedAgentId(firstModerator.path);

	await controlAsOwner(host, "interrupt-recurring-stall", {
		operation: "interrupt",
		agentId: affectedAgentId,
	});
	await waitForCondition(async () => {
		const affected = await observeStatus(host, affectedAgentId);
		const moderator = await observeStatus(host, firstModerator.id);
		return affected.run.retentionReasons.some(
			({ reason }) => reason === "interruption_hold",
		) && !moderator.run.retentionReasons.some(
			({ reason }) => reason === "moderator_handling",
		);
	});

	host.model.setResponses([
		fauxAssistantMessage("I settled again without answering after the Hold cleared."),
		fauxAssistantMessage("I am handling the new continuous Stall."),
	]);
	await controlAsOwner(host, "resume-recurring-stall", {
		operation: "resume",
		agentId: affectedAgentId,
		content: "Resume this exact Run, then settle without answering.",
	});
	await waitForCondition(async () => (await findModerators(host)).length === 2);
	const moderators = await findModerators(host);
	const secondModerator = moderators.find(({ id }) => id !== firstModerator.id);
	assert.ok(secondModerator);
	assert.equal(moderatorAffectedAgentId(secondModerator.path), affectedAgentId);

	await host.runtime.dispose();
});

test("an outgoing Request suppresses a Stall only while its responder can progress", async (t) => {
	const registryKey = Symbol.for("pi-agent-coordination.test.execution-gate");
	let targetStarted!: () => void;
	const targetStart = new Promise<void>((resolve) => {
		targetStarted = resolve;
	});
	let releaseTarget!: () => void;
	const targetRelease = new Promise<void>((resolve) => {
		releaseTarget = resolve;
	});
	(globalThis as Record<PropertyKey, unknown>)[registryKey] = {
		async execute() {
			targetStarted();
			await targetRelease;
		},
	};
	let targetReleased = false;
	let coordinator: WorkflowCoordinator | undefined;
	let host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>> | undefined;
	t.after(async () => {
		if (!targetReleased) releaseTarget();
		delete (globalThis as Record<PropertyKey, unknown>)[registryKey];
		if (coordinator && host) {
			await coordinator.shutdown(async () => host!.runtime.dispose());
		}
	});

	host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionPaths: [
			fileURLToPath(new URL("./support/execution-gate-tool.ts", import.meta.url)),
		],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let rejectNextCreationDelivery = true;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator!.forAgent(agentId)),
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator!.forModerator(agentId)),
		spawnBoundaryHooks: {
			beforeDeliveryAdmission() {
				if (!rejectNextCreationDelivery) return;
				rejectNextCreationDelivery = false;
				return "confirmed_failure";
			},
		},
	});
	const owner = coordinator.forAgent(identity.agentId);
	const target = await spawnFromView(
		host.session,
		owner,
		"spawn-progress-target",
		"Remain dormant until another Agent requests progress.",
	);
	assert.equal(target.disposition, "created_unscheduled");
	assert.equal(owner.status(target.agentId).run.phase, "dormant");

	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_message",
				{
					operation: "request",
					targetAgentId: target.agentId,
					question: "Make progress while I remain obligated to the Owner.",
				},
				{ id: "request-external-progress" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("execution_gate", {}, { id: "hold-external-progress" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("I am settled while the responder remains active."),
		fauxAssistantMessage("I settled without answering the downstream Request."),
	]);
	const affected = await spawnFromView(
		host.session,
		owner,
		"spawn-agent-with-external-progress",
		"Delegate progress, then settle without answering this Creation Request.",
	);
	assert.equal(affected.disposition, "pending");
	await targetStart;
	await waitForCondition(() => {
		const run = owner.status(affected.agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	for (let attempt = 0; attempt < 50; attempt += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.equal((await findModerators(host!)).length, 0);

	targetReleased = true;
	releaseTarget();
	await waitForCondition(() => {
		const run = owner.status(target.agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	await waitForModeratorForAgent(host!, affected.agentId);
});

test("a pre-commit Moderator bootstrap failure creates no Agent", async () => {
	const harness = await createIncidentBoundaryHarness({
		beforeModeratorBootstrapCommit: () => "confirmed_failure",
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I settled without answering the Creation Request."),
	]);
	const affected = await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-pre-commit-moderator-failure",
		"Settle with an Answer obligation.",
	);
	await waitForCondition(() => {
		const run = harness.owner.status(affected.agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	await waitForCondition(() =>
		harness.host.services.diagnostics.some(
			({ message }) => message.includes("Moderator bootstrap commit failure"),
		)
	);
	assert.equal((await findModerators(harness.host)).length, 0);
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("a post-commit Moderator startup failure leaves a valid dormant Agent", async () => {
	const harness = await createIncidentBoundaryHarness({
		beforeModeratorRunStart: () => "confirmed_failure",
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I settled without answering the Creation Request."),
	]);
	await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-post-commit-moderator-failure",
		"Settle with an Answer obligation.",
	);
	const moderator = await waitForModerator(harness.host);
	assert.deepEqual(harness.owner.status(moderator.id).run, {
		phase: "dormant",
		retentionReasons: [],
	});
	const entries = SessionManager.open(moderator.path).getEntries();
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.type, "custom_message");
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

async function waitForModerator(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
): Promise<{ id: string; path: string }> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		const moderators = await findModerators(host);
		if (moderators[0]) return moderators[0];
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected an Obligation Stall Moderator");
}

async function waitForModeratorForAgent(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
): Promise<{ id: string; path: string }> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		for (const moderator of await findModerators(host)) {
			const input = SessionManager.open(moderator.path).getEntries().find(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "agent-coordination.moderator-input",
			);
			if (
				input?.type === "custom_message" &&
				typeof input.content === "string" &&
				(JSON.parse(input.content) as { trigger?: { agentId?: string } }).trigger
					?.agentId === agentId
			) return moderator;
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`Expected an Obligation Stall Moderator for Agent ${agentId}`);
}

async function spawnFromView(
	session: AgentSession,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	toolCallId: string,
	request: string,
): Promise<{
	disposition: "pending" | "created_unscheduled" | "indeterminate";
	agentId: string;
}> {
	const input = { request };
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.spawn(toolCallId, input);
	if (!("agentId" in receipt) || typeof receipt.agentId !== "string") {
		throw new Error(`Agent Spawn ${toolCallId} did not commit an Agent identity`);
	}
	return { disposition: receipt.disposition, agentId: receipt.agentId };
}

async function createIncidentBoundaryHarness(
	incidentBoundaryHooks: {
		beforeModeratorBootstrapCommit?(): void | "confirmed_failure";
		beforeModeratorRunStart?(): void | "confirmed_failure";
	},
) {
	const host = await createUnboundTestOwnerHost(() => undefined, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let coordinator!: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator.forModerator(agentId)),
		incidentBoundaryHooks,
	});
	return { host, coordinator, owner: coordinator.forAgent(identity.agentId) };
}

async function findModerators(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
): Promise<Array<{ id: string; path: string }>> {
	const sessionDirectory = host.session.sessionManager.getSessionDir();
	const workflowDirectory = `${sessionDirectory}/pi-agent-coordination/${Buffer.from(
		host.session.sessionId,
		"utf8",
	).toString("base64url")}`;
	const sessions = await SessionManager.list(host.cwd, workflowDirectory);
	return sessions.flatMap(({ id, path }) => {
		const isModerator = SessionManager.open(path).getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.moderator-input",
		);
		return isModerator ? [{ id, path }] : [];
	});
}

async function transcriptTailFor(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
): Promise<string> {
	const sessionDirectory = host.session.sessionManager.getSessionDir();
	const workflowDirectory = `${sessionDirectory}/pi-agent-coordination/${Buffer.from(
		host.session.sessionId,
		"utf8",
	).toString("base64url")}`;
	const session = (await SessionManager.list(host.cwd, workflowDirectory)).find(
		(candidate) => candidate.id === agentId,
	);
	assert.ok(session);
	const tail = SessionManager.open(session.path).getEntries().at(-1);
	assert.ok(tail);
	return tail.id;
}

async function waitForTranscriptEntry(
	sessionFile: string,
	predicate: (
		entry: ReturnType<SessionManager["getEntries"]>[number],
	) => boolean,
) {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		const entry = SessionManager.open(sessionFile).getEntries().find(predicate);
		if (entry) return entry;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected Moderator transcript entry did not commit");
}

async function sendOwnerMessage(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	targetAgentId: string,
	content: string,
	toolCallId: string,
): Promise<void> {
	const input = { operation: "send" as const, targetAgentId, content };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const message = host.session.getToolDefinition("agent_message");
	assert.ok(message);
	const result = await message.execute(
		toolCallId,
		input,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
}

async function controlAsOwner(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	toolCallId: string,
	input:
		| { operation: "interrupt"; agentId: string }
		| { operation: "resume"; agentId: string; content: string },
): Promise<void> {
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const control = host.session.getToolDefinition("agent_control");
	assert.ok(control);
	await control.execute(
		toolCallId,
		input,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
}

function moderatorAffectedAgentId(sessionFile: string): string {
	const input = SessionManager.open(sessionFile).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(input?.type === "custom_message" && typeof input.content === "string");
	return (JSON.parse(input.content) as { trigger: { agentId: string } }).trigger.agentId;
}

async function answerAsOwner(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	requestId: string,
	answer: string,
	toolCallId: string,
): Promise<void> {
	const input = { operation: "answer" as const, requestId, answer };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const message = host.session.getToolDefinition("agent_message");
	assert.ok(message);
	const result = await message.execute(
		toolCallId,
		input,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
}

async function observeStatus(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
): Promise<{
	run:
		| { phase: "dormant"; retentionReasons: readonly [] }
		| {
			phase: "starting" | "live" | "ending";
			retentionReasons: ReadonlyArray<{ reason: string; count: number }>;
		};
}> {
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const result = await observe.execute(
		`observe-${agentId}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	return result.details as Awaited<ReturnType<typeof observeStatus>>;
}

async function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected incident condition did not become true");
}
