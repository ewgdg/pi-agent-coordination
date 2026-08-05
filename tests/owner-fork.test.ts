import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import piAgentCoordination from "../src/index.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";

test("native clone is cancelled while an ordinary child is selected", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	try {
		host.model.setResponses([
			fauxAssistantMessage("The child remains available for native clone gating."),
		]);
		const spawn = await executeTool(host, "agent_spawn", "spawn-clone-gated-child", {
			request: "Remain available while native clone authorization is checked.",
		});
		const childAgentId = (spawn as { agentId: string }).agentId;
		host.ui.select = async (title, options) => {
			host.ui.agentViews.push({ title, options: [...options] });
			return options.find((option) => option.includes(childAgentId));
		};
		await host.session.prompt("/agents");
		const selectedChild = host.runtime.session;
		assert.equal(selectedChild.sessionId, childAgentId);
		await selectedChild.waitForIdle();
		const childSessionFile = selectedChild.sessionManager.getSessionFile();
		assert.ok(childSessionFile);
		assert.equal(existsSync(childSessionFile), true, childSessionFile);
		const leafId = selectedChild.sessionManager.getLeafId();
		assert.ok(leafId);

		const result = await host.runtime.fork(leafId, { position: "at" });

		assert.deepEqual(result, { cancelled: true });
		assert.equal(host.runtime.session, selectedChild);
	} finally {
		await host.runtime.dispose();
	}
});

test("native fork is cancelled for a matching Moderator bootstrap", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination, {
		persistent: true,
	});
	host.session.sessionManager.appendCustomMessageEntry(
		"agent-coordination.moderator-input",
		"Investigate one current Workflow condition.",
		true,
		{
			agentId: host.session.sessionId,
			workflowId: "source-workflow",
			configuration: {
				label: "moderator",
				description: "run failure",
				baseline: ownerBaseline(host),
			},
		},
	);
	await bindTestOwnerHost(host, "tui");
	try {
		host.model.setResponses([
			fauxAssistantMessage("The Moderator transcript remains selected."),
		]);
		await host.session.prompt("Keep this native session available for fork gating.");
		await host.session.waitForIdle();
		const userEntry = host.session.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user",
			);
		assert.ok(userEntry);
		const sessionBeforeFork = host.runtime.session;

		const result = await host.runtime.fork(userEntry.id);

		assert.deepEqual(result, { cancelled: true });
		assert.equal(host.runtime.session, sessionBeforeFork);
	} finally {
		await host.runtime.dispose();
	}
});

test("offline fork preparation cannot reclassify copied child evidence as Owner", async () => {
	const source = await createUnboundTestOwnerHost(piAgentCoordination, {
		persistent: true,
	});
	source.session.sessionManager.appendCustomEntry("agent-coordination.identity", {
		agentId: source.session.sessionId,
		workflowId: "source-workflow",
		directSpawnerAgentId: "source-parent",
		spawnSource: {
			agentId: "source-parent",
			entryId: "source-spawn-entry",
			toolCallId: "source-spawn-call",
		},
		configuration: {
			label: "source-child",
			baseline: ownerBaseline(source),
		},
	});
	source.session.sessionManager.appendMessage(
		fauxAssistantMessage("Keep copied child conversation as native context."),
	);
	const sourceFile = source.session.sessionManager.getSessionFile();
	assert.ok(sourceFile);
	const preparedManager = SessionManager.forkFrom(
		sourceFile,
		source.cwd,
		join(source.cwd, "offline-fork"),
	);
	const preparedFile = preparedManager.getSessionFile();
	assert.ok(preparedFile);
	await source.runtime.dispose();

	const prepared = await createUnboundTestOwnerHost(piAgentCoordination, {
		cwd: source.cwd,
		agentDir: source.services.agentDir,
		sessionFile: preparedFile,
	});
	await bindTestOwnerHost(prepared, "tui");
	try {
		assert.equal(prepared.session.getToolDefinition("agent_observe"), undefined);
		assert.equal(
			prepared.session.sessionManager.getEntries().some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "agent-coordination.identity" &&
					(entry.data as { agentId?: unknown }).agentId === prepared.session.sessionId,
			),
			false,
		);
		assert.equal(
			prepared.ui.notifications.some(({ type }) => type === "error"),
			true,
		);
	} finally {
		await prepared.runtime.dispose();
	}
});

test("native Owner clone creates an isolated Workflow after nested coordination", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	const sourceOwner = host.session;
	const sourceOwnerId = sourceOwner.sessionId;
	const sourceFile = sourceOwner.sessionManager.getSessionFile();
	assert.ok(sourceFile);
	try {
		host.model.setResponses([
			fauxAssistantMessage("The direct child is ready for nested coordination."),
		]);
		const directSpawn = await executeTool(
			host,
			"agent_spawn",
			"spawn-source-direct-child",
			{ request: "Create a nested source Workflow for clone coverage." },
		);
		const directChildId = (directSpawn as { agentId: string }).agentId;
		await selectAgent(host, directChildId);
		const directChild = host.runtime.session;
		await directChild.waitForIdle();

		host.model.setResponses([
			fauxAssistantMessage("The nested child is ready in the source Workflow."),
		]);
		const nestedSpawn = await executeTool(
			host,
			"agent_spawn",
			"spawn-source-nested-child",
			{ request: "Remain as a nested source Agent." },
		);
		const nestedChildId = (nestedSpawn as { agentId: string }).agentId;
		await selectAgent(host, nestedChildId);
		const nestedChild = host.runtime.session;
		await nestedChild.waitForIdle();
		const directChildDisposals = countDisposals(directChild);
		const nestedChildDisposals = countDisposals(nestedChild);

		await selectAgent(host, sourceOwnerId);
		assert.equal(host.runtime.session, sourceOwner);
		host.model.setResponses([
			fauxAssistantMessage("Keep the delivered Request unresolved in the source Workflow."),
		]);
		const request = await executeTool(
			host,
			"agent_message",
			"request-source-child-before-clone",
			{
				operation: "request",
				targetAgentId: directChildId,
				question: "What source-only result should remain unresolved?",
			},
		);
		const sourceRequestId = (request as { requestId: string }).requestId;
		await directChild.waitForIdle();
		const delivered = await executeTool(
			host,
			"agent_message",
			"poll-delivered-source-request-before-clone",
			{ operation: "poll", messageId: sourceRequestId },
		) as { disposition: string };
		assert.equal(delivered.disposition, "delivered");
		host.model.setResponses([
			fauxAssistantMessage("Copied conversation remains useful model context."),
		]);
		await sourceOwner.prompt("Preserve this source conversation in the clone.");
		await sourceOwner.waitForIdle();
		const sourceEntries = structuredClone(sourceOwner.sessionManager.getEntries());
		const sourceLeafId = sourceOwner.sessionManager.getLeafId();
		assert.ok(sourceLeafId);

		const clone = await host.runtime.fork(sourceLeafId, { position: "at" });

		assert.deepEqual(clone, { cancelled: false, selectedText: undefined });
		assert.equal(directChildDisposals(), 1);
		assert.equal(nestedChildDisposals(), 1);
		assert.deepEqual(sourceOwner.sessionManager.getEntries(), sourceEntries);
		const forkOwner = host.runtime.session;
		assert.notEqual(forkOwner.sessionId, sourceOwnerId);
		assert.equal(forkOwner.sessionManager.getHeader()?.parentSession, sourceFile);
		const identities = forkOwner.sessionManager.getEntries().filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "agent-coordination.identity",
		);
		const currentIdentities = identities.filter(
			(entry) =>
				entry.type === "custom" &&
				(entry.data as { agentId?: unknown }).agentId === forkOwner.sessionId,
		);
		assert.equal(currentIdentities.length, 1);
		assert.equal(
			identities.some(
				(entry) =>
					entry.type === "custom" &&
					(entry.data as { agentId?: unknown }).agentId === sourceOwnerId,
			),
			true,
		);
		assert.deepEqual(
			currentIdentities[0] && currentIdentities[0].type === "custom"
				? currentIdentities[0].data
				: undefined,
			{
				agentId: forkOwner.sessionId,
				workflowId: forkOwner.sessionId,
				directSpawnerAgentId: null,
				configuration: {
					label: "owner",
					baseline: ownerBaseline(host),
				},
			},
		);
		const copiedContext = JSON.stringify(
			forkOwner.sessionManager.buildSessionContext().messages,
		);
		assert.match(copiedContext, /Preserve this source conversation in the clone/);
		assert.match(copiedContext, /What source-only result should remain unresolved/);

		const children = await executeTool(
			host,
			"agent_observe",
			"observe-empty-fork-workflow",
			{ operation: "children" },
		);
		assert.deepEqual(children, { children: [] });
		await assertSourceIdentityIsUnavailable(host, {
			directChildId,
			sourceRequestId,
		});

		host.model.setResponses([
			fauxAssistantMessage("The fork child belongs only to the fresh Workflow."),
		]);
		const forkSpawn = await executeTool(
			host,
			"agent_spawn",
			"spawn-fork-only-child",
			{ request: "Remain in the fresh fork Workflow." },
		);
		const forkChildId = (forkSpawn as { agentId: string }).agentId;
		const forkChildren = await executeTool(
			host,
			"agent_observe",
			"observe-fork-only-child",
			{ operation: "children" },
		) as {
			children: Array<{
				agentId: string;
				workflowId: string;
				primaryEvidence: { transcriptPath: string | null };
			}>;
		};
		assert.equal(forkChildren.children.length, 1);
		assert.equal(forkChildren.children[0]?.agentId, forkChildId);
		assert.equal(forkChildren.children[0]?.workflowId, forkOwner.sessionId);
		assert.match(
			forkChildren.children[0]?.primaryEvidence.transcriptPath ?? "",
			new RegExp(Buffer.from(forkOwner.sessionId, "utf8").toString("base64url")),
		);
		assert.notEqual(forkChildId, directChildId);
		assert.notEqual(forkChildId, nestedChildId);
	} finally {
		await host.runtime.dispose();
	}
});

test("native Owner fork preserves branch editing and source Workflow continuation", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	const sourceOwner = host.session;
	const sourceOwnerId = sourceOwner.sessionId;
	const sourceFile = sourceOwner.sessionManager.getSessionFile();
	assert.ok(sourceFile);
	let resumedSource: TestOwnerHost | undefined;
	try {
		host.model.setResponses([
			fauxAssistantMessage("The source child is durable across branch selection."),
		]);
		const spawn = await executeTool(
			host,
			"agent_spawn",
			"spawn-source-branch-child",
			{ request: "Remain available in the source Workflow after its Owner forks." },
		);
		const sourceChildId = (spawn as { agentId: string }).agentId;
		await selectAgent(host, sourceChildId);
		await host.runtime.session.waitForIdle();
		await selectAgent(host, sourceOwnerId);

		const sourceIdentity = sourceOwner.sessionManager.getEntries().find(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "agent-coordination.identity" &&
				(entry.data as { agentId?: unknown }).agentId === sourceOwnerId,
		);
		assert.ok(sourceIdentity);
		sourceOwner.sessionManager.branch(sourceIdentity.id);
		host.model.setResponses([
			fauxAssistantMessage("This branch can be edited into a fresh Workflow."),
		]);
		const editorText = "Edit this user message in the fresh Workflow.";
		await sourceOwner.prompt(editorText);
		await sourceOwner.waitForIdle();
		const forkUserEntry = sourceOwner.sessionManager.getEntries().find(
			(entry) =>
				entry.parentId === sourceIdentity.id &&
				entry.type === "message" &&
				entry.message.role === "user",
		);
		assert.ok(forkUserEntry);

		const fork = await host.runtime.fork(forkUserEntry.id);

		assert.deepEqual(fork, { cancelled: false, selectedText: editorText });
		const forkOwner = host.runtime.session;
		assert.notEqual(forkOwner.sessionId, sourceOwnerId);
		assert.deepEqual(
			(await executeTool(
				host,
				"agent_observe",
				"observe-branch-fork-children",
				{ operation: "children" },
			)) as { children: unknown[] },
			{ children: [] },
		);

		resumedSource = await createUnboundTestOwnerHost(piAgentCoordination, {
			cwd: host.cwd,
			agentDir: host.services.agentDir,
			sessionFile: sourceFile,
		});
		await bindTestOwnerHost(resumedSource, "tui");
		const recovered = await executeTool(
			resumedSource,
			"agent_observe",
			"observe-reopened-source-child",
			{ operation: "children" },
		) as { children: Array<{ agentId: string; workflowId: string }> };
		assert.equal(recovered.children.length, 1);
		assert.equal(recovered.children[0]?.agentId, sourceChildId);
		assert.equal(recovered.children[0]?.workflowId, sourceOwnerId);
		resumedSource.model.setResponses([
			fauxAssistantMessage("The reopened source child accepted new work."),
		]);
		const continued = await executeTool(
			resumedSource,
			"agent_message",
			"continue-reopened-source-workflow",
			{
				operation: "send",
				targetAgentId: sourceChildId,
				content: "Continue only in the reopened source Workflow.",
			},
		) as { delivery: string };
		assert.equal(continued.delivery, "pending");
		assert.equal(host.runtime.session, forkOwner);
	} finally {
		if (resumedSource) await resumedSource.runtime.dispose();
		await host.runtime.dispose();
	}
});

async function executeTool(
	host: TestOwnerHost,
	toolName: "agent_spawn" | "agent_message" | "agent_observe" | "agent_control",
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	const session = host.runtime.session;
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(toolName, input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const tool = session.getToolDefinition(toolName);
	assert.ok(tool);
	const result = await tool.execute(
		toolCallId,
		input,
		undefined,
		undefined,
		session.extensionRunner.createContext(),
	);
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: JSON.stringify(result.details) }],
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
	return result.details;
}

async function selectAgent(host: TestOwnerHost, agentId: string): Promise<void> {
	host.ui.select = async (title, options) => {
		host.ui.agentViews.push({ title, options: [...options] });
		return options.find((option) => option.includes(agentId));
	};
	await host.runtime.session.prompt("/agents");
	assert.equal(host.runtime.session.sessionId, agentId);
}

function countDisposals(session: AgentSession): () => number {
	const nativeDispose = session.dispose.bind(session);
	let calls = 0;
	session.dispose = () => {
		calls += 1;
		nativeDispose();
	};
	return () => calls;
}

async function assertSourceIdentityIsUnavailable(
	host: TestOwnerHost,
	options: { directChildId: string; sourceRequestId: string },
): Promise<void> {
	const cases = [
		{
			tool: "agent_observe" as const,
			input: { operation: "status", agentId: options.directChildId },
		},
		{
			tool: "agent_control" as const,
			input: { operation: "interrupt", agentId: options.directChildId },
		},
		{
			tool: "agent_message" as const,
			input: {
				operation: "send",
				targetAgentId: options.directChildId,
				content: "Do not cross the Workflow cutoff.",
			},
		},
		{
			tool: "agent_message" as const,
			input: { operation: "poll", messageId: options.sourceRequestId },
		},
		{
			tool: "agent_message" as const,
			input: { operation: "retry", messageId: options.sourceRequestId },
		},
		{
			tool: "agent_message" as const,
			input: {
				operation: "answer",
				requestId: options.sourceRequestId,
				answer: "Do not answer across Workflows.",
			},
		},
		{
			tool: "agent_message" as const,
			input: {
				operation: "cancel",
				requestId: options.sourceRequestId,
				reason: "Do not cancel across Workflows.",
			},
		},
	];
	for (const [index, candidate] of cases.entries()) {
		const session = host.runtime.session;
		const toolCallId = `reject-source-identity-${index}`;
		session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall(candidate.tool, candidate.input, { id: toolCallId }),
				{ stopReason: "toolUse" },
			),
		);
		const tool = session.getToolDefinition(candidate.tool);
		assert.ok(tool);
		await assert.rejects(
			() => tool.execute(
				toolCallId,
				candidate.input,
				undefined,
				undefined,
				session.extensionRunner.createContext(),
			),
			/unknown_identity|wrong_workflow|wrong_participant/,
		);
	}
}

function ownerBaseline(host: TestOwnerHost) {
	return {
		cwd: host.cwd,
		model: { provider: "coordination-test", modelId: "deterministic-owner" },
		thinking: "off" as const,
		tools: [],
		skills: [],
		extensions: [],
	};
}
