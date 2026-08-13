import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { resolveModeratorAgentMetadata } from "../src/protocol/agent-metadata.ts";
import { createModelVisibleModeratorInput } from "../src/protocol/moderator-input.ts";
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

test("new Agent transcript materialization persists only its creation Identity", async () => {
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
		metadata: { label: "materialized" },
	});

	const sessionFile = await materializeNewAgentTranscript(prepared);
	const reopened = SessionManager.open(sessionFile);

	assert.equal(reopened.getSessionId(), "agent-materialized");
	assert.equal(reopened.getEntries().length, 1);
	assert.equal(reopened.getEntries()[0]?.type, "custom");
	await assert.rejects(
		materializeNewAgentTranscript(prepared),
		/transcript already exists/,
	);
});

test("new Agent transcript header uses the first Runtime working directory without storing it in Identity", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-transcript-effective-cwd-"));
	const effectiveCwd = join(root, "child");
	const prepared = SessionManager.create(effectiveCwd, join(root, "sessions"), {
		id: "agent-effective-cwd",
	});
	prepared.appendCustomEntry("agent-coordination.identity", {
		agentId: "agent-effective-cwd",
		workflowId: "workflow-effective-cwd",
		directSpawnerAgentId: "parent-effective-cwd",
		spawnSource: {
			agentId: "parent-effective-cwd",
			entryId: "spawn-entry",
			toolCallId: "spawn-tool-call",
		},
		metadata: { label: "effective-cwd" },
	});

	const sessionFile = await materializeNewAgentTranscript(prepared);
	const reopened = SessionManager.open(sessionFile);
	assert.equal(reopened.getHeader()?.cwd, effectiveCwd);
	const identityEntry = reopened.getEntries()[0];
	assert.deepEqual(identityEntry?.type === "custom"
		? identityEntry.data
		: undefined, {
		agentId: "agent-effective-cwd",
		workflowId: "workflow-effective-cwd",
		directSpawnerAgentId: "parent-effective-cwd",
		spawnSource: {
			agentId: "parent-effective-cwd",
			entryId: "spawn-entry",
			toolCallId: "spawn-tool-call",
		},
		metadata: { label: "effective-cwd" },
	});
});

test("new Moderator transcript materialization validates its Input bootstrap", async () => {
	const root = await mkdtemp(join(tmpdir(), "moderator-transcript-materialize-"));
	const prepared = SessionManager.create(root, join(root, "sessions"), {
		id: "moderator-materialized",
	});
	const identity = {
		agentId: "moderator-materialized",
		workflowId: "workflow-materialized",
		directSpawnerAgentId: null,
		metadata: resolveModeratorAgentMetadata("operation_review"),
	} as const;
	const input = {
		trigger: {
			kind: "operation_review" as const,
			toolCall: {
				agentId: "reviewed-agent",
				entryId: "reviewed-entry",
				toolCallId: "reviewed-tool-call",
			},
			reviewIntervalMs: 1_000,
		},
		inspectedThrough: [{ agentId: "reviewed-agent", entryId: "reviewed-tail" }],
	};
	const modelInput = createModelVisibleModeratorInput(identity, input);
	prepared.appendCustomMessageEntry(
		modelInput.customType,
		modelInput.content,
		modelInput.display,
		modelInput.details,
	);

	const sessionFile = await materializeNewAgentTranscript(prepared);
	const reopened = SessionManager.open(sessionFile);
	assert.equal(reopened.getEntries().length, 1);
	assert.equal(reopened.getHeader()?.cwd, root);
});

test("transcript materialization rejects missing role bootstrap evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-transcript-invalid-bootstrap-"));
	const prepared = SessionManager.create(root, join(root, "sessions"), {
		id: "agent-invalid-bootstrap",
	});
	prepared.appendCustomEntry("agent-coordination.marker", { invalid: true });

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

test("file-backed transcript inspection preserves legacy and empty files byte-for-byte", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-transcript-read-only-"));
	for (const [name, body] of [
		["empty", ""],
		["legacy", `${JSON.stringify({
			type: "session",
			version: 1,
			id: "legacy-agent",
			timestamp: "2020-01-01T00:00:00.000Z",
			cwd: root,
		})}\n`],
	] as const) {
		const sessionFile = join(root, `${name}.jsonl`);
		await writeFile(sessionFile, body);
		const before = await readFile(sessionFile);

		transcriptFromSessionFile(sessionFile).inspect();

		assert.deepEqual(await readFile(sessionFile), before, name);
	}
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
