import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	type Context,
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
import {
	WorkflowPolicyStore,
	parseWorkflowPolicy,
} from "../src/policy/workflow-policy.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { HumanRequestSurface } from "../src/presentation/human-request-surface.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";
import {
	executeAndCommitRegisteredTool,
	selectAgent,
	selectDormantAgent,
} from "./support/agent-session.ts";
import { ControllableOperationReviewClock } from "./support/controllable-operation-review-clock.ts";

const MAX_CONDITION_POLL_ATTEMPTS = 1_000;

test("a settled answer-obligated Agent creates one atomic Obligation Stall Moderator", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
	});
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

	const termination = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-moderator-for-footer-status",
		{ operation: "terminate", agentId: moderator.id },
	);
	assert.equal((termination.details as { disposition: string }).disposition, "terminated");
	await selectDormantAgent(host, moderator.id);
	const moderatorStatus = [...host.ui.statuses.values()].find((value) =>
		value.startsWith("○ moderator · ") && value.endsWith(" · Dormant")
	);
	assert.ok(moderatorStatus);
	const compactModeratorIdentity = moderatorStatus.slice(
		"○ moderator · ".length,
		-" · Dormant".length,
	);
	assert.ok(moderator.id.endsWith(compactModeratorIdentity));
	host.ui.statuses.set("third-party-status", "keep me");
	await selectAgent(host, host.session.sessionId);
	assert.equal(
		[...host.ui.statuses.values()].some((value) => value.startsWith("○ moderator · ")),
		false,
	);
	assert.equal(host.ui.statuses.get("third-party-status"), "keep me");

	await host.runtime.dispose();
});

test("an overdue answer-obligated root call creates one minimal Operation Review Moderator", async (t) => {
	const registryKey = Symbol.for("pi-agent-coordination.test.execution-gate");
	let toolStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		toolStarted = resolve;
	});
	let releaseTool!: () => void;
	const released = new Promise<void>((resolve) => {
		releaseTool = resolve;
	});
	(globalThis as Record<PropertyKey, unknown>)[registryKey] = {
		async execute() {
			toolStarted();
			await released;
		},
	};
	t.after(() => {
		delete (globalThis as Record<PropertyKey, unknown>)[registryKey];
	});
	const clock = new ControllableOperationReviewClock();
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		implicitModeratorResponses: false,
		additionalExtensionPaths: [
			fileURLToPath(new URL("./support/execution-gate-tool.ts", import.meta.url)),
		],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let coordinator!: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		workflowPolicy: new WorkflowPolicyStore(
			parseWorkflowPolicy('{"operationReviewIntervalMs":1000}'),
		),
		operationReviewClock: clock,
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator.forModerator(agentId)),
	});
	const owner = coordinator.forAgent(identity.agentId);
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("execution_gate", {}, { id: "overdue-root-call" }),
			{ stopReason: "toolUse" },
		),
		(context) => {
			const content = context.messages.flatMap((message) => {
				if (message.role !== "user") return [];
				if (typeof message.content === "string") return [message.content];
				return message.content.flatMap((part) =>
					part.type === "text" ? [part.text] : []
				);
			}).find((candidate) => candidate.includes('"kind":"operation_review"'));
			assert.ok(content);
			const trigger = (JSON.parse(content) as {
				trigger: {
					toolCall: { agentId: string; entryId: string; toolCallId: string };
				};
			}).trigger;
			return fauxAssistantMessage(
				fauxToolCall(
					"moderator_control",
					{
						operation: "renew_review_deadline",
						toolCall: trigger.toolCall,
						nextReviewInMs: 500,
						rationale: "The exact call remains safe to observe for another short interval.",
					},
					{ id: "renew-overdue-root-call" },
				),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("The exact review interval was renewed."),
		fauxAssistantMessage("The renewed interval expired and requires fresh review."),
	]);

	const child = await spawnFromView(
		host.session,
		owner,
		"spawn-operation-review-agent",
		"Keep the Creation Request open while one root call remains unresolved.",
	);
	await started;
	clock.advanceBy(1_000);
	await coordinator.forAgent(child.agentId).reachSafeBoundary();

	const moderator = await waitForModeratorKind(host, "operation_review");
	const inputEntry = SessionManager.open(moderator.path).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(inputEntry?.type === "custom_message" && typeof inputEntry.content === "string");
	const input = JSON.parse(inputEntry.content) as {
		trigger: {
			kind: string;
			toolCall: { agentId: string; entryId: string; toolCallId: string };
			reviewIntervalMs: number;
		};
	};
	assert.deepEqual(input.trigger, {
		kind: "operation_review",
		toolCall: {
			agentId: child.agentId,
			entryId: input.trigger.toolCall.entryId,
			toolCallId: "overdue-root-call",
		},
		reviewIntervalMs: 1_000,
	});
	const childTranscriptPath = owner.status(child.agentId).primaryEvidence.transcriptPath;
	assert.ok(childTranscriptPath);
	assert.equal(
		SessionManager.open(childTranscriptPath).getEntries().some(
			(entry) =>
				entry.id === input.trigger.toolCall.entryId &&
				entry.type === "message" &&
				entry.message.role === "assistant",
		),
		true,
	);
	const renewal = await waitForTranscriptEntry(
		moderator.path,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === "renew-overdue-root-call",
	);
	assert.ok(renewal.type === "message" && renewal.message.role === "toolResult");
	assert.deepEqual(renewal.message.details, {
		disposition: "renewed",
		toolCall: input.trigger.toolCall,
		nextReviewInMs: 500,
	});

	clock.advanceBy(499);
	await coordinator.forAgent(child.agentId).reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 1);
	clock.advanceBy(1);
	await coordinator.forAgent(child.agentId).reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 2);

	releaseTool();
	await host.runtime.dispose();
});

test("one failed provider request creates Run Failure without regenerating an answer-obligated Run", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
	});
	let failedChildProviderRequests = 0;
	const routedResponses = Array.from(
		{ length: 6 },
		() => (context: Context) => {
			if (context.tools?.some(({ name }) => name === "moderator_control")) {
				return fauxAssistantMessage("I will diagnose the failed obligated Run.");
			}
			if (context.messages.some(
				(message) =>
					message.role === "user" &&
					JSON.stringify(message.content).includes(
						"Answer this Creation Request after the exact Run fails.",
					),
			)) {
				failedChildProviderRequests += 1;
				return fauxAssistantMessage("The exact child Run fails before answering.", {
					stopReason: "error",
					errorMessage: "connection lost during the exact answer-obligated generation",
				});
			}
			return fauxAssistantMessage("The failure case is delegated.");
		},
	);
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Answer this Creation Request after the exact Run fails." },
				{ id: "spawn-run-failure-agent" },
			),
			{ stopReason: "toolUse" },
		),
		...routedResponses,
	]);

	await host.session.prompt("Create an answer-obligated Run Failure.");
	await host.session.waitForIdle();

	const moderator = await waitForModeratorKind(host, "run_failure");
	const moderatorInput = SessionManager.open(moderator.path).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(
		moderatorInput?.type === "custom_message" &&
			typeof moderatorInput.content === "string",
	);
	const input = JSON.parse(moderatorInput.content) as {
		trigger: {
			kind: string;
			agentId: string;
			runSequence: number;
			obligations: { total: number; sources: unknown[] };
		};
		inspectedThrough: Array<{ agentId: string; entryId: string }>;
	};
	assert.equal(input.trigger.kind, "run_failure");
	assert.equal(input.trigger.runSequence, 1);
	assert.equal(input.trigger.obligations.total, 1);
	assert.equal(input.trigger.obligations.sources.length, 1);
	assert.deepEqual(input.inspectedThrough, [{
		agentId: input.trigger.agentId,
		entryId: await transcriptTailFor(host, input.trigger.agentId),
	}]);
	assert.equal(
		(moderatorInput.details as { configuration: { description: string } })
			.configuration.description,
		"run failure",
	);
	assert.deepEqual((await observeStatus(host, input.trigger.agentId)).run, {
		phase: "dormant",
		retentionReasons: [],
	});
	assert.equal(failedChildProviderRequests, 1);

	await host.runtime.dispose();
});

test("an unexpectedly ended answer-obligated Owner Run creates a Run Failure Moderator", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
	});
	let ownerRequestAuthored = false;
	const routeOwnerRequest = (context: Context) => {
		if (
			!ownerRequestAuthored &&
			JSON.stringify(context.messages).includes(
				"Ask the Owner one question, then wait for its Answer.",
			)
		) {
			ownerRequestAuthored = true;
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{
						operation: "request",
						targetAgentId: host.session.sessionId,
						question: "What outcome should I preserve?",
					},
					{ id: "request-owner-outcome" },
				),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("I will wait for the Owner Answer.");
	};
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Ask the Owner one question, then wait for its Answer." },
				{ id: "spawn-owner-requester" },
			),
			{ stopReason: "toolUse" },
		),
		...Array.from({ length: 8 }, () => routeOwnerRequest),
	]);

	await host.session.prompt("Create an Agent that will request Owner guidance.");
	await host.session.waitForIdle();
	await waitForCondition(async () => {
		const owner = await observeStatus(host, host.session.sessionId);
		return owner.run.retentionReasons.some(({ reason }) => reason === "answer_owed");
	});

	const terminalOwnerFailure = (context: Context) =>
		context.tools?.some(({ name }) => name === "moderator_control")
			? fauxAssistantMessage("I will diagnose the failed obligated Owner Run.")
			: fauxAssistantMessage("The Owner Run fails before answering.", {
				stopReason: "error",
				errorMessage: "deterministic answer-obligated Owner Run failure",
			});
	host.model.setResponses(Array.from(
		{
			length: host.services.settingsManager.getRetrySettings().maxRetries + 4,
		},
		() => terminalOwnerFailure,
	));
	await host.session.prompt("Fail this Owner Run before answering the Request.");
	await host.session.waitForIdle();

	const moderator = await waitForModeratorKind(host, "run_failure");
	const input = SessionManager.open(moderator.path).getEntries()[0];
	assert.ok(input?.type === "custom_message" && typeof input.content === "string");
	const trigger = (JSON.parse(input.content) as {
		trigger: {
			kind: string;
			agentId: string;
			runSequence: number;
			obligations: { total: number };
		};
	}).trigger;
	assert.equal(trigger.kind, "run_failure");
	assert.equal(trigger.agentId, host.session.sessionId);
	assert.equal(trigger.runSequence, 1);
	assert.equal(trigger.obligations.total, 1);

	await host.runtime.dispose();
});

test("a successor clears Run Failure before its later Stall is handled separately", async () => {
	const harness = await createIncidentBoundaryHarness();
	const routeRuns = (context: Context) => {
		if (context.tools?.some(({ name }) => name === "moderator_control")) {
			return fauxAssistantMessage("I will inspect this exact condition.");
		}
		const latestUser = JSON.stringify(
			[...context.messages].reverse().find(({ role }) => role === "user"),
		);
		if (latestUser.includes("Start the successor Run.")) {
			return fauxAssistantMessage("The successor settled without answering.");
		}
		return fauxAssistantMessage("The first exact Run fails before answering.", {
			stopReason: "error",
			errorMessage: "deterministic first Run failure",
		});
	};
	harness.host.model.setResponses(Array.from(
		{
			length:
				harness.host.services.settingsManager.getRetrySettings().maxRetries + 10,
		},
		() => routeRuns,
	));
	const affected = await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-successor-after-run-failure",
		"Fail the first Run, then leave the Answer obligation for a successor.",
	);
	const failureModerator = await waitForModeratorKind(harness.host, "run_failure");
	assert.equal(harness.owner.status(affected.agentId).run.phase, "dormant");

	await sendMessageFromView(
		harness.host.session,
		harness.owner,
		"start-successor-after-run-failure",
		affected.agentId,
		"Start the successor Run.",
	);
	const stallModerator = await waitForModeratorKind(harness.host, "obligation_stall");
	assert.notEqual(stallModerator.id, failureModerator.id);
	await waitForCondition(() => {
		const run = harness.owner.status(failureModerator.id).run;
		return !run.retentionReasons.some(
			({ reason }) => reason === "moderator_handling",
		);
	});
	const successor = harness.owner.status(affected.agentId).run;
	assert.equal(successor.phase, "live");
	assert.equal("work" in successor && successor.work, "settled");
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("a failed successor startup does not clear Run Failure handling", async () => {
	const harness = await createIncidentBoundaryHarness();
	const routeFailure = (context: Context) =>
		context.tools?.some(({ name }) => name === "moderator_control")
			? fauxAssistantMessage("I will inspect the failed exact Run.")
			: fauxAssistantMessage("The exact Run fails before answering.", {
				stopReason: "error",
				errorMessage: "deterministic Run failure before unavailable successor",
			});
	harness.host.model.setResponses(Array.from(
		{
			length:
				harness.host.services.settingsManager.getRetrySettings().maxRetries + 4,
		},
		() => routeFailure,
	));
	const affected = await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-run-failure-before-unavailable-successor",
		"Fail before answering this Creation Request.",
	);
	const moderator = await waitForModeratorKind(harness.host, "run_failure");
	assert.equal(harness.owner.status(affected.agentId).run.phase, "dormant");

	const originalGetModel = harness.host.services.modelRuntime.getModel.bind(
		harness.host.services.modelRuntime,
	);
	const controlledModelRuntime = harness.host.services
		.modelRuntime as typeof harness.host.services.modelRuntime & {
			getModel: typeof harness.host.services.modelRuntime.getModel;
		};
	controlledModelRuntime.getModel = (() => undefined) as typeof controlledModelRuntime.getModel;
	try {
		const input = {
			operation: "send" as const,
			targetAgentId: affected.agentId,
			content: "Attempt a successor Run while its model is unavailable.",
		};
		const toolCallId = "attempt-unavailable-successor";
		harness.host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_message", input, { id: toolCallId }),
				{ stopReason: "toolUse" },
			),
		);
		const receipt = await harness.owner.message(toolCallId, input);
		assert.ok("delivery" in receipt);
		assert.equal(receipt.delivery, "rejected");
		assert.equal(
			"rejectionReason" in receipt && receipt.rejectionReason,
			"target_unavailable",
		);
		await harness.owner.reachSafeBoundary();

		assert.equal(harness.owner.status(affected.agentId).run.phase, "dormant");
		assert.equal(
			harness.owner.status(moderator.id).run.retentionReasons.some(
				({ reason }) => reason === "moderator_handling",
			),
			true,
		);
	} finally {
		controlledModelRuntime.getModel = originalGetModel;
		await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
	}
});

test("Request Cancellation clears Run Failure without starting a successor Incident", async () => {
	const harness = await createIncidentBoundaryHarness();
	const routeFailure = (context: Context) =>
		context.tools?.some(({ name }) => name === "moderator_control")
			? fauxAssistantMessage("I will inspect the failed exact Run.")
			: fauxAssistantMessage("The exact Run fails before answering.", {
				stopReason: "error",
				errorMessage: "deterministic cancellable Run failure",
			});
	harness.host.model.setResponses(Array.from(
		{
			length:
				harness.host.services.settingsManager.getRetrySettings().maxRetries + 4,
		},
		() => routeFailure,
	));
	const affected = await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-cancelled-run-failure",
		"Fail before answering this Creation Request.",
	);
	const moderator = await waitForModeratorKind(harness.host, "run_failure");

	harness.host.model.setResponses([
		fauxAssistantMessage("The cancelled obligation no longer requires handling."),
	]);
	await cancelRequestFromView(
		harness.host.session,
		harness.owner,
		"cancel-run-failure-obligation",
		affected.requestId,
	);
	await waitForCondition(() =>
		!harness.owner.status(moderator.id).run.retentionReasons.some(
			({ reason }) => reason === "moderator_handling",
		)
	);
	await harness.owner.reachSafeBoundary();
	assert.equal((await findModerators(harness.host)).length, 1);
	assert.deepEqual(harness.owner.operationalAttention(), []);
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("Moderator Resolution is blocked while the Obligation Stall remains", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
	});
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
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
	});
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
	assert.deepEqual(
		(await findModerators(host)).map(({ path }) => moderatorTriggerKind(path)),
		["obligation_stall"],
	);

	await host.runtime.dispose();
});

test("terminating the affected Run does not erase its durable Answer obligation", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
	});
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Leave this Answer obligation unresolved after termination." },
				{ id: "spawn-terminated-stall-agent" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The termination case is delegated."),
		fauxAssistantMessage("I settled without answering."),
		(context) => {
			const input = context.messages.flatMap((message) => {
				if (message.role !== "user") return [];
				return typeof message.content === "string"
					? [message.content]
					: message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
			}).find((content) => content.includes('"kind":"obligation_stall"'));
			assert.ok(input);
			const affectedAgentId = (JSON.parse(input) as {
				trigger: { agentId: string };
			}).trigger.agentId;
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_control",
					{ operation: "terminate", agentId: affectedAgentId },
					{ id: "terminate-stalled-run" },
				),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage(
			fauxToolCall(
				"moderator_control",
				{
					operation: "resolve",
					summary: "The exact stalled Run was terminated.",
					rationale: "The durable obligation remains for a successor Run.",
				},
				{ id: "resolve-after-termination" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The terminated attempt is resolved."),
	]);

	await host.session.prompt("Create a terminated Obligation Stall.");
	await host.session.waitForIdle();
	const moderator = await waitForModerator(host);
	const termination = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "terminate-stalled-run",
	);
	assert.ok(termination.type === "message" && termination.message.role === "toolResult");
	assert.deepEqual(termination.message.details, {
		agentId: moderatorAffectedAgentId(moderator.path),
		disposition: "terminated",
		residualRequests: { incoming: 1, outgoing: 0 },
	});
	const resolution = await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "resolve-after-termination",
	);
	assert.ok(resolution.type === "message" && resolution.message.role === "toolResult");
	assert.deepEqual(resolution.message.details, { disposition: "resolved" });

	await host.runtime.dispose();
});

test("a Moderator escalates through an ordinary Owner Request before Resolution", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
	});
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
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
	});
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
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
	});
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
	await waitForTranscriptEntry(
		secondModerator.path,
		(entry) => entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "text" &&
					part.text === "I am handling the new continuous Stall.",
			),
	);

	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"moderator_control",
				{
					operation: "resolve",
					summary: "The first continuous Stall cleared under an exact Hold.",
					rationale: "The later recurrence belongs to the fresh Moderator.",
				},
				{ id: "resolve-first-continuous-stall" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The first handling attempt is resolved."),
	]);
	await sendOwnerMessage(
		host,
		firstModerator.id,
		"Resolve only your original continuous Stall.",
		"wake-first-moderator-after-recurrence",
	);
	const firstResolution = await waitForTranscriptEntry(
		firstModerator.path,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolCallId === "resolve-first-continuous-stall",
	);
	assert.ok(
		firstResolution.type === "message" && firstResolution.message.role === "toolResult",
	);
	assert.deepEqual(firstResolution.message.details, { disposition: "resolved" });

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
		implicitModeratorResponses: false,
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

test("a closed settled Request cycle creates one normalized Dependency Deadlock Moderator", async () => {
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		implicitModeratorResponses: false,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let rejectedCreationDeliveries = 0;
	let coordinator!: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator.forModerator(agentId)),
		spawnBoundaryHooks: {
			beforeDeliveryAdmission() {
				if (rejectedCreationDeliveries >= 2) return;
				rejectedCreationDeliveries += 1;
				return "confirmed_failure";
			},
		},
	});
	const owner = coordinator.forAgent(identity.agentId);
	try {
		const first = await spawnFromView(
			host.session,
			owner,
			"spawn-first-deadlock-agent",
			"Remain dormant until live dependency work arrives.",
		);
		const second = await spawnFromView(
			host.session,
			owner,
			"spawn-second-deadlock-agent",
			"Remain dormant until live dependency work arrives.",
		);
		assert.equal(first.disposition, "created_unscheduled");
		assert.equal(second.disposition, "created_unscheduled");

		const routeCycle = (context: Context) => {
			if (context.tools?.some(({ name }) => name === "moderator_control")) {
				return fauxAssistantMessage("I will inspect the closed Request cycle.");
			}
			const messages = JSON.stringify(context.messages);
			const latestUser = JSON.stringify(
				[...context.messages].reverse().find(({ role }) => role === "user"),
			);
			if (
				latestUser.includes("Start the first cycle participant.") &&
				!messages.includes('"id":"request-first-to-second"')
			) {
				return fauxAssistantMessage(
					fauxToolCall(
						"agent_message",
						{
							operation: "request",
							targetAgentId: second.agentId,
							question: "Wait for my Answer while I wait for yours.",
						},
						{ id: "request-first-to-second" },
					),
					{ stopReason: "toolUse" },
				);
			}
			if (
				latestUser.includes("Wait for my Answer while I wait for yours.") &&
				!messages.includes('"id":"request-second-to-first"')
			) {
				return fauxAssistantMessage(
					fauxToolCall(
						"agent_message",
						{
							operation: "request",
							targetAgentId: first.agentId,
							question: "Return an Answer only after my dependency resolves.",
						},
						{ id: "request-second-to-first" },
					),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("I am settled while the internal Request remains unresolved.");
		};
		host.model.setResponses(Array.from({ length: 24 }, () => routeCycle));
		await cancelRequestFromView(
			host.session,
			owner,
			"cancel-first-deadlock-creation-request",
			first.requestId,
		);
		await cancelRequestFromView(
			host.session,
			owner,
			"cancel-second-deadlock-creation-request",
			second.requestId,
		);
		await waitForCondition(() =>
			owner.status(first.agentId).run.phase === "dormant" &&
			owner.status(second.agentId).run.phase === "dormant"
		);
		await sendMessageFromView(
			host.session,
			owner,
			"wake-first-deadlock-agent",
			first.agentId,
			"Start the first cycle participant.",
		);
		const expectedAgentIds = [first.agentId, second.agentId].sort();
		await waitForCondition(() => expectedAgentIds.every((agentId) => {
			const run = owner.status(agentId).run;
			return run.phase === "live" && run.work === "settled";
		}));
		for (const agentId of expectedAgentIds) {
			const run = owner.status(agentId).run;
			assert.equal(run.phase, "live");
			assert.equal(
				run.retentionReasons.every(
					({ reason }) => reason === "answer_owed" || reason === "awaiting_answer",
				),
				true,
			);
		}

		const moderator = await waitForModeratorKind(host, "dependency_deadlock");
		await waitForCondition(async () => (await findModerators(host)).length === 3);
		assert.deepEqual(
			(await findModerators(host)).map(({ path }) => moderatorTriggerKind(path)).sort(),
			["dependency_deadlock", "obligation_stall", "obligation_stall"],
		);
		const inputEntry = SessionManager.open(moderator.path).getEntries().find(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.moderator-input",
		);
		assert.ok(inputEntry?.type === "custom_message" && typeof inputEntry.content === "string");
		const input = JSON.parse(inputEntry.content) as {
			trigger: {
				kind: string;
				agentIds: string[];
				requests: { total: number; sources: unknown[] };
			};
			inspectedThrough: Array<{ agentId: string; entryId: string }>;
		};
		assert.equal(input.trigger.kind, "dependency_deadlock");
		assert.deepEqual(input.trigger.agentIds, expectedAgentIds);
		assert.equal(input.trigger.requests.total, 2);
		assert.equal(input.trigger.requests.sources.length, 2);
		assert.deepEqual(
			input.inspectedThrough.map(({ agentId }) => agentId),
			expectedAgentIds,
		);
		for (const agentId of expectedAgentIds) {
			const run = owner.status(agentId).run;
			assert.equal(run.phase, "live");
			assert.equal("work" in run && run.work, "settled");
			assert.equal(
				run.retentionReasons.every(
					({ reason }) => reason === "answer_owed" || reason === "awaiting_answer",
				),
				true,
			);
		}
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
	}
});

test("an active member prevents a closed Request cycle from becoming a Deadlock", async (t) => {
	const registryKey = Symbol.for("pi-agent-coordination.test.execution-gate");
	let gateStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		gateStarted = resolve;
	});
	let releaseGate!: () => void;
	const released = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	(globalThis as Record<PropertyKey, unknown>)[registryKey] = {
		async execute() {
			gateStarted();
			await released;
		},
	};
	let gateReleased = false;
	let coordinator: WorkflowCoordinator | undefined;
	let host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>> | undefined;
	t.after(async () => {
		if (!gateReleased) releaseGate();
		delete (globalThis as Record<PropertyKey, unknown>)[registryKey];
		if (coordinator && host) {
			await coordinator.shutdown(async () => host!.runtime.dispose());
		}
	});

	host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		implicitModeratorResponses: false,
		additionalExtensionPaths: [
			fileURLToPath(new URL("./support/execution-gate-tool.ts", import.meta.url)),
		],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let rejectedCreationDeliveries = 0;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator!.forAgent(agentId)),
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator!.forModerator(agentId)),
		spawnBoundaryHooks: {
			beforeDeliveryAdmission() {
				if (rejectedCreationDeliveries >= 2) return;
				rejectedCreationDeliveries += 1;
				return "confirmed_failure";
			},
		},
	});
	const owner = coordinator.forAgent(identity.agentId);
	const first = await spawnFromView(
		host.session,
		owner,
		"spawn-first-active-cycle-agent",
		"Remain dormant until the active-cycle probe starts.",
	);
	const second = await spawnFromView(
		host.session,
		owner,
		"spawn-second-active-cycle-agent",
		"Remain dormant until the active-cycle probe starts.",
	);
	const routeActiveCycle = (context: Context) => {
		if (context.tools?.some(({ name }) => name === "moderator_control")) {
			return fauxAssistantMessage("I will inspect the now-settled cycle.");
		}
		const messages = JSON.stringify(context.messages);
		const latestUser = JSON.stringify(
			[...context.messages].reverse().find(({ role }) => role === "user"),
		);
		if (
			latestUser.includes("Start the active-cycle probe.") &&
			!messages.includes('"id":"request-first-active-cycle"')
		) {
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{
						operation: "request",
						targetAgentId: second.agentId,
						question: "Create the return dependency, then remain active.",
					},
					{ id: "request-first-active-cycle" },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (
			latestUser.includes("Create the return dependency, then remain active.") &&
			!messages.includes('"id":"request-second-active-cycle"')
		) {
			return fauxAssistantMessage(
				fauxToolCall(
					"agent_message",
					{
						operation: "request",
						targetAgentId: first.agentId,
						question: "Wait while my Run remains active.",
					},
					{ id: "request-second-active-cycle" },
				),
				{ stopReason: "toolUse" },
			);
		}
		if (
			latestUser.includes("Create the return dependency, then remain active.") &&
			!messages.includes('"id":"gate-active-cycle"')
		) {
			return fauxAssistantMessage(
				fauxToolCall("execution_gate", {}, { id: "gate-active-cycle" }),
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("I settled while both cycle Requests remain unresolved.");
	};
	host.model.setResponses(Array.from({ length: 24 }, () => routeActiveCycle));
	await cancelRequestFromView(
		host.session,
		owner,
		"cancel-first-active-cycle-creation",
		first.requestId,
	);
	await cancelRequestFromView(
		host.session,
		owner,
		"cancel-second-active-cycle-creation",
		second.requestId,
	);
	await waitForCondition(() =>
		owner.status(first.agentId).run.phase === "dormant" &&
		owner.status(second.agentId).run.phase === "dormant"
	);
	await sendMessageFromView(
		host.session,
		owner,
		"start-active-cycle",
		first.agentId,
		"Start the active-cycle probe.",
	);
	await started;
	await waitForCondition(() => {
		const firstRun = owner.status(first.agentId).run;
		const secondRun = owner.status(second.agentId).run;
		return firstRun.phase === "live" && firstRun.work === "settled" &&
			secondRun.phase === "live" && secondRun.work === "active" &&
			firstRun.retentionReasons.some(({ reason }) => reason === "answer_owed") &&
			secondRun.retentionReasons.some(({ reason }) => reason === "awaiting_answer");
	});
	await owner.reachSafeBoundary();
	assert.equal((await findModerators(host)).length, 0);

	gateReleased = true;
	releaseGate();
	await waitForModeratorKind(host, "dependency_deadlock");
});

test("input, Human attention, selection, and Hold prevent a self-cycle Deadlock", async () => {
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		implicitModeratorResponses: false,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let selectedAgentId = identity.agentId;
	let coordinator!: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator.forModerator(agentId)),
		humanRequestPresentation: new HumanRequestSurface(host.ui),
		humanSessionSelection: {
			selectedAgentId: () => selectedAgentId,
			addChangeHandler: () => () => undefined,
			isBoundTo: (agentId) => selectedAgentId === agentId,
			async activate({ agentId }) {
				selectedAgentId = agentId;
			},
			async restoreOwnerRuntimeForShutdown() {
				selectedAgentId = identity.agentId;
			},
			async replaceIfSelected(agentId, binding) {
				if (selectedAgentId !== agentId) {
					await binding.release?.();
					return false;
				}
				return true;
			},
		},
		spawnBoundaryHooks: {
			beforeDeliveryAdmission: () => "confirmed_failure",
		},
	});
	const owner = coordinator.forAgent(identity.agentId);
	try {
		const participant = await spawnFromView(
			host.session,
			owner,
			"spawn-self-cycle-agent",
			"Remain dormant until the self-cycle probe starts.",
		);
		assert.equal(participant.disposition, "created_unscheduled");
		const routeSelfCycle = (context: Context) => {
			if (context.tools?.some(({ name }) => name === "moderator_control")) {
				return fauxAssistantMessage("I will inspect the settled self-cycle.");
			}
			const messages = JSON.stringify(context.messages);
			const latestUser = JSON.stringify(
				[...context.messages].reverse().find(({ role }) => role === "user"),
			);
			if (
				latestUser.includes("Start the self-cycle probe.") &&
				!messages.includes('"id":"request-self-cycle"')
			) {
				return fauxAssistantMessage(
					fauxToolCall(
						"agent_message",
						{
							operation: "request",
							targetAgentId: participant.agentId,
							question: "Wait for this same Run to resolve itself.",
						},
						{ id: "request-self-cycle" },
					),
					{ stopReason: "toolUse" },
				);
			}
			if (
				messages.includes('"id":"request-self-cycle"') &&
				!messages.includes('"id":"pause-self-cycle"')
			) {
				return fauxAssistantMessage(
					fauxToolCall(
						"ask_user_question",
						{
							questions: [{
								kind: "text",
								header: "Resume",
								prompt: "Provide input before this Run settles.",
								multiline: false,
							}],
						},
						{ id: "pause-self-cycle" },
					),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("I am settled inside the unresolved self-cycle.");
		};
		host.model.setResponses(Array.from({ length: 16 }, () => routeSelfCycle));
		await cancelRequestFromView(
			host.session,
			owner,
			"cancel-self-cycle-creation-request",
			participant.requestId,
		);
		await waitForCondition(() => owner.status(participant.agentId).run.phase === "dormant");
		await sendMessageFromView(
			host.session,
			owner,
			"start-self-cycle",
			participant.agentId,
			"Start the self-cycle probe.",
		);
		await waitForCondition(() => owner.humanAttention().length === 1);
		const paused = owner.status(participant.agentId).run;
		assert.equal(paused.phase, "live");
		assert.equal("attention" in paused && paused.attention, "input_required");
		await assertNoModeratorKindAtSafeBoundary(
			owner,
			host,
			"dependency_deadlock",
		);

		assert.equal(await owner.selectForHuman(participant.agentId), "selected");
		const humanAttention = owner.humanAttention()[0]!;
		const focused = owner.focusHumanRequest(humanAttention.requestId);
		await waitForCondition(() => host.ui.customSurfaces.length === 1);
		host.ui.customSurfaces[0]!.handleInput?.("Continue to settlement");
		host.ui.customSurfaces[0]!.handleInput?.("\r");
		await focused;
		await waitForCondition(() => {
			const run = owner.status(participant.agentId).run;
			return run.phase === "live" && run.work === "settled";
		});
		await assertNoModeratorKindAtSafeBoundary(
			owner,
			host,
			"dependency_deadlock",
		);
		await controlFromView(
			host.session,
			owner,
			"hold-settled-self-cycle",
			{ operation: "interrupt", agentId: participant.agentId },
		);
		await waitForCondition(() =>
			owner.status(participant.agentId).run.retentionReasons.some(
				({ reason }) => reason === "interruption_hold",
			)
		);
		assert.equal(await owner.selectForHuman(identity.agentId), "selected");
		await assertNoModeratorKindAtSafeBoundary(
			owner,
			host,
			"dependency_deadlock",
		);
		await controlFromView(
			host.session,
			owner,
			"resume-held-self-cycle",
			{
				operation: "resume",
				agentId: participant.agentId,
				content: "Settle again without resolving the self-cycle.",
			},
		);
		await waitForModeratorKind(host, "dependency_deadlock");
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
	}
});


test("a pre-commit Moderator bootstrap failure consumes no attempt", async () => {
	let bootstrapAttempts = 0;
	const harness = await createIncidentBoundaryHarness({
		beforeModeratorBootstrapCommit: () => {
			bootstrapAttempts += 1;
			return bootstrapAttempts === 1 ? "confirmed_failure" : undefined;
		},
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

	harness.host.model.setResponses(Array.from({ length: 8 }, () => (context: Context) =>
		context.tools?.some(({ name }) => name === "moderator_control")
			? fauxAssistantMessage("I am the first committed handling attempt.")
			: fauxAssistantMessage("The unrelated Agent settled.")
	));
	await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-unrelated-after-pre-commit-failure",
		"Create an unrelated state transition without touching the original Stall.",
	);
	const moderator = await waitForModeratorForAgent(harness.host, affected.agentId);
	const input = SessionManager.open(moderator.path).getEntries()[0];
	assert.ok(input?.type === "custom_message" && typeof input.content === "string");
	assert.equal(
		(JSON.parse(input.content) as { previousAttempt?: unknown }).previousAttempt,
		undefined,
	);
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("shutdown before Moderator bootstrap prevents a post-snapshot Moderator admission", async () => {
	let shutdownPromise: Promise<void> | undefined;
	let harness!: Awaited<ReturnType<typeof createIncidentBoundaryHarness>>;
	harness = await createIncidentBoundaryHarness({
		beforeModeratorBootstrapCommit: () => {
			shutdownPromise ??= harness.coordinator.shutdown(
				async () => harness.host.runtime.dispose(),
			);
		},
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I settled without answering the Creation Request."),
	]);
	await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-before-moderator-shutdown",
		"Settle with an Answer obligation while the host begins shutdown.",
	);
	await waitForCondition(() => shutdownPromise !== undefined);
	await shutdownPromise;

	assert.deepEqual(await findModerators(harness.host), []);
});

test("a post-commit Moderator startup failure creates one linked replacement", async () => {
	let startupAttempts = 0;
	const harness = await createIncidentBoundaryHarness({
		beforeModeratorRunStart: () => {
			startupAttempts += 1;
			return startupAttempts === 1 ? "confirmed_failure" : undefined;
		},
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I settled without answering the Creation Request."),
		fauxAssistantMessage("I am the replacement Moderator."),
	]);
	await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-post-commit-moderator-failure",
		"Settle with an Answer obligation.",
	);
	await waitForCondition(async () => (await findModerators(harness.host)).length === 2);
	const moderators = await findModerators(harness.host);
	const first = moderators[0]!;
	const replacement = moderators[1]!;
	assert.deepEqual(harness.owner.status(first.id).run, {
		phase: "dormant",
		retentionReasons: [],
	});
	const firstEntries = SessionManager.open(first.path).getEntries();
	assert.equal(firstEntries.length, 1);
	assert.equal(firstEntries[0]?.type, "custom_message");
	const replacementInput = SessionManager.open(replacement.path).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(
		replacementInput?.type === "custom_message" &&
			typeof replacementInput.content === "string",
	);
	assert.deepEqual(
		(JSON.parse(replacementInput.content) as {
			previousAttempt?: { agentId: string; entryId: string };
		}).previousAttempt,
		{ agentId: first.id, entryId: firstEntries[0]!.id },
	);
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("a terminal Moderator Run failure creates one linked replacement", async () => {
	const harness = await createIncidentBoundaryHarness();
	const routeFailure = (context: Context) => {
		if (!context.tools?.some(({ name }) => name === "moderator_control")) {
			return fauxAssistantMessage("I settled without answering the Creation Request.");
		}
		const input = context.messages.find((message) =>
			message.role === "user" && JSON.stringify(message).includes('"trigger"')
		);
		if (JSON.stringify(input).includes('"previousAttempt"')) {
			return fauxAssistantMessage("I am the replacement Moderator.");
		}
		return fauxAssistantMessage("The first Moderator Run fails terminally.", {
			stopReason: "error",
			errorMessage: "deterministic Moderator Run failure",
		});
	};
	harness.host.model.setResponses(Array.from(
		{
			length:
				harness.host.services.settingsManager.getRetrySettings().maxRetries + 6,
		},
		() => routeFailure,
	));
	await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-moderator-run-failure-agent",
		"Settle with an Answer obligation.",
	);
	await waitForCondition(async () => (await findModerators(harness.host)).length === 2);

	const moderators = await findModerators(harness.host);
	const replacement = moderators.find(({ path }) => {
		const input = SessionManager.open(path).getEntries()[0];
		return input?.type === "custom_message" &&
			typeof input.content === "string" &&
			JSON.parse(input.content).previousAttempt !== undefined;
	});
	assert.ok(replacement);
	const replacementInput = SessionManager.open(replacement.path).getEntries()[0];
	assert.ok(
		replacementInput?.type === "custom_message" &&
			typeof replacementInput.content === "string",
	);
	const previousAttempt = (JSON.parse(replacementInput.content) as {
		previousAttempt: { agentId: string; entryId: string };
	}).previousAttempt;
	const failed = moderators.find(({ id }) => id === previousAttempt.agentId);
	assert.ok(failed);
	const failedTail = SessionManager.open(failed.path).getEntries().at(-1);
	assert.ok(failedTail?.type === "message" && failedTail.message.role === "assistant");
	assert.equal(failedTail.message.stopReason, "error");
	assert.equal(previousAttempt.entryId, failedTail.id);
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("two committed Moderator failures publish bounded Owner Attention until clearance", async () => {
	const harness = await createIncidentBoundaryHarness({
		beforeModeratorRunStart: () => "confirmed_failure",
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I settled without answering the Creation Request."),
		fauxAssistantMessage("The cancellation cleared the original condition."),
	]);
	const affected = await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-exhausted-moderation-agent",
		"Settle with an Answer obligation.",
	);
	await waitForCondition(() => harness.owner.operationalAttention().length === 1);

	const moderators = await findModerators(harness.host);
	assert.equal(moderators.length, 2);
	const attention = harness.owner.operationalAttention()[0]!;
	assert.equal(attention.trigger.kind, "obligation_stall");
	assert.deepEqual(attention.affectedAgentIds, [affected.agentId]);
	assert.equal(attention.diagnostics.length, 2);
	for (const pointer of attention.diagnostics) {
		const moderator = moderators.find(({ id }) => id === pointer.agentId);
		assert.ok(moderator);
		assert.equal(
			pointer.entryId,
			SessionManager.open(moderator.path).getEntries().at(-1)!.id,
		);
	}
	const replacement = moderators.find(({ id }) => id === attention.diagnostics[1]!.agentId);
	assert.ok(replacement);
	const replacementInput = SessionManager.open(replacement.path).getEntries()[0];
	assert.ok(
		replacementInput?.type === "custom_message" &&
			typeof replacementInput.content === "string",
	);
	assert.deepEqual(
		(JSON.parse(replacementInput.content) as {
			previousAttempt?: { agentId: string; entryId: string };
		}).previousAttempt,
		attention.diagnostics[0],
	);
	assert.deepEqual(
		harness.coordinator.forAgent(affected.agentId).operationalAttention(),
		[],
	);
	await harness.owner.reachSafeBoundary();
	assert.equal((await findModerators(harness.host)).length, 2);

	await cancelRequestFromView(
		harness.host.session,
		harness.owner,
		"clear-exhausted-moderation-condition",
		affected.requestId,
	);
	await waitForCondition(() => harness.owner.operationalAttention().length === 0);
	await harness.coordinator.shutdown(async () => harness.host.runtime.dispose());
});

test("orderly shutdown closes exhausted Operational Attention", async () => {
	const harness = await createIncidentBoundaryHarness({
		beforeModeratorRunStart: () => "confirmed_failure",
	});
	harness.host.model.setResponses([
		fauxAssistantMessage("I settled without answering the Creation Request."),
	]);
	await spawnFromView(
		harness.host.session,
		harness.owner,
		"spawn-operational-attention-before-shutdown",
		"Settle with an Answer obligation until Owner Attention is required.",
	);
	await waitForCondition(() => harness.owner.operationalAttention().length === 1);
	const moderator = (await findModerators(harness.host))[0];
	assert.ok(moderator);
	let markNativeDisposalStarted!: () => void;
	const nativeDisposalStarted = new Promise<void>((resolve) => {
		markNativeDisposalStarted = resolve;
	});
	let releaseNativeDisposal!: () => void;
	const nativeDisposalGate = new Promise<void>((resolve) => {
		releaseNativeDisposal = resolve;
	});
	const shutdown = harness.coordinator.shutdown(async () => {
		markNativeDisposalStarted();
		await nativeDisposalGate;
		await harness.host.runtime.dispose();
	});
	await nativeDisposalStarted;

	await assert.rejects(
		async () => harness.coordinator.forModerator(moderator.id).moderatorControl(
			"moderator-control-after-shutdown",
			{ operation: "resolve", summary: "Too late", rationale: "Host is closing" },
		),
		/host_shutting_down/,
	);
	releaseNativeDisposal();
	await shutdown;

	assert.deepEqual(harness.owner.operationalAttention(), []);
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

async function waitForModeratorKind(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	kind: string,
): Promise<{ id: string; path: string }> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		for (const moderator of await findModerators(host)) {
			if (moderatorTriggerKind(moderator.path) === kind) return moderator;
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`Expected a ${kind} Moderator`);
}

async function assertNoModeratorKindAtSafeBoundary(
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	kind: string,
): Promise<void> {
	await view.reachSafeBoundary();
	assert.equal(
		(await findModerators(host)).some(
			({ path }) => moderatorTriggerKind(path) === kind,
		),
		false,
	);
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
	requestId: string;
}> {
	const input = { request };
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.spawn(toolCallId, input);
	if (
		!("agentId" in receipt) ||
		typeof receipt.agentId !== "string" ||
		typeof receipt.requestId !== "string"
	) {
		throw new Error(`Agent Spawn ${toolCallId} did not commit an Agent identity`);
	}
	return {
		disposition: receipt.disposition,
		agentId: receipt.agentId,
		requestId: receipt.requestId,
	};
}

async function cancelRequestFromView(
	session: AgentSession,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	toolCallId: string,
	requestId: string,
): Promise<void> {
	const input = {
		operation: "cancel" as const,
		requestId,
		reason: "The Creation Request is no longer needed.",
	};
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.message(toolCallId, input);
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});
}

async function sendMessageFromView(
	session: AgentSession,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	toolCallId: string,
	targetAgentId: string,
	content: string,
): Promise<void> {
	const input = { operation: "send" as const, targetAgentId, content };
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.message(toolCallId, input);
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});
}

async function controlFromView(
	session: AgentSession,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	toolCallId: string,
	input:
		| { operation: "interrupt"; agentId: string }
		| { operation: "resume"; agentId: string; content: string }
		| { operation: "terminate"; agentId: string },
): Promise<void> {
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	await view.control(toolCallId, input);
}

async function createIncidentBoundaryHarness(
	incidentBoundaryHooks: {
		beforeModeratorBootstrapCommit?(): void | "confirmed_failure";
		beforeModeratorRunStart?(): void | "confirmed_failure";
	} = {},
) {
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		implicitModeratorResponses: false,
	});
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

function moderatorTriggerKind(sessionFile: string): string {
	const input = SessionManager.open(sessionFile).getEntries().find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	);
	assert.ok(input?.type === "custom_message" && typeof input.content === "string");
	return (JSON.parse(input.content) as { trigger: { kind: string } }).trigger.kind;
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
