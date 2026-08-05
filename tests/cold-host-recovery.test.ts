import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";

test("a fresh Owner host rediscovers one dormant child without starting its Run", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination, { persistent: true });
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
	const childIdentityEntry = childTranscript.getEntries().find(
		(entry) => entry.type === "custom" && entry.customType === "agent-coordination.identity",
	);
	assert.ok(childIdentityEntry?.type === "custom");
	const childBaseline = (childIdentityEntry.data as {
		configuration: { baseline: Record<string, unknown> };
	}).configuration.baseline;
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
		configuration: {
			label: "recovered-grandchild",
			baseline: { ...childBaseline, cwd: effectiveCwd },
		},
	});
	grandchildTranscript.appendMessage(
		fauxAssistantMessage("Persist recovered grandchild evidence."),
	);

	const reopened = await reopenOwner(host, ownerSessionFile);
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

	await reopened.session.prompt("/agents");
	assert.equal(
		reopened.ui.agentViews.at(-1)?.options.some(
			(option) => option.includes(`recovered-child · ${spawned.agentId} · dormant`),
		),
		true,
	);
	assert.equal(
		reopened.ui.agentViews.at(-1)?.options.some(
			(option) => option.includes(`recovered-grandchild · ${grandchildAgentId} · dormant`),
		),
		true,
	);
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

	const reopenedAgain = await reopenOwner(host, ownerSessionFile);
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

test("duplicate spawn claims quarantine only their dependent authority subtree", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination, { persistent: true });
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
		messageId: outboundRequestId,
		requestId: outboundRequestId,
		delivery: "pending" as const,
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
		configuration: {
			label: "agent",
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
				requestId: inboundRequestId,
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
		configuration: { baseline: { cwd: string } };
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
		firstIdentityData.configuration.baseline.cwd,
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
		configuration: {
			label: "agent",
			baseline: firstIdentityData.configuration.baseline,
		},
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

	const reopened = await reopenOwner(host, ownerSessionFile);
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
			requestId: inboundRequestId,
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

test("cold bootstrap and successor start recover exact residual Creation Request retention", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	host.model.setResponses([
		fauxAssistantMessage("Initial work settled without answering the Creation Request."),
	]);
	const spawned = await executeTool(host, "agent_spawn", "spawn-residual-request-child", {
		request: "Keep this Creation Request unresolved across host loss.",
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

	const reopened = await reopenOwner(host, ownerSessionFile);
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

	reopened.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				{
					questions: [
						{
							kind: "text",
							header: "Hold",
							prompt: "Keep this successor Run observable.",
							multiline: false,
						},
					],
				},
				{ id: "hold-recovered-child-run" },
			),
			{ stopReason: "toolUse" },
		),
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
	await reopened.runtime.dispose();
});

test("reopen derives ordinary Request evidence from abandoned branches across compaction", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	host.model.setResponses([
		fauxAssistantMessage("The self Request is delivered but remains unanswered."),
	]);
	const request = await executeTool(host, "agent_message", "self-request-before-branch", {
		operation: "request",
		targetAgentId: host.session.sessionId,
		question: "Remain unresolved on an abandoned physical branch.",
	}) as { requestId: string };
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

	const reopened = await reopenOwner(host, ownerSessionFile);
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
		requestId: request.requestId,
		answer: "Resolved after recovery.",
	});
	await reopened.session.waitForIdle();
	await reopened.runtime.dispose();

	const reopenedAgain = await reopenOwner(host, ownerSessionFile);
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

test("recovered authority keeps physical child order while Dormant view uses Pi recency", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination, { persistent: true });
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

	const reopened = await reopenOwner(host, ownerSessionFile);
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
	await reopened.session.prompt("/agents");
	const options = reopened.ui.agentViews.at(-1)?.options ?? [];
	assert.match(options[0] ?? "", /^Live · owner · /);
	assert.match(options[1] ?? "", new RegExp(`^Dormant · recent-second · ${second.agentId}`));
	assert.match(options[2] ?? "", new RegExp(`^Dormant · physical-first · ${first.agentId}`));
	await reopened.runtime.dispose();
});

async function reopenOwner(
	previous: TestOwnerHost,
	sessionFile: string,
): Promise<TestOwnerHost> {
	const reopened = await createUnboundTestOwnerHost(piAgentCoordination, {
		cwd: previous.cwd,
		agentDir: previous.services.agentDir,
		sessionFile,
	});
	await bindTestOwnerHost(reopened, "tui");
	return reopened;
}

async function executeTool(
	host: TestOwnerHost,
	toolName: "agent_spawn" | "agent_message",
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	host.runtime.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(toolName, input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const tool = host.runtime.session.getToolDefinition(toolName);
	assert.ok(tool);
	const result = await tool.execute(
		toolCallId,
		input,
		undefined,
		undefined,
		host.runtime.session.extensionRunner.createContext(),
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
	for (let attempt = 0; attempt < 100; attempt += 1) {
		for (const filename of await readdir(directory)) {
			if (!filename.endsWith(".jsonl")) continue;
			const path = join(directory, filename);
			if (SessionManager.open(path).getSessionId() === agentId) return path;
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`Expected persisted session ${agentId}`);
}

async function waitForTranscriptEntry(
	sessionFile: string,
	predicate: (entry: ReturnType<SessionManager["getEntries"]>[number]) => boolean,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (SessionManager.open(sessionFile).getEntries().some(predicate)) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
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
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
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
	const baseline = {
		cwd,
		model: { provider: "coordination-test", modelId: "deterministic-owner" },
		thinking: "off",
		tools: [],
		skills: [],
		extensions: [],
	};
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
				configuration: { label: "agent", baseline },
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
