import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	type Context,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import {
	executeRegisteredTool,
	openAgentsSurface,
	openDormantAgentView,
	returnAgentViewToOwner,
} from "./support/agent-session.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost as createBaseUnboundTestOwnerHost,
	type TestOwnerHost,
	type TestOwnerHostOptions,
} from "./support/pi-host.ts";
import {
	createProcessModelBroker,
	type ProcessModelBroker,
} from "./support/process-model-broker.ts";

const MAX_CONDITION_POLL_ATTEMPTS = 5_000;
const durableModelBrokers = new Set<ProcessModelBroker>();
const hostModelBrokers = new WeakMap<TestOwnerHost, ProcessModelBroker>();

test.after(async () => {
	const brokers = [...durableModelBrokers];
	durableModelBrokers.clear();
	await Promise.all(brokers.map((broker) => broker.close()));
});

test("a fresh Owner host rediscovers one dormant child without starting its Run", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const effectiveCwd = join(host.cwd, "child-effective-cwd");
	await mkdir(effectiveCwd);
	host.model.setResponses([
		fauxAssistantMessage("The child completed its initial Creation Request."),
	]);
	const spawned = await executeTool(host, "agent_spawn", "spawn-before-host-loss", {
		request: "Complete initial work, then become dormant.",
		label: "recovered-child",
		config: { cwd: effectiveCwd },
	}) as { agentId: string };
	const workflowDirectory = workflowSessionDirectory(host);
	const childSessionFile = await waitForSessionFile(
		workflowDirectory,
		spawned.agentId,
	);
	assert.equal(dirname(childSessionFile), workflowDirectory);
	await waitForTranscriptEntry(
		childSessionFile,
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	const ownerSessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(ownerSessionFile);
	await host.runtime.dispose();
	const childTranscript = SessionManager.open(childSessionFile);
	const nestedSpawnEntryId = childTranscript.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{
					request: "Remain a verified nested descendant after restart.",
					label: "recovered-grandchild",
				},
				{ id: "spawn-nested-before-reopen" },
			),
			{ stopReason: "toolUse" },
		),
	);
	const grandchildTranscript = SessionManager.create(effectiveCwd, workflowDirectory);
	const grandchildAgentId = grandchildTranscript.getSessionId();
	grandchildTranscript.appendCustomEntry("agent-coordination.identity", {
		agentId: grandchildAgentId,
		workflowId: host.session.sessionId,
		directSpawnerAgentId: spawned.agentId,
		spawnSource: {
			agentId: spawned.agentId,
			entryId: nestedSpawnEntryId,
			toolCallId: "spawn-nested-before-reopen",
		},
		metadata: { label: "recovered-grandchild" },
	});
	grandchildTranscript.appendMessage(
		fauxAssistantMessage("Persist recovered grandchild evidence."),
	);

	const reopened = await reopenOwner(t, host, ownerSessionFile);
	const observe = reopened.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const childrenResult = await observe.execute(
		"observe-recovered-children",
		{ operation: "children" },
		undefined,
		undefined,
		reopened.session.extensionRunner.createContext(),
	);
	const children = (childrenResult.details as {
		children: Array<{ agentId: string; label: string; run: { phase: string } }>;
	}).children;
	assert.deepEqual(
		children.map(({ agentId, label, run }) => ({ agentId, label, phase: run.phase })),
		[
			{
				agentId: spawned.agentId,
				label: "recovered-child",
				phase: "dormant",
			},
		],
	);
	const nestedChildren = await observe.execute(
		"observe-recovered-nested-children",
		{ operation: "children", agentId: spawned.agentId },
		undefined,
		undefined,
		reopened.session.extensionRunner.createContext(),
	);
	assert.deepEqual(
		(nestedChildren.details as { children: Array<{ agentId: string; run: { phase: string } }> })
			.children.map(({ agentId, run }) => ({ agentId, phase: run.phase })),
		[{ agentId: grandchildAgentId, phase: "dormant" }],
	);

	const recoveredAgents = await openAgentsSurface(reopened);
	const selectedBeforeDormantFocus = reopened.runtime.session.sessionId;
	recoveredAgents.surface.handleInput?.("\t");
	const recoveredDormant = recoveredAgents.surface.render(80).join("\n");
	assert.match(recoveredDormant, /recovered-child/);
	assert.match(recoveredDormant, /recovered-grandchild/);
	assert.equal(reopened.runtime.session.sessionId, selectedBeforeDormantFocus);
	recoveredAgents.surface.handleInput?.("\x1b");
	await recoveredAgents.command;
	assert.equal(reopened.runtime.session.sessionId, selectedBeforeDormantFocus);
	assert.equal(reopened.ui.customSurfaces.length, 0);
	assert.equal(
		(await observe.execute(
			"observe-still-dormant",
			{ operation: "status", agentId: spawned.agentId },
			undefined,
			undefined,
			reopened.session.extensionRunner.createContext(),
		).then((result) => result.details as { run: { phase: string } })).run.phase,
		"dormant",
	);
	await reopened.runtime.dispose();

	const reopenedAgain = await reopenOwner(t, host, ownerSessionFile);
	const secondObserve = reopenedAgain.session.getToolDefinition("agent_observe");
	assert.ok(secondObserve);
	const secondChildren = await secondObserve.execute(
		"observe-freshly-recovered-children",
		{ operation: "children" },
		undefined,
		undefined,
		reopenedAgain.session.extensionRunner.createContext(),
	);
	assert.deepEqual(
		(secondChildren.details as { children: Array<{ agentId: string }> }).children.map(
			({ agentId }) => agentId,
		),
		[spawned.agentId],
	);
	await reopenedAgain.runtime.dispose();
});

test("duplicate spawn claims quarantine only their dependent authority subtree", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	host.model.setResponses([
		fauxAssistantMessage("First child settled."),
		fauxAssistantMessage("Independent child settled."),
	]);
	const first = await executeTool(host, "agent_spawn", "spawn-conflicted-child", {
		request: "Become the conflicted subtree root.",
		label: "conflicted-root",
	}) as { agentId: string };
	const independent = await executeTool(host, "agent_spawn", "spawn-independent-child", {
		request: "Remain independently verifiable.",
		label: "independent-child",
	}) as { agentId: string };
	const directory = workflowSessionDirectory(host);
	const firstFile = await waitForSessionFile(directory, first.agentId);
	const independentFile = await waitForSessionFile(directory, independent.agentId);
	await waitForTranscriptEntry(
		firstFile,
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	await waitForTranscriptEntry(
		independentFile,
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	const ownerSessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(ownerSessionFile);
	await host.runtime.dispose();
	const ownerTranscript = SessionManager.open(ownerSessionFile);
	const outboundRequestInput = {
		operation: "request" as const,
		targetAgentId: first.agentId,
		question: "Remain waiting even when the responder transcript is quarantined.",
	};
	const outboundEntryId = ownerTranscript.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", outboundRequestInput, {
				id: "request-quarantined-child",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const outboundSource = {
		agentId: host.session.sessionId,
		entryId: outboundEntryId,
		toolCallId: "request-quarantined-child",
	};
	const outboundRequestId = deriveMessageIdentity(outboundSource);
	const outboundReceipt = {
		requestMessageId: outboundRequestId,
		messageStatus: "sent" as const,
	};
	ownerTranscript.appendMessage({
		role: "toolResult",
		toolCallId: outboundSource.toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(outboundReceipt) }],
		details: outboundReceipt,
		isError: false,
		timestamp: Date.now(),
	});
	const foreignSpawnEntryId = ownerTranscript.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Remain foreign to the active Workflow." },
				{ id: "spawn-foreign-candidate" },
			),
			{ stopReason: "toolUse" },
		),
	);
	const foreignTranscript = SessionManager.create(host.cwd, directory);
	const foreignAgentId = foreignTranscript.getSessionId();
	foreignTranscript.appendCustomEntry("agent-coordination.identity", {
		agentId: foreignAgentId,
		workflowId: "foreign-workflow",
		directSpawnerAgentId: host.session.sessionId,
		spawnSource: {
			agentId: host.session.sessionId,
			entryId: foreignSpawnEntryId,
			toolCallId: "spawn-foreign-candidate",
		},
		metadata: { label: "agent" },
	});
	foreignTranscript.appendMessage(fauxAssistantMessage("Persist foreign candidate evidence."));

	const firstTranscript = SessionManager.open(firstFile);
	const inboundRequestInput = {
		operation: "request" as const,
		targetAgentId: host.session.sessionId,
		question: "Remain answer-owed even when the requester transcript is quarantined.",
	};
	const inboundEntryId = firstTranscript.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", inboundRequestInput, {
				id: "request-from-quarantined-child",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const inboundSource = {
		agentId: first.agentId,
		entryId: inboundEntryId,
		toolCallId: "request-from-quarantined-child",
	};
	const inboundRequestId = deriveMessageIdentity(inboundSource);
	const inboundDelivery = createMessageDelivery([
		{
			source: inboundSource,
			projection: {
				kind: "request",
				requestMessageId: inboundRequestId,
				fromAgentId: first.agentId,
				question: inboundRequestInput.question,
			},
		},
	]);
	ownerTranscript.appendCustomMessageEntry(
		inboundDelivery.customType,
		inboundDelivery.content,
		inboundDelivery.display,
		inboundDelivery.details,
	);
	const firstIdentity = firstTranscript.getEntries()[0];
	assert.ok(firstIdentity?.type === "custom");
	const firstIdentityData = firstIdentity.data as {
		spawnSource: { agentId: string; entryId: string; toolCallId: string };
	};
	const nestedSpawnEntryId = firstTranscript.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Remain dependent on the conflicted root." },
				{ id: "spawn-dependent-grandchild" },
			),
			{ stopReason: "toolUse" },
		),
	);
	const nestedTranscript = SessionManager.create(
		firstTranscript.getHeader()?.cwd ?? host.cwd,
		directory,
	);
	const nestedAgentId = nestedTranscript.getSessionId();
	nestedTranscript.appendCustomEntry("agent-coordination.identity", {
		agentId: nestedAgentId,
		workflowId: host.session.sessionId,
		directSpawnerAgentId: first.agentId,
		spawnSource: {
			agentId: first.agentId,
			entryId: nestedSpawnEntryId,
			toolCallId: "spawn-dependent-grandchild",
		},
		metadata: { label: "agent" },
	});
	nestedTranscript.appendMessage(fauxAssistantMessage("Persist nested candidate evidence."));

	const duplicateTranscript = SessionManager.create(host.cwd, directory);
	const duplicateAgentId = duplicateTranscript.getSessionId();
	duplicateTranscript.appendCustomEntry("agent-coordination.identity", {
		...(firstIdentity.data as Record<string, unknown>),
		agentId: duplicateAgentId,
	});
	duplicateTranscript.appendMessage(fauxAssistantMessage("Persist duplicate claim evidence."));
	const malformedAgentId = "malformed-agent";
	await writeFile(
		join(directory, "malformed.jsonl"),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: malformedAgentId,
			timestamp: new Date().toISOString(),
			cwd: host.cwd,
		})}\n{malformed}\n`,
		"utf8",
	);
	const cyclicAgentIds = await writeCyclicCandidates(
		directory,
		host.session.sessionId,
		host.cwd,
	);
	const bytesBeforeAdmission = await snapshotDirectory(directory);

	const reopened = await reopenOwner(t, host, ownerSessionFile);
	const observe = reopened.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const result = await observe.execute(
		"observe-independent-recovery",
		{ operation: "children" },
		undefined,
		undefined,
		reopened.session.extensionRunner.createContext(),
	);
	assert.deepEqual(
		(result.details as { children: Array<{ agentId: string }> }).children.map(
			({ agentId }) => agentId,
		),
		[independent.agentId],
	);
	const ownerStatus = await observe.execute(
		"observe-owner-quarantined-request-retention",
		{ operation: "status" },
		undefined,
		undefined,
		reopened.session.extensionRunner.createContext(),
	);
	const ownerRun = (ownerStatus.details as {
		run: { retentionReasons: Array<{ reason: string; count: number }> };
	}).run;
	// The verified independent child's Creation Request and the ordinary Request to
	// the quarantined child are both still waiting in the Owner transcript.
	assert.equal(retentionCount(ownerRun, "awaiting_answer"), 2);
	assert.equal(retentionCount(ownerRun, "answer_owed"), 1);
	await assert.rejects(
		() => executeTool(reopened, "agent_message", "retry-quarantined-request", {
			operation: "retry",
			messageId: outboundRequestId,
		}),
		/evidence_unavailable/,
	);
	await assert.rejects(
		() => executeTool(reopened, "agent_message", "answer-quarantined-request", {
			operation: "answer",
			answer: "Unavailable requester proof must stay explicit.",
		}),
		/evidence_unavailable/,
	);
	for (const unavailableAgentId of [
		first.agentId,
		duplicateAgentId,
		nestedAgentId,
		foreignAgentId,
		malformedAgentId,
		...cyclicAgentIds,
	]) {
		await assert.rejects(
			() => observe.execute(
				`observe-quarantined-${unavailableAgentId}`,
				{ operation: "status", agentId: unavailableAgentId },
				undefined,
				undefined,
				reopened.session.extensionRunner.createContext(),
			),
			/evidence_unavailable/,
		);
	}
	assert.deepEqual(
		reopened.ui.notifications.filter(({ type }) => type === "warning"),
		[
			{
				type: "warning",
				message:
					"7 Agent transcript candidates were quarantined; independently verified Agents remain available.",
			},
		],
	);
	assert.deepEqual(await snapshotDirectory(directory), bytesBeforeAdmission);
	await reopened.runtime.dispose();
});

test("opening and closing a cold-recovered answer-obligated Agent keeps it dormant", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
		settings: { retry: { enabled: false } },
	});
	await bindTestOwnerHost(host, "tui");
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				{ question: "Leave the Creation Request unanswered across host loss." },
				{ id: "pause-before-cold-dormant-inspection" },
			),
			{ stopReason: "toolUse" },
		),
	]);
	const spawned = await executeTool(
		host,
		"agent_spawn",
		"spawn-cold-dormant-inspection-child",
		{
			request: "Keep this Creation Request unresolved across host loss.",
			label: "cold-dormant-inspection-child",
		},
	) as { agentId: string };
	const workflowDirectory = workflowSessionDirectory(host);
	const childSessionFile = await waitForSessionFile(
		workflowDirectory,
		spawned.agentId,
	);
	await waitForTranscriptEntry(
		childSessionFile,
		(entry) => entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) =>
					part.type === "toolCall" &&
					part.id === "pause-before-cold-dormant-inspection",
			),
	);
	assert.equal(await countModeratorSessions(workflowDirectory), 0);
	const ownerSessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(ownerSessionFile);
	await host.runtime.dispose();

	const reopened = await reopenOwner(t, host, ownerSessionFile, {
		implicitModeratorResponses: false,
	});
	const observe = reopened.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const observePhase = async (toolCallId: string) => {
		const result = await observe.execute(
			toolCallId,
			{ operation: "status", agentId: spawned.agentId },
			undefined,
			undefined,
			reopened.session.extensionRunner.createContext(),
		);
		return (result.details as { run: { phase: string } }).run.phase;
	};
	assert.equal(await observePhase("observe-before-cold-dormant-inspection"), "dormant");
	assert.equal(await countModeratorSessions(workflowDirectory), 0);
	const entriesBeforeInspection = SessionManager.open(childSessionFile).getEntries();

	const opened = await openDormantAgentView(reopened, spawned.agentId);
	assert.equal(await observePhase("observe-during-cold-dormant-inspection"), "dormant");
	await reopened.runtime.dispose();
	await opened.command;
	assert.deepEqual(
		SessionManager.open(childSessionFile).getEntries(),
		entriesBeforeInspection,
	);
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
	assert.equal(await countModeratorSessions(workflowDirectory), 0);
});

test("cold successor re-resolves current configuration and recovers residual Creation Request retention", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	const templateDirectory = join(host.services.agentDir, "agents");
	const templatePath = join(templateDirectory, "residual.md");
	await mkdir(templateDirectory, { recursive: true });
	await writeFile(
		templatePath,
		"---\nname: residual-agent\nuse-when: Use for residual work.\nallowed-tools: read\n---\nInitial context",
	);
	await bindTestOwnerHost(host, "tui");
	host.model.setResponses([
		fauxAssistantMessage("Initial work settled without answering the Creation Request."),
	]);
	const spawned = await executeTool(host, "agent_spawn", "spawn-residual-request-child", {
		request: "Keep this Creation Request unresolved across host loss.",
		template: "residual-agent",
		label: "residual-child",
	}) as { agentId: string };
	const childSessionFile = await waitForSessionFile(
		workflowSessionDirectory(host),
		spawned.agentId,
	);
	await waitForTranscriptEntry(
		childSessionFile,
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	const ownerSessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(ownerSessionFile);
	await host.runtime.dispose();
	await writeFile(
		templatePath,
		"---\nname: residual-agent\nuse-when: Use for residual work.\nallowed-tools:\n  - read\n  - bash\n---\nCurrent context",
	);

	const reopened = await reopenOwner(t, host, ownerSessionFile);
	const observe = reopened.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const ownerStatus = await observe.execute(
		"observe-recovered-owner-retention",
		{ operation: "status" },
		undefined,
		undefined,
		reopened.session.extensionRunner.createContext(),
	);
	assert.equal(
		retentionCount(
			(ownerStatus.details as { run: { retentionReasons: Array<{ reason: string; count: number }> } })
				.run,
			"awaiting_answer",
		),
		1,
	);
	const dormantStatus = await observe.execute(
		"observe-residual-child-before-start",
		{ operation: "status", agentId: spawned.agentId },
		undefined,
		undefined,
		reopened.session.extensionRunner.createContext(),
	);
	assert.deepEqual(
		(dormantStatus.details as { run: { phase: string; retentionReasons: unknown[] } }).run,
		{ phase: "dormant", retentionReasons: [] },
	);

	let successorTools: string[] = [];
	reopened.model.setResponses([
		(context) => {
			successorTools = context.tools?.map(({ name }) => name) ?? [];
			return fauxAssistantMessage(
				fauxToolCall(
					"ask_user_question",
					{ question: "Keep this successor Run observable." },
					{ id: "hold-recovered-child-run" },
				),
				{ stopReason: "toolUse" },
			);
		},
	]);
	await executeTool(reopened, "agent_message", "start-residual-child", {
		operation: "send",
		targetAgentId: spawned.agentId,
		content: "Start a successor Run without resolving the Creation Request.",
	});
	await waitForCondition(async () => {
		const status = await observe.execute(
			"observe-started-residual-child",
			{ operation: "status", agentId: spawned.agentId },
			undefined,
			undefined,
			reopened.session.extensionRunner.createContext(),
		);
		return (status.details as { run: { attention?: string } }).run.attention === "input_required";
	});
	const liveStatus = await observe.execute(
		"observe-recovered-child-obligation",
		{ operation: "status", agentId: spawned.agentId },
		undefined,
		undefined,
		reopened.session.extensionRunner.createContext(),
	);
	assert.equal(
		retentionCount(
			(liveStatus.details as { run: { retentionReasons: Array<{ reason: string; count: number }> } })
				.run,
			"answer_owed",
		),
		1,
	);
	assert.equal(successorTools.includes("read"), true);
	assert.equal(successorTools.includes("bash"), true);
	await reopened.runtime.dispose();
});

test("reopen derives ordinary Request evidence from abandoned branches across compaction", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	host.model.setResponses([
		fauxAssistantMessage("The self Request is delivered but remains unanswered."),
	]);
	const request = await executeTool(host, "agent_message", "self-request-before-branch", {
		operation: "request",
		targetAgentId: host.session.sessionId,
		question: "Remain unresolved on an abandoned physical branch.",
	}) as { requestMessageId: string };
	await host.session.waitForIdle();
	const identity = host.session.sessionManager.getEntries().find(
		(entry) => entry.type === "custom" && entry.customType === "agent-coordination.identity",
	);
	assert.ok(identity?.type === "custom");
	host.session.sessionManager.branch(identity.id);
	host.session.sessionManager.appendCompaction(
		"The active branch compacted after abandoning coordination evidence.",
		identity.id,
		0,
	);
	const ownerSessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(ownerSessionFile);
	await host.runtime.dispose();

	const reopened = await reopenOwner(t, host, ownerSessionFile);
	const observe = reopened.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const reopenedStatus = await observe.execute(
		"observe-branch-residuals",
		{ operation: "status" },
		undefined,
		undefined,
		reopened.session.extensionRunner.createContext(),
	);
	const reopenedRun = (reopenedStatus.details as {
		run: { retentionReasons: Array<{ reason: string; count: number }> };
	}).run;
	assert.equal(retentionCount(reopenedRun, "awaiting_answer"), 1);
	assert.equal(retentionCount(reopenedRun, "answer_owed"), 1);

	reopened.model.setResponses([
		fauxAssistantMessage("The self Answer Delivery resolves the remaining requester wait."),
	]);
	await executeTool(reopened, "agent_message", "answer-branch-residual", {
		operation: "answer",
		answer: "Resolved after recovery.",
	});
	await reopened.session.waitForIdle();
	await reopened.runtime.dispose();

	const reopenedAgain = await reopenOwner(t, host, ownerSessionFile);
	const secondObserve = reopenedAgain.session.getToolDefinition("agent_observe");
	assert.ok(secondObserve);
	const resolvedStatus = await secondObserve.execute(
		"observe-resolved-branch-residuals",
		{ operation: "status" },
		undefined,
		undefined,
		reopenedAgain.session.extensionRunner.createContext(),
	);
	const resolvedRun = (resolvedStatus.details as {
		run: { retentionReasons: Array<{ reason: string; count: number }> };
	}).run;
	assert.equal(retentionCount(resolvedRun, "awaiting_answer"), 0);
	assert.equal(retentionCount(resolvedRun, "answer_owed"), 0);
	await reopenedAgain.runtime.dispose();
});

test("recovered authority keeps physical child order while Dormant view uses Pi recency", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	host.model.setResponses([
		fauxAssistantMessage("First ordered child settled."),
		fauxAssistantMessage("Second ordered child settled."),
	]);
	const first = await executeTool(host, "agent_spawn", "spawn-physical-first", {
		request: "Remain first in structural order.",
		label: "physical-first",
	}) as { agentId: string };
	const second = await executeTool(host, "agent_spawn", "spawn-physical-second", {
		request: "Become most recent in the dormant roster.",
		label: "recent-second",
	}) as { agentId: string };
	const directory = workflowSessionDirectory(host);
	const firstFile = await waitForSessionFile(directory, first.agentId);
	const secondFile = await waitForSessionFile(directory, second.agentId);
	await waitForTranscriptEntry(
		firstFile,
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	await waitForTranscriptEntry(
		secondFile,
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	const ownerSessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(ownerSessionFile);
	await host.runtime.dispose();
	SessionManager.open(secondFile).appendMessage(
		fauxAssistantMessage("Newest dormant activity.", {
			timestamp: Date.now() + 60_000,
		}),
	);

	const reopened = await reopenOwner(t, host, ownerSessionFile);
	const observe = reopened.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const children = await observe.execute(
		"observe-physical-child-order-after-reopen",
		{ operation: "children" },
		undefined,
		undefined,
		reopened.session.extensionRunner.createContext(),
	);
	assert.deepEqual(
		(children.details as { children: Array<{ agentId: string }> }).children.map(
			({ agentId }) => agentId,
		),
		[first.agentId, second.agentId],
	);
	const recencyAgents = await openAgentsSurface(reopened);
	recencyAgents.surface.handleInput?.("\t");
	const dormantLines = recencyAgents.surface.render(80);
	const recentIndex = dormantLines.findIndex((line) => line.includes("recent-second"));
	const physicalIndex = dormantLines.findIndex((line) => line.includes("physical-first"));
	assert.ok(recentIndex >= 0 && recentIndex < physicalIndex);
	recencyAgents.surface.handleInput?.("\x1b");
	await recencyAgents.command;
	await reopened.runtime.dispose();
});

test("a fresh Owner host rediscovers a standalone Moderator without reconstructing handling", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
		settings: { retry: { enabled: false } },
	});
	await bindTestOwnerHost(host, "tui");
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"agent_spawn",
				{ request: "Settle while still owing this Creation Request." },
				{ id: "spawn-cold-moderator-trigger" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The cold-recovery trigger is delegated."),
		fauxAssistantMessage("I settled without an Answer."),
		fauxAssistantMessage("I recorded initial Moderator evidence."),
	]);
	await host.session.prompt("Create a Moderator that can be recovered after host loss.");
	await host.session.waitForIdle();
	const directory = workflowSessionDirectory(host);
	const moderator = await waitForModeratorSession(directory);
	const ownerSessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(ownerSessionFile);
	await host.runtime.dispose();

	const reopened = await reopenOwner(t, host, ownerSessionFile, {
		implicitModeratorResponses: false,
	});
	const observe = reopened.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const statusResult = await observe.execute(
		"observe-recovered-moderator",
		{ operation: "status", agentId: moderator.agentId },
		undefined,
		undefined,
		reopened.session.extensionRunner.createContext(),
	);
	const status = statusResult.details as {
		agentId: string;
		label: string;
		directSpawnerAgentId: string | null;
		run: { phase: string; retentionReasons: Array<{ reason: string }> };
	};
	assert.deepEqual(
		{
			agentId: status.agentId,
			label: status.label,
			directSpawnerAgentId: status.directSpawnerAgentId,
			phase: status.run.phase,
			retentionReasons: status.run.retentionReasons,
		},
		{
			agentId: moderator.agentId,
			label: "Moderator",
			directSpawnerAgentId: null,
			phase: "dormant",
			retentionReasons: [],
		},
	);
	const children = await observe.execute(
		"observe-children-with-standalone-moderator",
		{ operation: "children" },
		undefined,
		undefined,
		reopened.session.extensionRunner.createContext(),
	);
	assert.equal(
		(children.details as { children: Array<{ agentId: string }> }).children.some(
			({ agentId }) => agentId === moderator.agentId,
		),
		false,
	);
	const moderatorAgents = await openAgentsSurface(reopened);
	moderatorAgents.surface.handleInput?.("\t");
	let dormantModerator = moderatorAgents.surface.render(80).join("\n");
	for (let step = 0; step < 2 && !dormantModerator.includes(moderator.agentId); step += 1) {
		moderatorAgents.surface.handleInput?.("j");
		dormantModerator = moderatorAgents.surface.render(80).join("\n");
	}
	assert.match(dormantModerator, /moderator.*moderating obligation stall/i);
	assert.match(dormantModerator, new RegExp(moderator.agentId));
	moderatorAgents.surface.handleInput?.("\x1b");
	await moderatorAgents.command;

	let recoveredTools: string[] = [];
	reopened.model.setResponses([
		(context) => {
			recoveredTools = context.tools?.map(({ name }) => name).sort() ?? [];
			return fauxAssistantMessage("The recovered Moderator received routing.");
		},
	]);
	await executeTool(
		reopened,
		"agent_message",
		"route-to-recovered-moderator",
		{
			operation: "send",
			targetAgentId: moderator.agentId,
			content: "Inspect post-mortem evidence without reconstructing handling.",
		},
	);
	await waitForTranscriptEntry(
		moderator.path,
		(entry) => entry.type === "message" && entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "text" &&
					part.text === "The recovered Moderator received routing.",
			),
	);
	assert.deepEqual(recoveredTools, [
		"agent_control",
		"agent_message",
		"agent_observe",
		"ask_user_question",
		"bash",
		"edit",
		"find",
		"grep",
		"ls",
		"moderator_control",
		"read",
		"write",
	]);
	await reopened.runtime.dispose();
});

test("host loss removes exhausted Operational Attention and attempt handling", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
	});
	await bindTestOwnerHost(host, "tui");
	const terminalModeratorFailure = fauxAssistantMessage(
		"This Moderator attempt fails terminally.",
		{
			stopReason: "error",
			errorMessage: "400 invalid_request_error: deterministic exhausted Moderator failure",
		},
	);
	host.model.setResponses([
		fauxAssistantMessage("I settled without answering the Creation Request."),
		fauxAssistantMessage("I remained settled after the runtime reminder."),
		...Array.from(
			{
				length:
					2 * (host.services.settingsManager.getRetrySettings().maxRetries + 2),
			},
			() => terminalModeratorFailure,
		),
	]);
	const affected = await executeTool(
		host,
		"agent_spawn",
		"spawn-exhausted-attention-before-reopen",
		{
			request: "Settle while still owing this Creation Request.",
			label: "Affected Agent",
		},
	) as { agentId: string };
	const directory = workflowSessionDirectory(host);
	await waitForCondition(async () => {
		const sessions = await SessionManager.list(host.cwd, directory);
		const failedModerators = sessions.filter(({ path }) => {
			const entries = SessionManager.open(path).getEntries();
			const tail = entries.at(-1);
			return entries[0]?.type === "custom_message" &&
				entries[0].customType === "agent-coordination.moderator-input" &&
				tail?.type === "message" &&
				tail.message.role === "assistant" &&
				tail.message.stopReason === "error";
		});
		return failedModerators.length === 2;
	});
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const failedModeratorIds = (await SessionManager.list(host.cwd, directory)).flatMap(
		({ path }) => {
			const session = SessionManager.open(path);
			const entries = session.getEntries();
			const tail = entries.at(-1);
			return entries[0]?.type === "custom_message" &&
				entries[0].customType === "agent-coordination.moderator-input" &&
				tail?.type === "message" && tail.message.role === "assistant" &&
				tail.message.stopReason === "error"
				? [session.getSessionId()]
				: [];
		},
	);
	await waitForCondition(async () => {
		for (const agentId of failedModeratorIds) {
			const result = await observe.execute(
				`observe-failed-moderator-${agentId}`,
				{ operation: "status", agentId },
				undefined,
				undefined,
				host.session.extensionRunner.createContext(),
			);
			if ((result.details as { run: { phase: string } }).run.phase !== "dormant") {
				return false;
			}
		}
		return true;
	});
	const attentionAgents = await openAgentsSurface(host);
	await waitForCondition(async () =>
		attentionAgents.surface.render(80).join("\n").includes(
			"→ ATTENTION 1 · Obligation Stall",
		)
	);
	const operationalAttention = attentionAgents.surface.render(80).join("\n");
	assert.match(operationalAttention, /→ ATTENTION 1 · Obligation Stall/);
	assert.match(operationalAttention, /Affected Agent/);
	assert.doesNotMatch(operationalAttention, new RegExp(affected.agentId));
	assert.match(operationalAttention, /Request .*\/.*\/.*/);
	assert.equal((operationalAttention.match(/Diagnostic /g) ?? []).length, 2);
	attentionAgents.surface.handleInput?.("\x1b");
	await attentionAgents.command;

	const ownerSessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(ownerSessionFile);
	await host.runtime.dispose();
	const reopened = await reopenOwner(t, host, ownerSessionFile, {
		implicitModeratorResponses: false,
	});
	const reopenedAgents = await openAgentsSurface(reopened);
	assert.doesNotMatch(reopenedAgents.surface.render(80).join("\n"), /ATTENTION 1/);
	reopenedAgents.surface.handleInput?.("\x1b");
	await reopenedAgents.command;
	await reopened.runtime.dispose();
});

test("cold discovery quarantines malformed Moderator bootstrap evidence", async (t) => {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage("Persist the Owner before malformed candidate discovery."),
	);
	const ownerIdentity = host.session.sessionManager.getEntries().find(
		(entry) => entry.type === "custom" &&
			entry.customType === "agent-coordination.identity",
	);
	assert.ok(ownerIdentity?.type === "custom");
	const candidateDirectory = workflowSessionDirectory(host);
	await mkdir(candidateDirectory, { recursive: true });
	const malformed = SessionManager.create(host.cwd, candidateDirectory);
	const malformedAgentId = malformed.getSessionId();
	malformed.appendCustomMessageEntry(
		"agent-coordination.moderator-input",
		JSON.stringify({
			trigger: {
				kind: "obligation_stall",
				agentId: host.session.sessionId,
				obligations: { total: 0, sources: [] },
			},
			inspectedThrough: [
				{ agentId: host.session.sessionId, entryId: ownerIdentity.id },
			],
		}),
		true,
		{
			agentId: malformedAgentId,
			workflowId: host.session.sessionId,
			metadata: {
				label: "Moderator",
				description: "obligation stall",
			},
		},
	);
	malformed.appendMessage(fauxAssistantMessage("Flush malformed Moderator evidence."));
	const malformedPath = malformed.getSessionFile();
	assert.ok(malformedPath);
	assert.equal(dirname(malformedPath), candidateDirectory);
	await waitForSessionFile(candidateDirectory, malformedAgentId);
	const ownerSessionFile = host.session.sessionManager.getSessionFile();
	assert.ok(ownerSessionFile);
	await host.runtime.dispose();
	await waitForSessionFile(candidateDirectory, malformedAgentId);

	const reopened = await reopenOwner(t, host, ownerSessionFile);
	const observe = reopened.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	await assert.rejects(
		observe.execute(
			"observe-malformed-moderator",
			{ operation: "status", agentId: malformedAgentId },
			undefined,
			undefined,
			reopened.session.extensionRunner.createContext(),
		),
		/evidence_unavailable/,
	);
	assert.equal(
		reopened.ui.notifications.some(
			({ message, type }) => type === "warning" &&
				message.includes("1 Agent transcript candidate was quarantined"),
		),
		true,
		JSON.stringify(reopened.ui.notifications),
	);
	await reopened.runtime.dispose();
});

async function createUnboundTestOwnerHost(
	t: TestContext,
	extension: typeof piAgentCoordination,
	options?: TestOwnerHostOptions,
): Promise<TestOwnerHost> {
	const broker = await createProcessModelBroker({
		responseOverride: (context) => {
			const response = (options?.implicitModeratorResponses ?? true)
				? implicitOperationalResponse(context)
				: undefined;
			return response ? fauxAssistantMessage(response) : undefined;
		},
	});
	durableModelBrokers.add(broker);
	try {
		return await createHostWithDurableModelBroker(t, extension, broker, options);
	} catch (error) {
		durableModelBrokers.delete(broker);
		await broker.close();
		throw error;
	}
}

async function reopenOwner(
	t: TestContext,
	previous: TestOwnerHost,
	sessionFile: string,
	options?: {
		implicitModeratorResponses?: boolean;
	},
): Promise<TestOwnerHost> {
	const broker = hostModelBrokers.get(previous);
	assert.ok(broker, "Expected the previous host's durable process model broker");
	const reopened = await createHostWithDurableModelBroker(
		t,
		piAgentCoordination,
		broker,
		{
			cwd: previous.cwd,
			agentDir: previous.services.agentDir,
			sessionFile,
			implicitModeratorResponses: options?.implicitModeratorResponses,
		},
	);
	await bindTestOwnerHost(reopened, "tui");
	return reopened;
}

async function createHostWithDurableModelBroker(
	t: TestContext,
	extension: typeof piAgentCoordination,
	broker: ProcessModelBroker,
	options?: TestOwnerHostOptions,
): Promise<TestOwnerHost> {
	const host = await createBaseUnboundTestOwnerHost(t, extension, {
		...options,
		processVisibleModel: false,
		additionalExtensionPaths: [
			...(options?.additionalExtensionPaths ?? []),
			broker.extensionPath,
		],
	});
	const processVisibleHost: TestOwnerHost = {
		...host,
		model: {
			setResponses(responses: FauxResponseStep[]) {
				broker.setResponses(responses);
			},
		},
	};
	hostModelBrokers.set(processVisibleHost, broker);
	return processVisibleHost;
}

function implicitOperationalResponse(context: Context): string | undefined {
	const latestMessage = JSON.stringify(context.messages.at(-1));
	if (
		latestMessage.includes("requestSnippet") &&
		latestMessage.includes("You still owe an Answer to this Request.")
	) return "I remain settled after the automatic Answer reminder.";
	return isImplicitModeratorRequest(context)
		? "I will wait for explicit Moderator work."
		: undefined;
}

function isImplicitModeratorRequest(context: Context): boolean {
	return context.tools?.some(({ name }) => name === "moderator_control") === true &&
		context.messages.some((message) =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some(
				(part) => part.type === "text" &&
					part.text.includes('"kind":"obligation_stall"'),
			)
		);
}

async function countModeratorSessions(directory: string): Promise<number> {
	let count = 0;
	for (const filename of await readdir(directory)) {
		if (!filename.endsWith(".jsonl")) continue;
		const entries = SessionManager.open(join(directory, filename)).getEntries();
		if (
			entries.some(
				(entry) => entry.type === "custom_message" &&
					entry.customType === "agent-coordination.moderator-input",
			)
		) count += 1;
	}
	return count;
}

async function waitForModeratorSession(
	directory: string,
): Promise<{ agentId: string; path: string }> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		for (const filename of await readdir(directory)) {
			if (!filename.endsWith(".jsonl")) continue;
			const path = join(directory, filename);
			const sessionManager = SessionManager.open(path);
			if (
				sessionManager.getEntries().some(
					(entry) => entry.type === "custom_message" &&
						entry.customType === "agent-coordination.moderator-input",
				)
			) return { agentId: sessionManager.getSessionId(), path };
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Expected persisted Moderator session");
}

async function executeTool(
	host: TestOwnerHost,
	toolName: "agent_spawn" | "agent_message",
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	const result = await executeRegisteredTool(
		host.runtime.session,
		toolName,
		toolCallId,
		input,
	);
	return result.details;
}

function workflowSessionDirectory(host: TestOwnerHost): string {
	return join(
		host.session.sessionManager.getSessionDir(),
		"pi-agent-coordination",
		Buffer.from(host.session.sessionId, "utf8").toString("base64url"),
	);
}

async function waitForSessionFile(
	directory: string,
	agentId: string,
): Promise<string> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		for (const filename of await readdir(directory)) {
			if (!filename.endsWith(".jsonl")) continue;
			const path = join(directory, filename);
			if (SessionManager.open(path).getSessionId() === agentId) return path;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error(`Expected persisted session ${agentId}`);
}

async function waitForTranscriptEntry(
	sessionFile: string,
	predicate: (entry: ReturnType<SessionManager["getEntries"]>[number]) => boolean,
): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		if (SessionManager.open(sessionFile).getEntries().some(predicate)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Expected transcript evidence to commit");
}

async function snapshotDirectory(directory: string): Promise<Map<string, Buffer>> {
	const snapshot = new Map<string, Buffer>();
	for (const filename of (await readdir(directory)).sort()) {
		snapshot.set(filename, await readFile(join(directory, filename)));
	}
	return snapshot;
}

function retentionCount(
	run: { retentionReasons: Array<{ reason: string; count: number }> },
	reason: "awaiting_answer" | "answer_owed",
): number {
	return run.retentionReasons.find((retention) => retention.reason === reason)?.count ?? 0;
}

async function waitForCondition(predicate: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITION_POLL_ATTEMPTS; attempt += 1) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Expected condition was not reached");
}

async function writeCyclicCandidates(
	directory: string,
	workflowId: string,
	cwd: string,
): Promise<readonly [string, string]> {
	const agentA = "cyclic-agent-a";
	const agentB = "cyclic-agent-b";
	const timestamp = new Date().toISOString();
	const candidates = [
		{
			agentId: agentA,
			directSpawnerAgentId: agentB,
			identityEntryId: "cyclic-identity-a",
			spawnEntryId: "cyclic-spawn-b-entry",
			spawnToolCallId: "cyclic-spawn-agent-b",
			claimedSourceEntryId: "cyclic-spawn-a-entry",
			claimedSourceToolCallId: "cyclic-spawn-agent-a",
		},
		{
			agentId: agentB,
			directSpawnerAgentId: agentA,
			identityEntryId: "cyclic-identity-b",
			spawnEntryId: "cyclic-spawn-a-entry",
			spawnToolCallId: "cyclic-spawn-agent-a",
			claimedSourceEntryId: "cyclic-spawn-b-entry",
			claimedSourceToolCallId: "cyclic-spawn-agent-b",
		},
	] as const;
	for (const candidate of candidates) {
		const header = {
			type: "session",
			version: 3,
			id: candidate.agentId,
			timestamp,
			cwd,
		};
		const identity = {
			type: "custom",
			id: candidate.identityEntryId,
			parentId: null,
			timestamp,
			customType: "agent-coordination.identity",
			data: {
				agentId: candidate.agentId,
				workflowId,
				directSpawnerAgentId: candidate.directSpawnerAgentId,
				spawnSource: {
					agentId: candidate.directSpawnerAgentId,
					entryId: candidate.claimedSourceEntryId,
					toolCallId: candidate.claimedSourceToolCallId,
				},
				metadata: { label: "agent" },
			},
		};
		const spawn = {
			type: "message",
			id: candidate.spawnEntryId,
			parentId: candidate.identityEntryId,
			timestamp,
			message: fauxAssistantMessage(
				fauxToolCall(
					"agent_spawn",
					{ request: "Complete the cyclic authority fixture." },
					{ id: candidate.spawnToolCallId },
				),
				{ stopReason: "toolUse" },
			),
		};
		await writeFile(
			join(directory, `${candidate.agentId}.jsonl`),
			`${JSON.stringify(header)}\n${JSON.stringify(identity)}\n${JSON.stringify(spawn)}\n`,
			"utf8",
		);
	}
	return [agentA, agentB];
}
