import assert from "node:assert/strict";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import piAgentCoordination from "../src/index.ts";
import { discoverColdWorkflow } from "../src/bootstrap/cold-host-discovery.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { resolveMessageIdentity, resolveCommittedSpawnSource } from "../src/protocol/identities.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { createTestOwnerHost, createUnboundTestOwnerHost, type TestOwnerHostOptions } from "./support/pi-host.ts";
import { createTestWorkflowCoordinator } from "./support/workflow-coordinator.ts";

test("Owner tool exposes a short local Agent ID distinct from the global Workflow and Pi session", async (t) => {
	const host = await createTestOwnerHost(t, piAgentCoordination);
	const observe = host.session.getToolDefinition("agent_observe")!;
	const result = await observe.execute("observe", { operation: "status" }, undefined, undefined,
		host.session.extensionRunner.createContext());
	const status = result.details as { agentId: string; workflowId: string };
	assert.equal(status.agentId, "a1");
	assert.equal(status.workflowId, host.session.sessionId);
	const identity = host.session.sessionManager.getEntries().find(entry =>
		entry.type === "custom" && entry.customType === "agent-coordination.identity");
	assert.ok(identity?.type === "custom");
	assert.equal((identity.data as { sessionId: string }).sessionId, host.session.sessionId);
});

test("cold discovery keeps a local child when a foreign Workflow reuses its Agent ID", async (t) => {
	const local = await dormantWorkflow(t);
	const foreign = await dormantWorkflow(t);
	const child = await local.spawn("spawn");
	const otherChild = await foreign.spawn("spawn");
	assert.equal(child.agentId, "a2");
	assert.equal(otherChild.agentId, "a2");
	await copyFile(otherChild.path, join(dirname(child.path), basename(otherChild.path)));
	const recovered = await local.recover();
	assert.deepEqual(recovered.agents.map(agent => agent.identity.agentId), ["a2"]);
	assert.equal(recovered.quarantinedWorkflowAgentIds.has("a2"), false);
	assert.equal(recovered.quarantinedCandidateCount, 1);

	const entries = (await readFile(child.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	for (const entry of entries) {
		if (entry.customType === "agent-coordination.identity") entry.data.metadata = null;
	}
	await writeFile(child.path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	const damaged = await local.recover();
	assert.equal(damaged.quarantinedWorkflowAgentIds.has("a2"), true);
});

test("restart and compaction preserve source IDs while cancelled and removed Agents spend their allocations", async (t) => {
	const original = await dormantWorkflow(t);
	const first = await original.spawn("first");
	assert.equal(first.agentId, "a2");
	assert.equal(first.requestMessageId, "m1");
	const manager = original.host.session.sessionManager;
	const cancellation = { operation: "cancel" as const, requestMessageId: "m1", reason: "Work withdrawn." };
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", cancellation, { id: "cancel" }), { stopReason: "toolUse" }));
	await original.view.message("cancel", cancellation);
	const keep = manager.appendMessage({ role: "user", content: "Retained context", timestamp: Date.now() });
	manager.appendCompaction("Earlier work summarized.", keep, 1_000);
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	await original.host.dispose();
	await rename(first.path, `${first.path}.removed`);

	const reopened = await dormantWorkflow(t, {
		cwd: original.host.cwd, agentDir: original.host.services.agentDir, sessionFile,
	});
	assert.equal(reopened.identity.agentId, "a1");
	assert.equal(reopened.identity.workflowId, original.identity.workflowId);
	const source = resolveCommittedSpawnSource({
		agentId: reopened.identity.agentId,
		transcript: transcriptFromSessionManager(reopened.host.session.sessionManager).inspect(),
		toolCallId: "first",
	}).source;
	assert.equal(resolveMessageIdentity(source), "m1");
	assert.deepEqual((await reopened.recover()).agents, []);
	const next = await reopened.spawn("next");
	assert.equal(next.agentId, "a3");
	assert.equal(next.requestMessageId, "m3");
});

async function dormantWorkflow(t: TestContext, options: TestOwnerHostOptions = {}) {
	const host = await createUnboundTestOwnerHost(t, piAgentCoordination, { persistent: true, ...options });
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const coordinator = await createTestWorkflowCoordinator(host, identity, {
		entryModulePath: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
		spawnBoundaryHooks: { beforeRunStart: () => "confirmed_failure" },
	});
	const view = coordinator.forAgent(identity.agentId);
	return {
		host, identity, view,
		recover: () => discoverColdWorkflow({ ownerIdentity: identity, ownerSessionManager: host.session.sessionManager }),
		async spawn(toolCallId: string) {
			const input = { request: "Retain identity without starting work." };
			host.session.sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_spawn", input, { id: toolCallId }), { stopReason: "toolUse" }));
			const receipt = await view.spawn(toolCallId, input);
			assert.ok("agentId" in receipt);
			const path = view.status(receipt.agentId).primaryEvidence.transcriptPath;
			assert.ok(path);
			return { agentId: receipt.agentId, requestMessageId: receipt.requestMessageId, path };
		},
	};
}
