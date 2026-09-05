import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { RequestEvidence } from "../src/coordination/request-evidence.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { AgentTranscript } from "../src/transcript/agent-transcript.ts";

test("Creation Request lookup trusts loaded identity and creation input without Spawner reads", () => {
	const ownerSession = SessionManager.inMemory(process.cwd(), { id: "owner" });
	const owner = record("owner", ownerSession);
	const toolCallId = "spawn-worker";
	const entryId = ownerSession.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_spawn", { request: "Review the result." }, { id: toolCallId }),
		{ stopReason: "toolUse" },
	));
	const source = { agentId: "owner", entryId, toolCallId };
	const child = record("worker");
	child.identity = {
		agentId: "worker",
		workflowId: "owner",
		directSpawnerAgentId: "owner",
		spawnSource: source,
		metadata: { label: "Worker" },
	};
	child.creationInput = { request: "Review the result." };
	owner.transcript = new AgentTranscript({ read() { throw new Error("Spawner history must not be revalidated"); } });
	const unrelated = record("unrelated");
	unrelated.transcript = new AgentTranscript({
		read() {
			throw new Error("Creation Request resolution must not acquire unrelated history");
		},
	});
	const evidence = new RequestEvidence(new Map([
		[unrelated.identity.agentId, unrelated],
		[owner.identity.agentId, owner],
		[child.identity.agentId, child],
	]));
	const requestId = deriveMessageIdentity(source);

	assert.deepEqual(evidence.requireRequest(requestId), {
		kind: "request",
		origin: "agent_spawn",
		messageId: requestId,
		workflowId: "owner",
		fromAgentId: "owner",
		targetAgentId: "worker",
		deliveryMode: "deferred",
		source,
		question: "Review the result.",
	});
});

function record(
	agentId: string,
	manager = SessionManager.inMemory(process.cwd(), { id: agentId }),
): AgentRecord {
	manager.appendCustomEntry("agent-coordination.identity", { agentId });
	return {
		identity: {
			agentId,
			workflowId: "owner",
			directSpawnerAgentId: null,
			metadata: { label: "Owner", description: "Workflow Owner" },
		},
		host: {} as AgentRecord["host"],
		transcript: transcriptFromSessionManager(manager),
		children: [],
	};
}
