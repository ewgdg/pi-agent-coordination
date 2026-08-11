import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { commitAgentRuntimeBlueprint } from "../src/protocol/agent-runtime-blueprint.ts";
import {
	AgentTranscript,
	type TranscriptInspection,
	type TranscriptReader,
} from "../src/transcript/agent-transcript.ts";
import {
	materializeNewAgentTranscript,
	transcriptFromSessionFile,
	transcriptFromSessionManager,
} from "../src/pi-integration/session-manager-transcript.ts";

test("AgentTranscript asks its reader for a fresh inspection every time", () => {
	const inspections: TranscriptInspection[] = [
		inspection("agent-1", "entry-1"),
		inspection("agent-1", "entry-2"),
	];
	let reads = 0;
	const reader: TranscriptReader = {
		read() {
			return inspections[reads++]!;
		},
	};
	const transcript = new AgentTranscript(reader);

	assert.equal(transcript.inspect(), inspections[0]);
	assert.equal(transcript.inspect(), inspections[1]);
	assert.equal(reads, 2);
});

test("local SessionManager transcript inspections are snapshots, not a shared cache", () => {
	const sessionManager = SessionManager.inMemory("/workflow", { id: "agent-1" });
	sessionManager.appendCustomEntry("agent-coordination.identity", { agentId: "agent-1" });
	const transcript = transcriptFromSessionManager(sessionManager);

	const before = transcript.inspect();
	sessionManager.appendCustomEntry("agent-coordination.marker", { sequence: 2 });
	const after = transcript.inspect();

	assert.equal(before.sessionId, "agent-1");
	assert.equal(before.transcriptPath, null);
	assert.equal(before.header?.cwd, "/workflow");
	assert.equal(before.entries.length, 1);
	assert.equal(before.activeBranch.length, 1);
	assert.equal(after.entries.length, 2);
	assert.equal(after.activeBranch.length, 2);
	assert.notEqual(before, after);
	assert.notEqual(before.entries, after.entries);
	assert.notEqual(before.activeBranch, after.activeBranch);
});

test("new Agent transcript materialization commits pre-launch Identity evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-transcript-materialize-"));
	const prepared = SessionManager.create(root, join(root, "sessions"), {
		id: "agent-materialized",
	});
	prepared.appendCustomEntry("agent-coordination.identity", {
		agentId: "agent-materialized",
		workflowId: "workflow-materialized",
		directSpawnerAgentId: "parent-materialized",
		spawnSource: {
			agentId: "parent-materialized",
			entryId: "spawn-entry",
			toolCallId: "spawn-tool-call",
		},
		configuration: {
			label: "materialized",
			baseline: {
				cwd: root,
				model: { provider: "anthropic", modelId: "claude-test" },
				thinking: "off",
				tools: [],
				skills: [],
				extensions: [],
			},
		},
	});
	commitAgentRuntimeBlueprint(prepared, {
		agentId: "agent-materialized",
		role: "ordinary",
		configuration: {
			cwd: root,
			model: { provider: "anthropic", modelId: "claude-test" },
			thinking: "off",
			tools: ["agent_message"],
			skills: [],
			extensions: [],
		},
		projectTrusted: false,
		skillSources: [],
		agentsFiles: [],
	});

	const sessionFile = await materializeNewAgentTranscript(prepared);
	const reopened = SessionManager.open(sessionFile);

	assert.equal(reopened.getSessionId(), "agent-materialized");
	assert.equal(reopened.getEntries().length, 2);
	assert.equal(reopened.getEntries()[0]?.type, "custom");
	assert.equal(reopened.getEntries()[1]?.type, "custom");
	await assert.rejects(
		materializeNewAgentTranscript(prepared),
		/transcript already exists/,
	);
});

test("transcript materialization rejects a blueprint without its role bootstrap evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-transcript-invalid-bootstrap-"));
	const prepared = SessionManager.create(root, join(root, "sessions"), {
		id: "agent-invalid-bootstrap",
	});
	prepared.appendCustomEntry("agent-coordination.marker", { invalid: true });
	commitAgentRuntimeBlueprint(prepared, {
		agentId: "agent-invalid-bootstrap",
		role: "ordinary",
		configuration: {
			cwd: root,
			model: { provider: "anthropic", modelId: "claude-test" },
			thinking: "off",
			tools: ["agent_message"],
			skills: [],
			extensions: [],
		},
		projectTrusted: false,
		skillSources: [],
		agentsFiles: [],
	});

	await assert.rejects(
		materializeNewAgentTranscript(prepared),
		/ordinary Identity/,
	);
});

test("file-backed transcript inspections reopen durable evidence written by another authority", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-transcript-"));
	const writer = SessionManager.create(root, join(root, "sessions"), { id: "agent-file" });
	writer.appendCustomEntry("agent-coordination.identity", { agentId: "agent-file" });
	const sessionFile = writer.getSessionFile();
	assert.ok(sessionFile);
	const header = writer.getHeader();
	const [identity] = writer.getEntries();
	assert.ok(header);
	assert.ok(identity);
	await writeFile(
		sessionFile,
		`${[header, identity].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	const transcript = transcriptFromSessionFile(sessionFile);

	assert.equal(transcript.inspect().entries.length, 1);
	await appendFile(sessionFile, `${JSON.stringify({
		type: "custom",
		id: "remote2",
		parentId: identity.id,
		timestamp: "2026-01-01T00:00:01.000Z",
		customType: "agent-coordination.remote-marker",
		data: { sequence: 2 },
	})}\n`);
	const afterRemoteWrite = transcript.inspect();

	assert.equal(afterRemoteWrite.sessionId, "agent-file");
	assert.equal(afterRemoteWrite.transcriptPath, sessionFile);
	assert.equal(afterRemoteWrite.entries.length, 2);
	assert.equal(afterRemoteWrite.entries.at(-1)?.type, "custom");
});

function inspection(sessionId: string, entryId: string): TranscriptInspection {
	return {
		sessionId,
		transcriptPath: null,
		header: null,
		entries: [{
			type: "custom",
			id: entryId,
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "test",
		}],
		activeBranch: [],
		context: { messages: [], thinkingLevel: "off", model: null },
	};
}
